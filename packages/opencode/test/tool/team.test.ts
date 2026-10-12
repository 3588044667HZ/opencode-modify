import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Fiber, Layer } from "effect"
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
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"

import { DispatchTool } from "../../src/tool/dispatch"
import { TeamTool } from "../../src/tool/team"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
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
      Permission.node,
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

const seed = Effect.fn("TeamToolTest.seed")(function* (title = "Lead") {
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

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.succeed(reply(input, "done")),
  }
}

function context(input: {
  chat: Session.Info
  assistant: SessionV1.Assistant
  ask?: () => Effect.Effect<void>
}) {
  return {
    sessionID: input.chat.id,
    messageID: input.assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: stubOps() },
    messages: [],
    metadata: () => Effect.void,
    ask: input.ask ?? (() => Effect.void),
  }
}

const tasks = [
  { agent: "general", description: "first task", prompt: "do first" },
  { agent: "general", description: "second task", prompt: "do second" },
  { agent: "general", description: "third task", prompt: "do third" },
]

function appendUserMessage(sessionID: Session.Info["id"]) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      role: "user",
      sessionID,
      agent: "general",
      model: ref,
      time: { created: Date.now() },
    })
    return id
  })
}

describe("tool.team", () => {
  it.instance("status lists dispatched members with state, activity, quiet and tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const dispatch = yield* DispatchTool
      const dispatchDef = yield* dispatch.init()
      yield* dispatchDef.execute({ tasks }, context({ chat, assistant }))

      const kids = yield* sessions.children(chat.id)
      const target = kids[0]!
      const messageID = yield* appendUserMessage(target.id)
      const createdAt = Date.now() - 30_000
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: target.id,
        messageID,
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: target.id,
        messageID,
        type: "text",
        text: "working on it",
        time: { start: createdAt, end: createdAt },
      })

      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute({ op: "status" }, context({ chat, assistant }))

      expect(result.output).toContain(`<team_status members="3"`)
      const line = result.output.split("\n").find((entry) => entry.startsWith(target.id))!
      expect(line).toContain("agent=general")
      expect(line).toContain('name="first task"')
      expect(line).toContain("state=completed")
      expect(line).toContain("activity=text")
      expect(line).toMatch(/quiet=\d+[smh]/)
      expect(line).toContain("tokens=30")
      expect(line).toMatch(/elapsed=\d+[smh]/)
    }),
  )

  it.instance("status does not ask for permission", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { op: "status" },
        context({ chat, assistant, ask: () => Effect.die(new Error("status must not ask")) }),
      )
      expect(result.output).toContain("<team_status")
    }),
  )

  it.instance("status reports members waiting on a permission ask", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const permissions = yield* Permission.Service
      const { chat, assistant } = yield* seed()
      const dispatch = yield* DispatchTool
      const dispatchDef = yield* dispatch.init()
      yield* dispatchDef.execute({ tasks }, context({ chat, assistant }))

      const target = (yield* sessions.children(chat.id))[0]!
      const fiber = yield* permissions
        .ask({
          sessionID: target.id,
          permission: "external_directory",
          patterns: ["/tmp/*"],
          metadata: {},
          always: ["*"],
          ruleset: [],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const pending = yield* permissions.list()
          return pending.some((request) => request.sessionID === target.id) ? true : undefined
        }),
        "permission ask was not registered",
      )

      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute({ op: "status" }, context({ chat, assistant }))

      expect(result.output).toContain('waiting_permission="1"')
      const line = result.output.split("\n").find((entry) => entry.startsWith(target.id))!
      expect(line).toContain("waiting_permission=1")

      yield* Fiber.interrupt(fiber)
    }),
  )

  it.instance("status adds a detail block for a descendant session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const dispatch = yield* DispatchTool
      const dispatchDef = yield* dispatch.init()
      yield* dispatchDef.execute({ tasks: [tasks[0]!] }, context({ chat, assistant }))

      const target = (yield* sessions.children(chat.id))[0]!
      const messageID = yield* appendUserMessage(target.id)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: target.id,
        messageID,
        type: "text",
        text: "the last words",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: target.id,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "running", input: {}, time: { start: Date.now() } },
      })

      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { op: "status", session_id: target.id },
        context({ chat, assistant }),
      )

      expect(result.output).toContain(`<team_member id="${target.id}">`)
      expect(result.output).toContain("<last_text>the last words</last_text>")
      expect(result.output).toContain('<last_tool name="bash" state="running" />')
      const line = result.output.split("\n").find((entry) => entry.startsWith(target.id))!
      expect(line).toContain("activity=tool:bash")
    }),
  )

  it.instance("status rejects a session_id outside the caller subtree", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const orphan = yield* sessions.create({ title: "orphan" })
      const tool = yield* TeamTool
      const def = yield* tool.init()
      const exit = yield* def.execute({ op: "status", session_id: orphan.id }, context({ chat, assistant })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("status truncates output beyond the byte cap", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      for (let index = 0; index < 6; index++) {
        yield* sessions.create({ parentID: chat.id, title: "n".repeat(600) })
      }
      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute({ op: "status" }, context({ chat, assistant }))

      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(2048)
      expect(result.output.endsWith("<!-- truncated -->")).toBe(true)
    }),
  )

  it.instance("stop cancels a single running member job", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const dispatch = yield* DispatchTool
      const dispatchDef = yield* dispatch.init()
      const gatedOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: () => Effect.never,
      }

      yield* dispatchDef.execute(
        { tasks: [tasks[0]!], mode: "background" },
        { ...context({ chat, assistant }), extra: { promptOps: gatedOps } },
      )
      const target = (yield* sessions.children(chat.id))[0]!
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const job = yield* jobs.get(target.id)
          return job?.status === "running" ? true : undefined
        }),
        "member job never started",
      )

      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute({ op: "stop", session_id: target.id }, context({ chat, assistant }))

      expect(result.output).toContain('<team_stop stopped="1" failed="0">')
      expect(result.output).toContain(`${target.id} stopped`)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const job = yield* jobs.get(target.id)
          return job?.status === "cancelled" ? true : undefined
        }),
        "member job was not cancelled",
      )
    }),
  )

  it.instance("stop all cancels every descendant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const dispatch = yield* DispatchTool
      const dispatchDef = yield* dispatch.init()
      const gatedOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: () => Effect.never,
      }

      yield* dispatchDef.execute(
        { tasks: tasks.slice(0, 2), mode: "background" },
        { ...context({ chat, assistant }), extra: { promptOps: gatedOps } },
      )
      const kids = yield* sessions.children(chat.id)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const running = yield* Effect.forEach(kids, (kid) => jobs.get(kid.id))
          return running.every((job) => job?.status === "running") ? true : undefined
        }),
        "member jobs never started",
      )

      const tool = yield* TeamTool
      const def = yield* tool.init()
      const result = yield* def.execute({ op: "stop", all: true }, context({ chat, assistant }))

      expect(result.output).toContain('<team_stop stopped="2" failed="0">')
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const running = yield* Effect.forEach(kids, (kid) => jobs.get(kid.id))
          return running.every((job) => job?.status === "cancelled") ? true : undefined
        }),
        "member jobs were not all cancelled",
      )
    }),
  )

  it.instance("stop rejects a target that is not a descendant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const orphan = yield* sessions.create({ title: "orphan" })
      const tool = yield* TeamTool
      const def = yield* tool.init()

      const result = yield* def.execute({ op: "stop", session_id: orphan.id }, context({ chat, assistant }))

      expect(result.output).toContain('<team_stop stopped="0" failed="1">')
      expect(result.output).toContain(`${orphan.id} failed reason="not a descendant of this session"`)
    }),
  )

  it.instance("stop requires exactly one of session_id or all", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TeamTool
      const def = yield* tool.init()

      const neither = yield* def.execute({ op: "stop" }, context({ chat, assistant })).pipe(Effect.exit)
      expect(Exit.isFailure(neither)).toBe(true)

      const both = yield* def
        .execute({ op: "stop", session_id: "ses_x", all: true }, context({ chat, assistant }))
        .pipe(Effect.exit)
      expect(Exit.isFailure(both)).toBe(true)
    }),
  )
})
