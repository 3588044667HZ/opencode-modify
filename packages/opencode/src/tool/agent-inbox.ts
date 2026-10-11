import * as Tool from "./tool"
import DESCRIPTION from "./agent-inbox.txt"
import { Mailbox } from "@/session/mailbox"
import { Effect, Schema } from "effect"

const id = "agent_inbox"

export const Parameters = Schema.Struct({
  unread_only: Schema.optional(Schema.Boolean).annotate({ description: "Only return messages not yet read (reserved)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of messages to return (default 50)" }),
})

export const AgentInboxTool = Tool.define(
  id,
  Effect.gen(function* () {
    const mailbox = yield* Mailbox.Service

    const run = Effect.fn("AgentInboxTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const messages = yield* mailbox.list({ sessionID: ctx.sessionID, limit: params.limit })
      return {
        title: "agent inbox",
        metadata: { count: messages.length },
        output: JSON.stringify(messages),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
