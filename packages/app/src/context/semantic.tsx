import { createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { playSoundById } from "@/utils/sound"
import { showToast } from "@/utils/toast"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServerSDK } from "./server-sdk"
import { useSettings } from "./settings"

export type SemanticIndexingStatus = "starting" | "indexing" | "ready" | "failed"

export type SemanticIndexingState = {
  status: SemanticIndexingStatus
  progress: number
  current?: string
  phase?: string
  error?: string
}

const STATUSES = new Set<string>(["starting", "indexing", "ready", "failed"])

export const { use: useSemantic, provider: SemanticProvider } = createSimpleContext({
  name: "Semantic",
  gate: false,
  init: () => {
    const serverSDK = useServerSDK()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()
    const [state, setState] = createStore<Partial<SemanticIndexingState>>({ progress: 0 })

    const reportFailure = (error?: string) => {
      const title = language.t("semantic.warmup.failed.title")
      const description = error ?? language.t("semantic.warmup.failed.description")
      showToast({ variant: "error", title, description })
      if (settings.sounds.errorsEnabled()) void playSoundById(settings.sounds.errors())
      if (settings.notifications.errors()) void platform.notify(title, description)
    }

    const stop = serverSDK().event.listen((event) => {
      // `semantic.indexing` 由 packages/schema 定义；app 固定的客户端类型包尚未包含
      // 该事件，这里按字符串消费，避免依赖类型包重新生成。
      const payload = readIndexingPayload(event)
      if (!payload) return
      const firstFailure = payload.status === "failed" && state.status !== "failed"
      setState({
        status: payload.status,
        progress: payload.progress,
        current: payload.current,
        phase: payload.phase,
        error: payload.error,
      })
      if (firstFailure) reportFailure(payload.error)
    })
    onCleanup(stop)

    return {
      status: () => state.status,
      progress: () => state.progress ?? 0,
      current: () => state.current,
      error: () => state.error,
      active: createMemo(() => state.status === "starting" || state.status === "indexing"),
    }
  },
})

function readIndexingPayload(event: unknown): SemanticIndexingState | undefined {
  const envelope = event as { details?: unknown; type?: unknown; properties?: unknown; data?: unknown } | null
  if (!envelope) return
  const payload = (envelope.details ?? envelope) as {
    type?: unknown
    properties?: unknown
    data?: unknown
  } | null
  if (!payload || payload.type !== "semantic.indexing") return
  const data = payload.properties ?? payload.data
  if (!data || typeof data !== "object") return
  const record = data as Record<string, unknown>
  if (typeof record.status !== "string" || !STATUSES.has(record.status)) return
  return {
    status: record.status as SemanticIndexingStatus,
    progress:
      typeof record.progress === "number" && Number.isFinite(record.progress)
        ? Math.min(1, Math.max(0, record.progress))
        : 0,
    current: typeof record.current === "string" ? record.current : undefined,
    phase: typeof record.phase === "string" ? record.phase : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  }
}
