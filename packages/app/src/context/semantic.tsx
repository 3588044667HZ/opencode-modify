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
    // 状态按目录隔离：事件与状态查询都携带工作目录，避免跨项目互相覆盖
    const [states, setStates] = createStore<Record<string, SemanticIndexingState>>({})

    const reportFailure = (error?: string) => {
      const title = language.t("semantic.warmup.failed.title")
      const description = error ?? language.t("semantic.warmup.failed.description")
      showToast({ variant: "error", title, description })
      if (settings.sounds.errorsEnabled()) void playSoundById(settings.sounds.errors())
      if (settings.notifications.errors()) void platform.notify(title, description)
    }

    const apply = (directory: string, next: SemanticIndexingState) => {
      // 每个目录只在首次进入 failed 时提示一次
      if (next.status === "failed" && states[directory]?.status !== "failed") reportFailure(next.error)
      setStates(directory, next)
    }

    const stop = serverSDK().event.listen((envelope) => {
      // 事件以 { name: directory, details: payload } 信封投递；缺失目录时不猜测归属
      if (!envelope.name) return
      // `semantic.indexing` 由 packages/schema 定义；app 固定的客户端类型包尚未包含
      // 该事件，这里按字符串消费，避免依赖类型包重新生成。
      const payload = readIndexingPayload(envelope.details)
      if (!payload) return
      apply(envelope.name, payload)
    })
    onCleanup(stop)

    return {
      state: (directory: string) => states[directory],
      seed: (directory: string, next: SemanticIndexingState) => apply(directory, next),
      active: createMemo(() =>
        Object.keys(states).some((key) => {
          const status = states[key]?.status
          return status === "starting" || status === "indexing"
        }),
      ),
    }
  },
})

function readIndexingPayload(event: unknown): SemanticIndexingState | undefined {
  if (!event || typeof event !== "object") return
  const payload = event as { type?: unknown; properties?: unknown; data?: unknown }
  if (payload.type !== "semantic.indexing") return
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
