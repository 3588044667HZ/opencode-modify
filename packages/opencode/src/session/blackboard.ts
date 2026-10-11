import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { BlackboardTable } from "@opencode-ai/core/session/sql"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Context, DateTime, Effect, Layer } from "effect"
import { and, asc, eq, like } from "drizzle-orm"
import { Session } from "./session"
import { rootOf } from "./tree"
import type { SessionID } from "./schema"

const DEFAULT_MAX_VALUE_BYTES = 65536
const DEFAULT_MAX_KEYS = 256

export type Entry = {
  rootSessionID: SessionID
  key: string
  value: string
  authorSessionID?: SessionID
  authorAgent?: string
  version: number
  timeCreated: number
  timeUpdated: number
}

export interface Interface {
  readonly put: (input: {
    sessionID: SessionID
    key: string
    value: string
    mode?: "set" | "append"
    ifVersion?: number
    authorSessionID?: SessionID
    authorAgent?: string
  }) => Effect.Effect<Entry, Error>
  readonly get: (input: { sessionID: SessionID; key: string }) => Effect.Effect<Entry | undefined, Error>
  readonly list: (input: { sessionID: SessionID; prefix?: string }) => Effect.Effect<Entry[], Error>
  readonly remove: (input: { sessionID: SessionID; key: string }) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionBlackboard") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service

    const fromRow = (row: typeof BlackboardTable.$inferSelect): Entry => ({
      rootSessionID: row.root_session_id,
      key: row.key,
      value: row.value,
      ...(row.author_session_id === null ? {} : { authorSessionID: row.author_session_id }),
      ...(row.author_agent === null ? {} : { authorAgent: row.author_agent }),
      version: row.version,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    })

    const getRow = Effect.fnUntraced(function* (rootSessionID: SessionID, key: string) {
      return yield* db
        .select()
        .from(BlackboardTable)
        .where(and(eq(BlackboardTable.root_session_id, rootSessionID), eq(BlackboardTable.key, key)))
        .get()
        .pipe(Effect.orDie)
    })

    const publish = Effect.fnUntraced(function* (input: {
      rootSessionID: SessionID
      key: string
      version: number
      authorSessionID?: SessionID
      authorAgent?: string
    }) {
      yield* events.publish(SessionEvent.BlackboardChanged, {
        timestamp: yield* DateTime.now,
        sessionID: input.rootSessionID,
        key: input.key,
        version: input.version,
        ...(input.authorSessionID === undefined ? {} : { authorSessionID: input.authorSessionID }),
        ...(input.authorAgent === undefined ? {} : { authorAgent: input.authorAgent }),
      })
    })

    const put: Interface["put"] = Effect.fn("Blackboard.put")(function* (input) {
      const cfg = yield* config.get()
      const maxValueBytes = cfg.blackboard?.max_value_bytes ?? DEFAULT_MAX_VALUE_BYTES
      const maxKeys = cfg.blackboard?.max_keys ?? DEFAULT_MAX_KEYS
      const root = yield* rootOf(sessions, input.sessionID)
      if (!input.key) return yield* Effect.fail(new Error("Blackboard key is required"))
      if (Buffer.byteLength(input.value, "utf8") > maxValueBytes)
        return yield* Effect.fail(new Error(`Blackboard value exceeds ${maxValueBytes} bytes`))

      const existing = yield* getRow(root.id, input.key)
      if (input.ifVersion !== undefined && (existing?.version ?? 0) !== input.ifVersion)
        return yield* Effect.fail(
          new Error(`Blackboard version conflict for "${input.key}": expected ${input.ifVersion}`),
        )

      const author = input.authorAgent ?? input.authorSessionID ?? "unknown"
      const value =
        input.mode === "append" && existing
          ? `${existing.value}\n\n---\n[${author}]\n${input.value}`
          : input.value
      if (Buffer.byteLength(value, "utf8") > maxValueBytes)
        return yield* Effect.fail(new Error(`Blackboard value exceeds ${maxValueBytes} bytes`))

      if (!existing) {
        const keys = yield* db
          .select({ key: BlackboardTable.key })
          .from(BlackboardTable)
          .where(eq(BlackboardTable.root_session_id, root.id))
          .all()
          .pipe(Effect.orDie)
        if (keys.length >= maxKeys)
          return yield* Effect.fail(new Error(`Blackboard key limit reached (${maxKeys})`))
      }

      const version = (existing?.version ?? 0) + 1
      const now = Date.now()
      yield* db
        .insert(BlackboardTable)
        .values({
          root_session_id: root.id,
          key: input.key,
          value,
          author_session_id: input.authorSessionID,
          author_agent: input.authorAgent,
          version,
          time_created: existing?.time_created ?? now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: [BlackboardTable.root_session_id, BlackboardTable.key],
          set: {
            value,
            author_session_id: input.authorSessionID,
            author_agent: input.authorAgent,
            version,
            time_updated: now,
          },
        })
        .run()
        .pipe(Effect.orDie)

      yield* publish({
        rootSessionID: root.id,
        key: input.key,
        version,
        authorSessionID: input.authorSessionID,
        authorAgent: input.authorAgent,
      })

      return {
        rootSessionID: root.id,
        key: input.key,
        value,
        ...(input.authorSessionID === undefined ? {} : { authorSessionID: input.authorSessionID }),
        ...(input.authorAgent === undefined ? {} : { authorAgent: input.authorAgent }),
        version,
        timeCreated: existing?.time_created ?? now,
        timeUpdated: now,
      } satisfies Entry
    })

    const get: Interface["get"] = Effect.fn("Blackboard.get")(function* (input) {
      const root = yield* rootOf(sessions, input.sessionID)
      const row = yield* getRow(root.id, input.key)
      return row === undefined ? undefined : fromRow(row)
    })

    const list: Interface["list"] = Effect.fn("Blackboard.list")(function* (input) {
      const root = yield* rootOf(sessions, input.sessionID)
      const where = input.prefix
        ? and(eq(BlackboardTable.root_session_id, root.id), like(BlackboardTable.key, `${input.prefix}%`))
        : eq(BlackboardTable.root_session_id, root.id)
      const rows = yield* db
        .select()
        .from(BlackboardTable)
        .where(where)
        .orderBy(asc(BlackboardTable.key))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fn("Blackboard.remove")(function* (input) {
      const root = yield* rootOf(sessions, input.sessionID)
      yield* db
        .delete(BlackboardTable)
        .where(and(eq(BlackboardTable.root_session_id, root.id), eq(BlackboardTable.key, input.key)))
        .run()
        .pipe(Effect.orDie)
    })

    return Service.of({ put, get, list, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Database.node, Session.node, Config.node],
})

export * as Blackboard from "./blackboard"
