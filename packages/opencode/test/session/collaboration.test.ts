import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { BlackboardTable, AgentMessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Blackboard } from "@/session/blackboard"
import { Mailbox } from "@/session/mailbox"
import { SessionPeers } from "@/session/peers"
import { rootOf } from "@/session/tree"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Blackboard.node,
    Mailbox.node,
    Database.node,
    RuntimeFlags.node,
  ]),
)

const it = testEffect(layer)

const seed = Effect.fn("CollaborationTest.seed")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "root" })
  const child = yield* sessions.create({ parentID: root.id, title: "child" })
  const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
  return { root, child, grandchild }
})

describe("session.tree", () => {
  it.instance("rootOf walks to the tree root", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { root, child, grandchild } = yield* seed()
      expect((yield* rootOf(sessions, grandchild.id)).id).toBe(root.id)
      expect((yield* rootOf(sessions, child.id)).id).toBe(root.id)
      expect((yield* rootOf(sessions, root.id)).id).toBe(root.id)
    }),
  )
})

describe("session.blackboard", () => {
  it.instance("put/get/list/remove share state across a tree", () =>
    Effect.gen(function* () {
      const board = yield* Blackboard.Service
      const { root, child, grandchild } = yield* seed()
      const created = yield* board.put({ sessionID: child.id, key: "plan/step1", value: "hello", authorAgent: "coder" })
      expect(created.version).toBe(1)
      expect(created.rootSessionID).toBe(root.id)

      const got = yield* board.get({ sessionID: grandchild.id, key: "plan/step1" })
      expect(got?.value).toBe("hello")
      expect(got?.authorAgent).toBe("coder")

      const listed = yield* board.list({ sessionID: root.id })
      expect(listed.map((entry) => entry.key)).toEqual(["plan/step1"])

      yield* board.remove({ sessionID: child.id, key: "plan/step1" })
      expect(yield* board.get({ sessionID: root.id, key: "plan/step1" })).toBeUndefined()
    }),
  )

  it.instance("append adds a section and bumps the version", () =>
    Effect.gen(function* () {
      const board = yield* Blackboard.Service
      const { root } = yield* seed()
      yield* board.put({ sessionID: root.id, key: "log", value: "first", authorAgent: "a" })
      const appended = yield* board.put({ sessionID: root.id, key: "log", value: "second", mode: "append", authorAgent: "b" })
      expect(appended.version).toBe(2)
      expect(appended.value).toBe("first\n\n---\n[b]\nsecond")
    }),
  )

  it.instance("if_version enforces compare-and-swap", () =>
    Effect.gen(function* () {
      const board = yield* Blackboard.Service
      const { root } = yield* seed()
      yield* board.put({ sessionID: root.id, key: "k", value: "v1" })
      const exit = yield* board
        .put({ sessionID: root.id, key: "k", value: "v2", ifVersion: 99 })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const ok = yield* board.put({ sessionID: root.id, key: "k", value: "v2", ifVersion: 1 })
      expect(ok.version).toBe(2)
    }),
  )

  it.instance("isolates blackboards between separate session trees", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const board = yield* Blackboard.Service
      const a = yield* sessions.create({ title: "a" })
      const b = yield* sessions.create({ title: "b" })
      yield* board.put({ sessionID: a.id, key: "shared", value: "from-a" })
      expect(yield* board.get({ sessionID: b.id, key: "shared" })).toBeUndefined()
    }),
  )

  it.instance(
    "rejects values over the configured byte limit",
    () =>
      Effect.gen(function* () {
        const board = yield* Blackboard.Service
        const { root } = yield* seed()
        const exit = yield* board
          .put({ sessionID: root.id, key: "big", value: "x".repeat(300) })
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    { config: { blackboard: { max_value_bytes: 256 } } },
  )

  it.instance("removing the root session clears its blackboard and messages", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const board = yield* Blackboard.Service
      const mailbox = yield* Mailbox.Service
      const { db } = yield* Database.Service
      const { root, child } = yield* seed()
      yield* board.put({ sessionID: child.id, key: "k", value: "v" })
      yield* mailbox.record({
        id: "msg_test",
        fromSessionID: child.id,
        toSessionID: root.id,
        kind: "note",
        body: "hi",
        hop: 1,
      })

      yield* sessions.remove(root.id)

      const boardRows = yield* db.select().from(BlackboardTable).where(eq(BlackboardTable.root_session_id, root.id)).all()
      const messageRows = yield* db
        .select()
        .from(AgentMessageTable)
        .where(eq(AgentMessageTable.root_session_id, root.id))
        .all()
      expect(boardRows).toHaveLength(0)
      expect(messageRows).toHaveLength(0)
    }),
  )
})

