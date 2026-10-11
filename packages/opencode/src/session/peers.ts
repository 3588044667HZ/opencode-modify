import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { PartID } from "./schema"
import { Mailbox } from "./mailbox"
import { peerMetadata, renderPeerMessage } from "./peer-message"
import type { Session } from "./session"

/**
 * Flushes peer messages queued while the session was idle (`wake_idle: false`).
 * Runs at the start of a provider turn, alongside reminders, so the recipient
 * sees queued messages as synthetic input on its next run.
 */
export const apply = Effect.fn("SessionPeers.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  session: Session.Info
}) {
  const mailbox = yield* Mailbox.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages
  const queued = yield* mailbox.pullQueued(input.session.id)
  for (const message of queued) {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      synthetic: true,
      metadata: peerMetadata({
        from: message.fromSessionID,
        fromAgent: message.fromAgent,
        kind: message.kind,
        hop: message.hop,
      }),
      text: renderPeerMessage({
        id: message.id,
        kind: message.kind,
        hop: message.hop,
        from: { sessionID: message.fromSessionID, agent: message.fromAgent ?? "unknown" },
        to: { sessionID: input.session.id, agent: input.session.agent },
        replyTo: message.replyTo,
        body: message.body,
      }),
    })
  }
  return input.messages
})

export * as SessionPeers from "./peers"
