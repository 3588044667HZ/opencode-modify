import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"

import { DispatchTool } from "../../src/tool/dispatch"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { FSUtil } from "@opencode-ai/core/fs-util"
import os from "os"
import path from "path"

afterEach(async () => {
  await disposeAllInstances()
})

const autonomyExternal = path.join(path.parse(os.homedir()).root, "opencode-autonomy-external")

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const variantProvider = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
          variants: { low: {}, high: {}, max: {} },
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Provider.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer({ experimentalAgentTeams: true }))

const seed = Effect.fn("DispatchToolTest.seed")(function* (title = "Lead") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

function stubOps(opts?: { text?: (input: SessionPrompt.PromptInput) => string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.succeed(reply(input, opts?.text?.(input) ?? "done")),
  }
}

function context(input: {
  chat: Session.Info
  assistant: SessionV1.Assistant
  promptOps: TaskPromptOps
  abort?: AbortSignal
}) {
  return {
    sessionID: input.chat.id,
    messageID: input.assistant.id,
    agent: "build",
    abort: input.abort ?? new AbortController().signal,
    extra: { promptOps: input.promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const tasks = [
  { agent: "general", description: "first task", prompt: "do first" },
  { agent: "general", description: "second task", prompt: "do second" },
  { agent: "general", description: "third task", prompt: "do third" },
]

describe("tool.dispatch", () => {
  it.instance("join runs members in parallel and aggregates their session IDs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { tasks },
        context({ chat, assistant, promptOps: stubOps({ text: (input) => `done ${input.sessionID}` }) }),
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(3)
      expect(result.output).toContain(`state="completed"`)
      for (const kid of kids) expect(result.output).toContain(`id="${kid.id}"`)
      expect(result.metadata.members).toHaveLength(3)
    }),
  )

  it.instance("joins with concurrency clamping and unchanged member sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { tasks, concurrency: 99 },
        context({ chat, assistant, promptOps: stubOps() }),
      )

      expect((yield* sessions.children(chat.id))).toHaveLength(3)
      expect(result.output).toContain(`state="completed"`)
    }),
  )

  it.instance("marks the team partial when a member fails", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()
      let seen = 0

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          seen++
          if (seen === 1) return Effect.die(new Error("boom"))
          return Effect.succeed(reply(input, "ok"))
        },
      }

      const result = yield* def.execute({ tasks }, context({ chat, assistant, promptOps }))

      expect(result.output).toContain(`state="partial"`)
      expect(result.output).toContain("task_error")
    }),
  )

  it.instance("rejects dispatch from a subagent at the depth limit", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { tasks },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance("rejects primary agents as team members", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { tasks: [{ agent: "build", description: "primary", prompt: "nope" }] },
          context({ chat, assistant, promptOps: stubOps() }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("resolves a named team from config", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const result = yield* def.execute({ team: "alpha" }, context({ chat, assistant, promptOps: stubOps() }))

      expect((yield* sessions.children(chat.id))).toHaveLength(2)
      expect(result.output).toContain(`state="completed"`)
    }),
    {
      config: {
        team: {
          alpha: {
            description: "Alpha team",
            members: [{ agent: "general", role: "implementer" }, { agent: "explore" }],
          },
        },
      },
    },
  )

  it.instance("lists configured team rosters in the dispatch description", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const build = yield* agents.get("build")

      const tools = yield* registry.tools({ ...ref, agent: build })
      const description = tools.find((tool) => tool.id === DispatchTool.id)?.description ?? ""

      expect(description).toContain("Available team rosters")
      expect(description).toContain("- alpha: Alpha team (2 members)")
      expect(description).toContain("- beta: No description (1 member)")
      expect(description.indexOf("- alpha:")).toBeLessThan(description.indexOf("- beta:"))
    }),
    {
      config: {
        team: {
          alpha: { description: "Alpha team", members: [{ agent: "general" }, { agent: "explore" }] },
          beta: { members: [{ agent: "general" }] },
        },
      },
    },
  )

  it.instance("notes when no rosters are configured", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const build = yield* agents.get("build")

      const tools = yield* registry.tools({ ...ref, agent: build })
      const description = tools.find((tool) => tool.id === DispatchTool.id)?.description ?? ""

      expect(description).toContain("No team rosters are configured")
    }),
  )

  it.instance("background mode returns immediately and notifies per member", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { tasks, mode: "background" },
        context({ chat, assistant, promptOps: stubOps({ text: (input) => `done ${input.sessionID}` }) }),
      )

      expect(result.output).toContain(`state="running"`)
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(3)
      for (const kid of kids) {
        const waited = yield* jobs.wait({ id: kid.id, timeout: 1_000 })
        expect(waited.info?.status).toBe("completed")
      }
    }),
  )

  it.instance("resumes an existing member session via task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const existing = yield* sessions.create({ parentID: chat.id, title: "existing" })
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { tasks: [{ agent: "general", description: "resume", prompt: "continue", task_id: existing.id }] },
        context({ chat, assistant, promptOps: stubOps() }),
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(existing.id)
      expect(result.output).toContain(`id="${existing.id}"`)
      expect(result.output).toContain(`tokens="`)
    }),
  )

  it.instance("rejects an unknown task_id", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { tasks: [{ agent: "general", description: "resume", prompt: "continue", task_id: "ses_missing_xyz" }] },
          context({ chat, assistant, promptOps: stubOps() }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance(
    "forwards an explicit member variant to the member prompt",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* DispatchTool
        const def = yield* tool.init()
        const seen: SessionPrompt.PromptInput[] = []
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              seen.push(input)
              return reply(input, "done")
            }),
        }

        const result = yield* def.execute(
          { tasks: [{ agent: "general", description: "first task", prompt: "do first", variant: "high" }] },
          context({ chat, assistant, promptOps }),
        )

        expect(seen).toHaveLength(1)
        expect(seen[0]?.variant).toBe("high")
        expect(result.metadata.members[0]?.variant).toBe("high")
        expect(result.metadata.members[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
      }),
    { config: variantProvider },
  )

  it.instance(
    "still inherits the lead variant when no member variant is given",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* DispatchTool
        const def = yield* tool.init()
        const seen: SessionPrompt.PromptInput[] = []
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              seen.push(input)
              return reply(input, "done")
            }),
        }

        yield* def.execute({ tasks }, context({ chat, assistant, promptOps }))

        expect(seen).toHaveLength(3)
        for (const input of seen) expect(input.variant).toBe("xhigh")
      }),
  )

  it.instance(
    "rejects an unknown member variant before creating member sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* DispatchTool
        const def = yield* tool.init()

        const exit = yield* def
          .execute(
            { tasks: [{ agent: "general", description: "first task", prompt: "do first", variant: "turbo" }] },
            context({ chat, assistant, promptOps: stubOps() }),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("expected failure")
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(Error)
        if (failure instanceof Error) {
          expect(failure.message).toContain('Unknown variant "turbo"')
          expect(failure.message).toContain("low, high, max")
        }
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { config: variantProvider },
  )

  it.instance(
    "applies variant overrides from a team roster",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* DispatchTool
        const def = yield* tool.init()
        const seen: SessionPrompt.PromptInput[] = []
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              seen.push(input)
              return reply(input, "done")
            }),
        }

        yield* def.execute({ team: "alpha" }, context({ chat, assistant, promptOps }))

        expect(seen).toHaveLength(2)
        expect(seen.find((input) => input.agent === "general")?.variant).toBe("high")
        expect(seen.find((input) => input.agent === "explore")?.variant).toBe("xhigh")
      }),
    {
      config: {
        ...variantProvider,
        team: {
          alpha: {
            description: "Alpha team",
            members: [
              { agent: "general", role: "implementer", variant: "high" },
              { agent: "explore" },
            ],
          },
        },
      },
    },
  )

  it.instance("grants a member autonomy and records it in metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { tasks: [{ agent: "general", description: "grant", prompt: "do", autonomy: [autonomyExternal] }] },
        context({ chat, assistant, promptOps: stubOps() }),
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.permission).toContainEqual({
        permission: "external_directory",
        pattern: FSUtil.normalizePathPattern(path.join(autonomyExternal, "*")),
        action: "allow",
      })
      expect(result.metadata.members[0]?.autonomy).toEqual([autonomyExternal])
    }),
  )

  it.instance("rejects a high-risk autonomy grant before creating any member session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { tasks: [{ agent: "general", description: "grant", prompt: "do", autonomy: [os.homedir()] }] },
          context({ chat, assistant, promptOps: stubOps() }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("appends autonomy grants when resuming a member session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const existing = yield* sessions.create({ parentID: chat.id, title: "existing" })
      const tool = yield* DispatchTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          tasks: [
            { agent: "general", description: "resume", prompt: "continue", task_id: existing.id, autonomy: [autonomyExternal] },
          ],
        },
        context({ chat, assistant, promptOps: stubOps() }),
      )

      const session = yield* sessions.get(existing.id)
      expect(session.permission).toContainEqual({
        permission: "external_directory",
        pattern: FSUtil.normalizePathPattern(path.join(autonomyExternal, "*")),
        action: "allow",
      })
    }),
  )

  it.instance('forwards variant "default" as no override', () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()
      const seen: SessionPrompt.PromptInput[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return reply(input, "done")
          }),
      }

      yield* def.execute(
        { tasks: [{ agent: "general", description: "first task", prompt: "do first", variant: "default" }] },
        context({ chat, assistant, promptOps }),
      )

      expect(seen).toHaveLength(1)
      expect(seen[0]?.variant).toBeUndefined()
    }),
  )

  it.instance("caps concurrently running members at concurrency", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* DispatchTool
      const def = yield* tool.init()
      const state = yield* Ref.make({ active: 0, started: 0, max: 0 })
      const release = yield* Deferred.make<void>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(state, (s) => ({
              active: s.active + 1,
              started: s.started + 1,
              max: Math.max(s.max, s.active + 1),
            }))
            yield* Deferred.await(release)
            yield* Ref.update(state, (s) => ({ ...s, active: s.active - 1 }))
            return reply(input, "done")
          }),
      }

      const fiber = yield* def
        .execute({ tasks, concurrency: 2 }, context({ chat, assistant, promptOps }))
        .pipe(Effect.forkChild)

      const blocked = yield* pollWithTimeout(
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(state)
          return snapshot.active === 2 ? snapshot : undefined
        }),
        "members did not reach the concurrency cap",
      )
      expect(blocked.started).toBe(2)

      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      const final = yield* Ref.get(state)
      expect(final.started).toBe(3)
      expect(final.max).toBe(2)
      expect(result.output).toContain(`state="completed"`)
    }),
  )

  it.instance("delivers a resume prompt into a running member job", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const existing = yield* sessions.create({ parentID: chat.id, title: "existing" })
      const tool = yield* DispatchTool
      const def = yield* tool.init()
      const gate = yield* Deferred.make<void>()
      const prompts: string[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const text = input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
            prompts.push(text)
            if (text.includes("first run")) yield* Deferred.await(gate)
            return reply(input, "done")
          }),
      }

      yield* def.execute(
        {
          tasks: [{ agent: "general", description: "first", prompt: "first run", task_id: existing.id }],
          mode: "background",
        },
        context({ chat, assistant, promptOps }),
      )
      yield* pollWithTimeout(
        Effect.sync(() => (prompts.length >= 1 ? true : undefined)),
        "first member run did not start",
      )

      yield* def.execute(
        {
          tasks: [{ agent: "general", description: "resume", prompt: "follow up", task_id: existing.id }],
          mode: "background",
        },
        context({ chat, assistant, promptOps }),
      )

      yield* Deferred.succeed(gate, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => (prompts.some((text) => text.includes("follow up")) ? true : undefined)),
        "resume prompt was not delivered",
      )

      const waited = yield* jobs.wait({ id: existing.id, timeout: 2_000 })
      expect(waited.info?.status).toBe("completed")
    }),
  )
})
