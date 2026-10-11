export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

export type PeerMeta = {
  from?: string
  fromAgent?: string
  kind?: string
  hop?: number
}

/**
 * Reads peer-messaging metadata attached by the `agent_send` tool. Peer
 * messages are injected as synthetic text parts; this lets the timeline label
 * them explicitly instead of relying on the generic synthetic-message path.
 */
export function peerMeta(part: { metadata?: Record<string, unknown> }): PeerMeta | undefined {
  const peer = part.metadata?.peer
  if (!peer || typeof peer !== "object" || Array.isArray(peer)) return undefined
  const value = peer as Record<string, unknown>
  const meta: PeerMeta = {}
  if (typeof value.from === "string") meta.from = value.from
  if (typeof value.fromAgent === "string") meta.fromAgent = value.fromAgent
  if (typeof value.kind === "string") meta.kind = value.kind
  if (typeof value.hop === "number") meta.hop = value.hop
  return Object.keys(meta).length > 0 ? meta : undefined
}

