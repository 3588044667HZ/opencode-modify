import { Button } from "@opencode-ai/ui/button"
import { Progress } from "@opencode-ai/ui/progress"
import type { SemanticStatusInfo } from "@opencode-ai/sdk/v2/client"
import { createEffect, createSignal, on, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSemantic } from "@/context/semantic"

export function SemanticWarmupBar(props: { class?: string }) {
  const language = useLanguage()
  const sdk = useSDK()
  const semantic = useSemantic()
  const [idle, setIdle] = createSignal(false)
  const [pending, setPending] = createSignal(false)

  const directory = () => sdk().directory
  const state = () => semantic.state(directory())
  const percent = () => Math.round((state()?.progress ?? 0) * 100)
  const active = () => state()?.status === "starting" || state()?.status === "indexing"
  // failed 也保留入口：失败后 30s 冷却期内点击只会返回失败快照，冷却后可重试
  const showAction = () => !active() && (idle() || state()?.status === "failed")

  const label = () => {
    if (state()?.status === "starting") return language.t("semantic.warmup.starting")
    const current = state()?.current
    if (current) return language.t("semantic.warmup.indexing", { progress: percent(), current })
    return language.t("semantic.warmup.progress", { progress: percent() })
  }

  const apply = (directory: string, info: SemanticStatusInfo) => {
    if (info.status === "disabled") {
      setIdle(false)
      return
    }
    if (info.status === "idle") {
      setIdle(true)
      return
    }
    semantic.seed(directory, {
      status: info.status,
      // 生成类型里 progress 含 "NaN"/"Infinity" 等字符串，非有限数值按 0 处理
      progress: typeof info.progress === "number" && Number.isFinite(info.progress) ? info.progress : 0,
      current: info.current,
      phase: info.phase,
      error: info.error,
    })
    setIdle(false)
  }

  // 挂载及目录切换时向服务端取一次状态；不轮询，后续进度依赖事件
  createEffect(
    on(
      () => sdk().directory,
      (directory) => {
        // 目录切换后旧目录的 idle 结论不再适用，等新目录的状态返回
        setIdle(false)
        void sdk()
          .client.semantic.status()
          .then((result) => {
            if (directory !== sdk().directory || !result.data) return
            apply(directory, result.data)
          })
          .catch(() => {})
      },
    ),
  )

  const warmup = () => {
    if (pending()) return
    setPending(true)
    const directory = sdk().directory
    void sdk()
      .client.semantic.warmup()
      .then((result) => {
        if (directory !== sdk().directory || !result.data) return
        apply(directory, result.data)
      })
      .catch(() => {})
      .finally(() => setPending(false))
  }

  return (
    <>
      <Show when={active()}>
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
            // 冷启动阶段引擎不提供 progress/current，用不确定态避免进度条冻结在 0%
            indeterminate={state()?.status === "starting"}
            value={percent()}
            minValue={0}
            maxValue={100}
            aria-label={label()}
          />
          <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{label()}</span>
        </div>
      </Show>
      <Show when={showAction()}>
        <div
          data-component="semantic-warmup-action"
          classList={{
            "flex items-center min-w-0": true,
            [props.class ?? ""]: !!props.class,
          }}
        >
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={pending()}
            aria-label={language.t("semantic.warmup.action")}
            onClick={warmup}
          >
            {language.t("semantic.warmup.action")}
          </Button>
        </div>
      </Show>
    </>
  )
}
