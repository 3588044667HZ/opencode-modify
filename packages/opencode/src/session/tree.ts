import { Effect } from "effect"
import type { Session } from "./session"
import type { SessionID } from "./schema"

/**
 * Walks `parentID` to the root of a session tree. Collaboration features
 * (peer messaging, blackboard) are scoped to this root.
 */
export function rootOf(sessions: Session.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    let current = yield* sessions.get(sessionID)
    while (current.parentID) current = yield* sessions.get(current.parentID)
    return current
  })
}
