import * as Tool from "./tool"
import DESCRIPTION from "./blackboard.txt"
import { Blackboard } from "@/session/blackboard"
import { Effect, Schema } from "effect"

const id = "blackboard"

export const Parameters = Schema.Struct({
  op: Schema.Literals(["put", "get", "list", "delete"]).annotate({ description: "Operation to perform" }),
  key: Schema.optional(Schema.String).annotate({
    description: "Blackboard key. Required for get/delete; used as a prefix for list",
  }),
  value: Schema.optional(Schema.String).annotate({ description: "Value to write (required for put)" }),
  mode: Schema.optional(Schema.Literals(["set", "append"])).annotate({
    description: "put mode: set (default) overwrites, append adds to the existing value",
  }),
  if_version: Schema.optional(Schema.Number).annotate({
    description: "Compare-and-swap guard: only write when the current version matches",
  }),
})

export const BlackboardTool = Tool.define(
  id,
  Effect.gen(function* () {
    const board = yield* Blackboard.Service

    const run = Effect.fn("BlackboardTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* ctx.ask({ permission: id, patterns: ["*"], always: ["*"], metadata: { op: params.op } })

      switch (params.op) {
        case "put": {
          if (!params.key) return yield* Effect.fail(new Error("blackboard put requires a key"))
          if (params.value === undefined) return yield* Effect.fail(new Error("blackboard put requires a value"))
          const entry = yield* board.put({
            sessionID: ctx.sessionID,
            key: params.key,
            value: params.value,
            mode: params.mode,
            ifVersion: params.if_version,
            authorSessionID: ctx.sessionID,
            authorAgent: ctx.agent,
          })
          return {
            title: `blackboard put ${entry.key}`,
            metadata: { key: entry.key, version: entry.version },
            output: JSON.stringify({ key: entry.key, version: entry.version }),
          }
        }
        case "get": {
          if (!params.key) return yield* Effect.fail(new Error("blackboard get requires a key"))
          const entry = yield* board.get({ sessionID: ctx.sessionID, key: params.key })
          return {
            title: `blackboard get ${params.key}`,
            metadata: { key: params.key, found: entry !== undefined },
            output: entry === undefined ? JSON.stringify({ key: params.key, found: false }) : JSON.stringify(entry),
          }
        }
        case "list": {
          const entries = yield* board.list({ sessionID: ctx.sessionID, prefix: params.key })
          return {
            title: `blackboard list${params.key ? ` ${params.key}` : ""}`,
            metadata: { count: entries.length },
            output: JSON.stringify(entries),
          }
        }
        case "delete": {
          if (!params.key) return yield* Effect.fail(new Error("blackboard delete requires a key"))
          yield* board.remove({ sessionID: ctx.sessionID, key: params.key })
          return {
            title: `blackboard delete ${params.key}`,
            metadata: { key: params.key },
            output: JSON.stringify({ key: params.key, deleted: true }),
          }
        }
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.orDie,
          Effect.map((result): Tool.ExecuteResult => result),
        ),
    }
  }),
)
