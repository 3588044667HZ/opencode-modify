import * as Tool from "./tool"
import DESCRIPTION from "./agent-send.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Mailbox } from "@/session/mailbox"
import { SessionID, MessageID } from "../session/schema"
import { peerMetadata, renderPeerMessage } from "../session/peer-message"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { Effect, Schema } from "effect"

const id = "agent_send"
const DEFAULT_MAX_HOP = 8
const DEFAULT_MAX_BODY_BYTES = 8192
const DEFAULT_MAX_PER_MINUTE = 20
const RATE_WINDOW_MS = 60_000

export const Parameters = Schema.Struct({
  to: Schema.String.annotate({
    description: 'Target within the same session tree: a sessionID, "parent", or "root"',
  }),
  message: Schema.String.annotate({ description: "Message body to deliver to the peer agent" }),
  kind: Schema.optional(Schema.Literals(["note", "question", "answer", "handoff"])).annotate({
    description: "Message kind, used only as a hint in the envelope",
  }),
  reply_to: Schema.optional(Schema.String).annotate({ description: "Peer-message id this message replies to" }),
})

export const AgentSendTool = Tool.define(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const mailbox = yield* Mailbox.Service

    const sent = new Map<string, number[]>()

    const rootOf = Effect.fn("AgentSendTool.rootOf")(function* (sessionID: SessionID) {
      let current = yield* sessions.get(sessionID)
      while (current.parentID) current = yield* sessions.get(current.parentID)
      return current
    })

    const run = Effect.fn("AgentSendTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const maxHop = cfg.agent_message?.max_hop ?? DEFAULT_MAX_HOP
      const maxBodyBytes = cfg.agent_message?.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES
      const maxPerMinute = cfg.agent_message?.max_per_minute ?? DEFAULT_MAX_PER_MINUTE
      const wakeIdle = cfg.agent_message?.wake_idle ?? true

      if (Buffer.byteLength(params.message, "utf8") > maxBodyBytes)
        return yield* Effect.fail(new Error(`Message exceeds the ${maxBodyBytes} byte limit`))

      const sender = yield* sessions.get(ctx.sessionID)
      const senderRoot = yield* rootOf(ctx.sessionID)

      const target = yield* resolveTarget(params.to, { sender, senderRoot, sessions, rootOf })
      if (target.root.id !== senderRoot.id)
        return yield* Effect.fail(new Error("Peer target is outside this session tree"))

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: "agent_message",
          patterns: ["*"],
          always: ["*"],
          metadata: { to: params.to, kind: params.kind ?? "note" },
        })
      }

      const hop = (yield* mailbox.lastHop(ctx.sessionID)) + 1
      if (hop > maxHop)
        return yield* Effect.fail(
          new Error(`Peer message hop limit reached (${maxHop}). Avoid forwarding messages in a loop.`),
        )

      const targetStatus = yield* status.get(target.session.id)
      const queue = !wakeIdle && targetStatus.type === "idle"

      const now = Date.now()
      const recent = (sent.get(ctx.sessionID) ?? []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS)
      if (recent.length >= maxPerMinute)
        return yield* Effect.fail(new Error(`Rate limit reached (${maxPerMinute} messages per minute); try again later.`))
      sent.set(ctx.sessionID, [...recent, now])

      const envelopeID = MessageID.ascending()
      const kind = params.kind ?? "note"

      if (queue) {
        yield* mailbox.record({
          id: envelopeID,
          fromSessionID: ctx.sessionID,
          fromAgent: ctx.agent,
          toSessionID: target.session.id,
          kind,
          body: params.message,
          hop,
          status: "queued",
          ...(params.reply_to === undefined ? {} : { replyTo: params.reply_to }),
        })
        return {
          title: `peer message queued for ${target.session.id}`,
          metadata: { to: target.session.id, kind, hop, queued: true },
          output: `Queued peer message ${envelopeID} for ${target.session.id}; it will be delivered when the session next runs.`,
        }
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("AgentSendTool requires promptOps in ctx.extra"))

      const envelope = renderPeerMessage({
        id: envelopeID,
        kind,
        hop,
        from: { sessionID: ctx.sessionID, agent: ctx.agent },
        to: { sessionID: target.session.id, agent: target.session.agent },
        replyTo: params.reply_to,
        body: params.message,
      })

      yield* ops.prompt({
        messageID: MessageID.ascending(),
        sessionID: target.session.id,
        agent: target.session.agent ?? ctx.agent,
        variant: target.session.model?.variant,
        parts: [
          {
            type: "text",
            synthetic: true,
            metadata: peerMetadata({ from: ctx.sessionID, fromAgent: ctx.agent, kind, hop }),
            text: envelope,
          },
        ],
      })

      yield* mailbox.record({
        id: envelopeID,
        fromSessionID: ctx.sessionID,
        fromAgent: ctx.agent,
        toSessionID: target.session.id,
        kind,
        body: params.message,
        hop,
        status: "delivered",
        ...(params.reply_to === undefined ? {} : { replyTo: params.reply_to }),
      })

      return {
        title: `peer message to ${target.session.id}`,
        metadata: { to: target.session.id, kind, hop },
        output: `Delivered peer message ${envelopeID} to ${target.session.id} (hop ${hop}).`,
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

function resolveTarget(
  to: string,
  input: {
    sender: Session.Info
    senderRoot: Session.Info
    sessions: Session.Interface
    rootOf: (sessionID: SessionID) => Effect.Effect<Session.Info, any>
  },
) {
  return Effect.gen(function* () {
    if (to === "parent") {
      if (!input.sender.parentID) return yield* Effect.fail(new Error("This session has no parent to message"))
      const session = yield* input.sessions.get(input.sender.parentID)
      return { session, root: yield* input.rootOf(session.id) }
    }
    if (to === "root") {
      const session = yield* input.rootOf(input.sender.id)
      return { session, root: session }
    }
    const session = yield* input.sessions
      .get(SessionID.make(to))
      .pipe(Effect.catchCause(() => Effect.fail(new Error(`Unknown peer session: ${to}`))))
    return { session, root: yield* input.rootOf(session.id) }
  })
}
