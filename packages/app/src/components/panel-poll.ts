import { onCleanup } from "solid-js"

/**
 * `session.next.*` live events are not delivered on every server protocol
 * generation, so agent-team panels poll their read routes while the window is
 * visible. Event-driven refreshes still run when events do arrive.
 */
export function createPanelPoll(refresh: () => void, intervalMs = 3000) {
  const tick = () => {
    if (typeof document !== "undefined" && document.hidden) return
    refresh()
  }
  const timer = setInterval(tick, intervalMs)
  if (typeof document !== "undefined") {
    // Coming back from occluded/minimized should refresh immediately instead
    // of waiting for the next interval.
    document.addEventListener("visibilitychange", tick)
    onCleanup(() => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    })
    return
  }
  onCleanup(() => clearInterval(timer))
}
