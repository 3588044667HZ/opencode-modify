import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { AgentMessageTable } from "@opencode-ai/core/session/sql"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Context, DateTime, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Session } from "./session"
import { rootOf } from "./tree"
import type { SessionID } from "./schema"

const DEFAULT_LIST_LIMIT = 50

export type Message = {
  id: string
  rootSessionID: SessionID
  fromSessionID: SessionID
  fromAgent?: string
  toSessionID: SessionID
  kind: string
  body: string
  hop: number
  replyTo?: string
  status: string
  timeCreated: number
}

export interface Interface {
  readonly record: (input: {
    id: string
    fromSessionID: SessionID
    fromAgent?: string
    toSessionID: SessionID
    kind: string
    body: string
    hop: number
    replyTo?: string
    status?: string
  }) => Effect.Effect<Message, Error>
  readonly list: (input: {
    sessionID: SessionID
    unreadOnly?: boolean
    limit?: number
  }) => Effect.Effect<Message[], Error>
  /** Hop of the most recent message delivered to this session, or 0. */
  readonly lastHop: (sessionID: SessionID) => Effect.Effect<number, Error>
  /** Atomically pulls queued messages for a session and marks them delivered. */
  readonly pullQueued: (sessionID: SessionID) => Effect.Effect<Message[], Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMailbox") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service

    const fromRow = (row: typeof AgentMessageTable.$inferSelect): Message => ({
      id: row.id,
      rootSessionID: row.root_session_id,
      fromSessionID: row.from_session_id,
      ...(row.from_agent === null ? {} : { fromAgent: row.from_agent }),
      toSessionID: row.to_session_id,
      kind: row.kind,
      body: row.body,
      hop: row.hop,
      ...(row.reply_to === null ? {} : { replyTo: row.reply_to }),
      status: row.status,
      timeCreated: row.time_created,
    })

    const record: Interface["record"] = Effect.fn("Mailbox.record")(function* (input) {
      const root = yield* rootOf(sessions, input.fromSessionID)
      const now = Date.now()
      const status = input.status ?? "delivered"
      yield* db
        .insert(AgentMessageTable)
        .values({
          id: input.id,
          root_session_id: root.id,
          from_session_id: input.fromSessionID,
          from_agent: input.fromAgent,
          to_session_id: input.toSessionID,
          kind: input.kind,
          body: input.body,
          hop: input.hop,
          reply_to: input.replyTo,
          status,
          time_created: now,
        })
        .run()
        .pipe(Effect.orDie)

      yield* events.publish(SessionEvent.AgentMessageSent, {
        timestamp: yield* DateTime.now,
        sessionID: root.id,
        messageID: input.id,
        from: input.fromSessionID,
        ...(input.fromAgent === undefined ? {} : { fromAgent: input.fromAgent }),
        to: input.toSessionID,
        kind: input.kind,
        hop: input.hop,
      })

      return {
        id: input.id,
        rootSessionID: root.id,
        fromSessionID: input.fromSessionID,
        ...(input.fromAgent === undefined ? {} : { fromAgent: input.fromAgent }),
        toSessionID: input.toSessionID,
        kind: input.kind,
        body: input.body,
        hop: input.hop,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        status,
        timeCreated: now,
      } satisfies Message
    })

    const list: Interface["list"] = Effect.fn("Mailbox.list")(function* (input) {
      const where = input.unreadOnly
        ? and(eq(AgentMessageTable.to_session_id, input.sessionID), eq(AgentMessageTable.status, "queued"))
        : eq(AgentMessageTable.to_session_id, input.sessionID)
      const rows = yield* db
        .select()
        .from(AgentMessageTable)
        .where(where)
        .orderBy(desc(AgentMessageTable.time_created))
        .limit(Math.max(1, Math.min(input.limit ?? DEFAULT_LIST_LIMIT, 500)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const pullQueued: Interface["pullQueued"] = Effect.fn("Mailbox.pullQueued")(function* (sessionID) {
      const rows = yield* db
        .select()
        .from(AgentMessageTable)
        .where(and(eq(AgentMessageTable.to_session_id, sessionID), eq(AgentMessageTable.status, "queued")))
        .orderBy(asc(AgentMessageTable.time_created), asc(AgentMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return []
      yield* db
        .update(AgentMessageTable)
        .set({ status: "delivered" })
        .where(
          and(
            eq(AgentMessageTable.to_session_id, sessionID),
            eq(AgentMessageTable.status, "queued"),
            inArray(
              AgentMessageTable.id,
              rows.map((row) => row.id),
            ),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ ...fromRow(row), status: "delivered" }))
    })

    const lastHop: Interface["lastHop"] = Effect.fn("Mailbox.lastHop")(function* (sessionID) {
      const row = yield* db
        .select({ hop: AgentMessageTable.hop })
        .from(AgentMessageTable)
        .where(eq(AgentMessageTable.to_session_id, sessionID))
        .orderBy(desc(AgentMessageTable.time_created), desc(AgentMessageTable.id))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row?.hop ?? 0
    })

    return Service.of({ record, list, lastHop, pullQueued })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Database.node, Session.node],
})

export * as Mailbox from "./mailbox"
