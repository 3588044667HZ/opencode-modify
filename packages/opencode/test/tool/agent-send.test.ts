import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Mailbox } from "@/session/mailbox"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID } from "@/session/schema"
import { Agent } from "../../src/agent/agent"
import { AgentSendTool } from "../../src/tool/agent-send"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "../../src/tool/task"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Mailbox.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer({ experimentalAgentTeams: true }))

function stubOps(onPrompt?: (input: any) => void): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        onPrompt?.(input)
        return {
          info: { role: "assistant" as const },
          parts: [],
        } as any
      }),
  }
}

function context(sessionID: string, promptOps: TaskPromptOps) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "coder",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } as any
}

describe("tool.agent_send", () => {
  const delivered = (seen: any[], count: number) =>
    pollWithTimeout(
      Effect.sync(() => (seen.length >= count ? seen : undefined)),
      "peer message was not delivered",
    )

  it.instance("delivers to parent, root, and siblings within the tree", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* AgentSendTool
      const def = yield* tool.init()
      const root = yield* sessions.create({ title: "root" })
      const a = yield* sessions.create({ parentID: root.id, title: "a" })
      const b = yield* sessions.create({ parentID: root.id, title: "b" })
      const seen: any[] = []

      yield* def.execute({ to: "parent", message: "hi root" }, context(a.id, stubOps((input) => seen.push(input))))
      yield* delivered(seen, 1)
      expect(seen[0].sessionID).toBe(root.id)
      expect(seen[0].parts[0].synthetic).toBe(true)
      expect(seen[0].parts[0].metadata.peer.hop).toBe(1)
      expect(seen[0].parts[0].metadata.peer.fromAgent).toBe("coder")
      expect(seen[0].parts[0].text).toContain("[peer-message")
      expect(seen[0].parts[0].text).toContain("hi root")

      yield* def.execute({ to: b.id, message: "hi sibling" }, context(a.id, stubOps((input) => seen.push(input))))
      yield* delivered(seen, 2)
      expect(seen[1].sessionID).toBe(b.id)

      yield* def.execute({ to: "root", message: "hi root" }, context(a.id, stubOps((input) => seen.push(input))))
      yield* delivered(seen, 3)
      expect(seen[2].sessionID).toBe(root.id)
    }),
  )

  it.instance("returns without waiting for a blocked target turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* AgentSendTool
      const def = yield* tool.init()
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id, title: "child" })
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: () => Effect.never,
      }

      const result = yield* awaitWithTimeout(
        def.execute({ to: "root", message: "blocked?" }, context(child.id, promptOps)),
        "agent_send waited for the target turn",
        "2 seconds",
      )

      expect(result.output).toContain("Delivered")
    }),
  )

  it.instance("rejects sending to the session itself", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* AgentSendTool
      const def = yield* tool.init()
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id, title: "child" })

      const exit = yield* def
        .execute({ to: child.id, message: "self" }, context(child.id, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects a target outside the session tree", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* AgentSendTool
      const def = yield* tool.init()
      const rootA = yield* sessions.create({ title: "a" })
      const childA = yield* sessions.create({ parentID: rootA.id, title: "child-a" })
      const rootB = yield* sessions.create({ title: "b" })
      const childB = yield* sessions.create({ parentID: rootB.id, title: "child-b" })

      const exit = yield* def
        .execute({ to: childB.id, message: "cross tree" }, context(childA.id, stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance(
    "rejects messages past the hop limit",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const mailbox = yield* Mailbox.Service
        const tool = yield* AgentSendTool
        const def = yield* tool.init()
        const root = yield* sessions.create({ title: "root" })
        const child = yield* sessions.create({ parentID: root.id, title: "child" })
        yield* mailbox.record({
          id: "msg_prev",
          fromSessionID: root.id,
          toSessionID: child.id,
          kind: "note",
          body: "previous",
          hop: 1,
        })

        const exit = yield* def
          .execute({ to: "parent", message: "again" }, context(child.id, stubOps()))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { agent_message: { max_hop: 1 } } },
  )

  it.instance(
    "rejects messages over the body limit",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const tool = yield* AgentSendTool
        const def = yield* tool.init()
        const root = yield* sessions.create({ title: "root" })
        const child = yield* sessions.create({ parentID: root.id, title: "child" })
        const exit = yield* def
          .execute({ to: "parent", message: "x".repeat(300) }, context(child.id, stubOps()))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { agent_message: { max_body_bytes: 256 } } },
  )

  it.instance(
    "enforces the per-minute rate limit",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const tool = yield* AgentSendTool
        const def = yield* tool.init()
        const root = yield* sessions.create({ title: "root" })
        const child = yield* sessions.create({ parentID: root.id, title: "child" })
        const ops = stubOps()
        yield* def.execute({ to: "parent", message: "one" }, context(child.id, ops))
        const exit = yield* def.execute({ to: "parent", message: "two" }, context(child.id, ops)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { agent_message: { max_per_minute: 1 } } },
  )

  it.instance(
    "queues to an idle target when wake_idle is disabled",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const mailbox = yield* Mailbox.Service
        const tool = yield* AgentSendTool
        const def = yield* tool.init()
        const root = yield* sessions.create({ title: "root" })
        const child = yield* sessions.create({ parentID: root.id, title: "child" })
        let prompted = 0

        const result = yield* def.execute(
          { to: "root", message: "later" },
          context(
            child.id,
            stubOps(() => {
              prompted++
            }),
          ),
        )

        expect(result.metadata.queued).toBe(true)
        expect(prompted).toBe(0)
        const queued = yield* mailbox.list({ sessionID: root.id, unreadOnly: true })
        expect(queued).toHaveLength(1)
        expect(queued[0]?.body).toBe("later")
      }),
    { config: { agent_message: { wake_idle: false } } },
  )
})
