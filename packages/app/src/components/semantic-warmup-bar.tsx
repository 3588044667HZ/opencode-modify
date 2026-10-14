import { Progress } from "@opencode-ai/ui/progress"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSemantic } from "@/context/semantic"

export function SemanticWarmupBar(props: { class?: string }) {
  const language = useLanguage()
  const semantic = useSemantic()
  const percent = () => Math.round(semantic.progress() * 100)
  const label = () => {
    const current = semantic.current()
    if (!current) return language.t("semantic.warmup.starting")
    return language.t("semantic.warmup.indexing", { progress: percent(), current })
  }

  return (
    <Show when={semantic.active()}>
      <div
        data-component="semantic-warmup"
        role="status"
        aria-live="polite"
        classList={{
          "flex items-center gap-3 min-w-0": true,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <Progress
          class="w-40 shrink-0"
          value={percent()}
          minValue={0}
          maxValue={100}
          aria-label={label()}
        />
        <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{label()}</span>
      </div>
    </Show>
  )
}
