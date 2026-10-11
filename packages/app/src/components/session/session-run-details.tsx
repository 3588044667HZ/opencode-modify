import { Show, createMemo } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { formatElapsedTime } from "@/utils/time"

/**
 * Compact run summary shown at the top of subagent (child) session windows:
 * which agent and model ran, the thinking intensity, tokens, elapsed time, and
 * live status. Root sessions do not render this bar.
 */
export function SessionRunDetails(props: { session: Session }) {
  const language = useLanguage()
  const sync = useSync()

  const running = createMemo(() => {
    const type = sync().data.session_status[props.session.id]?.type
    return type === "busy" || type === "retry"
  })

  const intensity = createMemo(() => {
    const variant = props.session.model?.variant
    if (!variant || variant === "default") return language.t("common.default")
    return variant
  })

  const tokens = createMemo(() => {
    const value = props.session.tokens
    if (!value) return
    const total = value.input + value.output + value.reasoning + value.cache.read + value.cache.write
    return total > 0 ? total : undefined
  })

  const elapsed = createMemo(() => {
    const time = props.session.time
    return time.updated > time.created ? time.updated - time.created : undefined
  })

  const compact = (value: number) =>
    new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }).format(value)

  return (
    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border-weak-base px-4 py-1.5 text-11-regular text-text-weak"
    >
      <Show when={props.session.agent}>
        {(agent) => <span class="truncate text-11-medium text-text-base">@{agent()}</span>}
      </Show>
      <Show when={props.session.model}>
        {(model) => <span class="truncate text-text-weaker">{model().id}</span>}
      </Show>
      <span class="text-text-weaker">
        {language.t("model.tooltip.reasoning")}: {intensity()}
      </span>
      <Show when={tokens()}>
        {(total) => (
          <span class="text-text-weaker">
            {compact(total())} {language.t("context.usage.tokens")}
          </span>
        )}
      </Show>
      <Show when={elapsed()}>
        {(ms) => <span class="shrink-0 tabular-nums text-text-weaker">{formatElapsedTime(ms())}</span>}
      </Show>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <span
          class={`size-1.5 rounded-full ${running() ? "bg-icon-warning-base animate-pulse" : "bg-icon-weak-base"}`}
        />
        <span class="text-text-weaker">
          {language.t(running() ? "agentTeams.state.running" : "agentTeams.state.idle")}
        </span>
      </span>
    </div>
  )
}
