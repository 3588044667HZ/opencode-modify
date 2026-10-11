import { onCleanup } from "solid-js"
import { useSDK } from "@/context/sdk"

/**
 * Refreshes a panel when one of the given live server events arrives for the
 * current directory. Team/blackboard/peer events are live-only (not durable),
 * so they act as invalidation signals and the panel refetches the read route.
 */
export function createSessionEventRefresh(types: readonly string[], refresh: () => void) {
  const sdk = useSDK()
  const stop = sdk().event.listen((event) => {
    // The app's typed event union is generated from the pinned client and does
    // not know current `session.next.*` live events, so read the type loosely.
    const record = event as unknown as { type?: string; details?: { type?: string } }
    const type = record.type ?? record.details?.type
    if (type && types.includes(type)) refresh()
  })
  onCleanup(stop)
}
