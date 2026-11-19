export * as SessionCompactionRequest from "./compaction-request"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export interface Request {
  readonly focus?: string
}

export interface Interface {
  /**
   * Coalesces a manual compaction request for one Session. Repeated requests
   * share one pending entry; the latest non-empty focus wins.
   */
  readonly request: (input: { readonly sessionID: SessionSchema.ID; readonly focus?: string }) => Effect.Effect<Request>
  /** Removes and returns the pending manual compaction request for one Session. */
  readonly take: (sessionID: SessionSchema.ID) => Effect.Effect<Request | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionCompactionRequest") {}

const MAX_FOCUS_CHARS = 2_000

const focusOf = (focus: string | undefined) => {
  const value = focus?.trim()
  if (!value) return
  return value.length <= MAX_FOCUS_CHARS ? value : value.slice(0, MAX_FOCUS_CHARS)
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const pending = new Map<SessionSchema.ID, Request>()
    return Service.of({
      request: Effect.fn("SessionCompactionRequest.request")(function* (input) {
        const focus = focusOf(input.focus)
        const next: Request = focus === undefined ? (pending.get(input.sessionID) ?? {}) : { focus }
        pending.set(input.sessionID, next)
        return next
      }),
      take: Effect.fn("SessionCompactionRequest.take")(function* (sessionID) {
        const request = pending.get(sessionID)
        pending.delete(sessionID)
        return request
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [],
})
