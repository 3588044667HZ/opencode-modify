import * as Tool from "./tool"
import DESCRIPTION from "./context.txt"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "../session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"

const id = "context"

type Metadata = {
  session: SessionID
  agent: string
  model: string
  message: MessageID | null
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number } | null
  used: number | null
  limit: number | null
  percent: number | null
  remaining: number | null
  over: boolean
  unavailable?: string
}

export const Parameters = Schema.Struct({
  session_id: Schema.optional(Schema.String).annotate({
    description: "Session to inspect. Defaults to the current session; other sessions must be descendants.",
  }),
})

export const ContextTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service

    const run = Effect.fn("ContextTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const targetID = params.session_id === undefined ? ctx.sessionID : SessionID.make(params.session_id)
      const target = yield* sessions
        .get(targetID)
        .pipe(Effect.catchCause(() => Effect.fail(new Error(`Unknown session: ${targetID}`))))

      if (target.id !== ctx.sessionID) {
        let ancestor = target
        while (ancestor.parentID) {
          ancestor = yield* sessions.get(ancestor.parentID)
          if (ancestor.id === ctx.sessionID) break
        }
        if (ancestor.id !== ctx.sessionID)
          return yield* Effect.fail(new Error("Context tool only inspects the current session or its descendants"))
      }

      const messages = yield* sessions.messages({ sessionID: target.id })
      const assistant = messages.findLast(
        (item): item is SessionV1.WithParts & { info: SessionV1.Assistant } =>
          item.info.role === "assistant" && tokenTotal(item.info.tokens) > 0,
      )?.info
      const providerID = assistant?.providerID ?? target.model?.providerID
      const modelID = assistant?.modelID ?? target.model?.id
      const model = providerID && modelID ? `${providerID}/${modelID}` : "unknown"
      const agent = assistant?.agent ?? target.agent ?? ctx.agent

      if (!assistant) return unavailable({ sessionID: target.id, agent, model, reason: "no assistant token usage" })

      const tokens = {
        input: assistant.tokens.input,
        output: assistant.tokens.output,
        reasoning: assistant.tokens.reasoning,
        cache_read: assistant.tokens.cache.read,
        cache_write: assistant.tokens.cache.write,
      }
      const used = tokens.input + tokens.output + tokens.reasoning + tokens.cache_read + tokens.cache_write
      const resolved = yield* provider
        .getModel(assistant.providerID, assistant.modelID)
        .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
      const limit = resolved?.limit.context ?? 0
      if (limit <= 0)
        return unavailable({
          sessionID: target.id,
          agent,
          model,
          reason: "model context limit unavailable",
          message: assistant.id,
        })

      const percent = Math.round((used / limit) * 100)
      const remaining = Math.max(0, limit - used)
      const over = used > limit

      const result: Tool.ExecuteResult<Metadata> = {
        title: `context ${target.id}`,
        metadata: {
          session: target.id,
          agent,
          model,
          message: assistant.id,
          tokens,
          used,
          limit,
          percent,
          remaining,
          over,
        },
        output: [
          `<context session="${escapeXml(target.id)}" agent="${escapeXml(agent)}" model="${escapeXml(model)}">`,
          `  <window limit="${limit}" used="${used}" percent="${percent}" remaining="${remaining}" over="${over}" />`,
          `  <tokens input="${tokens.input}" output="${tokens.output}" reasoning="${tokens.reasoning}" cache_read="${tokens.cache_read}" cache_write="${tokens.cache_write}" />`,
          `  <source message="${escapeXml(assistant.id)}" />`,
          "</context>",
        ].join("\n"),
      }
      return result
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function tokenTotal(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function unavailable(input: {
  sessionID: SessionID
  agent: string
  model: string
  reason: string
  message?: MessageID
}): Tool.ExecuteResult<Metadata> {
  const attrs = [
    `session="${escapeXml(input.sessionID)}"`,
    `agent="${escapeXml(input.agent)}"`,
    `model="${escapeXml(input.model)}"`,
    `unavailable="${escapeXml(input.reason)}"`,
  ].join(" ")
  const output = input.message
    ? [`<context ${attrs}>`, `  <source message="${escapeXml(input.message)}" />`, "</context>"].join("\n")
    : `<context ${attrs} />`
  return {
    title: `context ${input.sessionID}`,
    metadata: {
      session: input.sessionID,
      agent: input.agent,
      model: input.model,
      message: input.message ?? null,
      tokens: null,
      used: null,
      limit: null,
      percent: null,
      remaining: null,
      over: false,
      unavailable: input.reason,
    },
    output,
  }
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