describe("session.mailbox", () => {
  it.instance("records messages and reports the last hop", () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox.Service
      const { root, child } = yield* seed()
      yield* mailbox.record({
        id: "msg_1",
        fromSessionID: root.id,
        fromAgent: "lead",
        toSessionID: child.id,
        kind: "note",
        body: "first",
        hop: 1,
      })
      yield* mailbox.record({
        id: "msg_2",
        fromSessionID: root.id,
        toSessionID: child.id,
        kind: "note",
        body: "second",
        hop: 3,
      })

      const messages = yield* mailbox.list({ sessionID: child.id })
      expect(messages).toHaveLength(2)
      expect(messages[0]?.body).toBe("second")
      expect(yield* mailbox.lastHop(child.id)).toBe(3)
      expect(yield* mailbox.lastHop(root.id)).toBe(0)
    }),
  )

  it.instance("pullQueued atomically promotes queued messages", () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox.Service
      const { root, child } = yield* seed()
      yield* mailbox.record({
        id: "msg_q1",
        fromSessionID: root.id,
        toSessionID: child.id,
        kind: "note",
        body: "queued",
        hop: 1,
        status: "queued",
      })
      yield* mailbox.record({
        id: "msg_q2",
        fromSessionID: root.id,
        toSessionID: child.id,
        kind: "note",
        body: "delivered",
        hop: 2,
      })

      expect(yield* mailbox.list({ sessionID: child.id, unreadOnly: true })).toHaveLength(1)
      const pulled = yield* mailbox.pullQueued(child.id)
      expect(pulled.map((message) => message.id)).toEqual(["msg_q1"])
      expect(yield* mailbox.list({ sessionID: child.id, unreadOnly: true })).toHaveLength(0)
      expect((yield* mailbox.list({ sessionID: child.id })).find((m) => m.id === "msg_q1")?.status).toBe("delivered")
    }),
  )
})

describe("session.peers", () => {
  it.instance("flushes queued peer messages into the last user turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const mailbox = yield* Mailbox.Service
      const { root, child } = yield* seed()
      yield* mailbox.record({
        id: "msg_peer",
        fromSessionID: root.id,
        fromAgent: "lead",
        toSessionID: child.id,
        kind: "note",
        body: "please review",
        hop: 2,
        status: "queued",
      })

      const user = {
        id: MessageID.ascending(),
        role: "user" as const,
        sessionID: child.id,
        agent: "general",
        model: { providerID: "test", modelID: "test-model" },
        time: { created: Date.now() },
      }
      const messages = [{ info: user, parts: [] as SessionV1.Part[] }] as SessionV1.WithParts[]
      const session = yield* sessions.get(child.id)
      const result = yield* SessionPeers.apply({ messages, session }).pipe(
        Effect.provideService(Mailbox.Service, mailbox),
      )

      const peerPart = result[0]?.parts.find((part) => part.type === "text" && part.synthetic === true)
      expect(peerPart).toBeDefined()
      if (peerPart?.type === "text") {
        expect(peerPart.text).toContain("please review")
        expect(peerPart.metadata?.peer?.hop).toBe(2)
      }
      expect(yield* mailbox.list({ sessionID: child.id, unreadOnly: true })).toHaveLength(0)
    }),
  )
})
