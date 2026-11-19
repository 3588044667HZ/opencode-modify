import { Progress } from "@opencode-ai/ui/progress"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { SemanticStatusInfo } from "@opencode-ai/sdk/v2/client"
import { type Component, For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

type SemanticConfigState = {
  enabled?: boolean
  tools?: string[]
  ide?: string
  ideHome?: string
  jdkHome?: string
  jar?: string
  command?: string[]
}

export const SessionSemanticTab: Component = () => {
  const language = useLanguage()
  const sdk = useSDK()
  const [state, setState] = createStore<{
    local?: SemanticStatusInfo
    config?: SemanticConfigState
    loading: boolean
    warming: boolean
    error?: string
  }>({ loading: false, warming: false })

  const status = createMemo(() => state.local?.status)
  const active = createMemo(() => status() === "starting" || status() === "indexing")
  const percent = createMemo(() => {
    const progress = state.local?.progress
    return typeof progress === "number" && Number.isFinite(progress) ? Math.round(progress * 100) : 0
  })
  const detail = createMemo(() => {
    const value = state.local
    return [value?.phase, value?.current].filter(Boolean).join(" · ")
  })
  const errorText = createMemo(() => state.error ?? state.local?.error)

  const apply = (info: SemanticStatusInfo) => {
    setState("local", info)
    setState("error", undefined)
  }

  const loadConfig = async () => {
    try {
      const result = await sdk().client.config.get()
      const semantic = result.data?.semantic
      setState("config", {
        enabled: semantic?.enabled,
        tools: semantic?.tools,
        ide: semantic?.ide,
        ideHome: semantic?.ide_home,
        jdkHome: semantic?.jdk_home,
        jar: semantic?.jar,
        command: semantic?.command,
      })
    } catch {
      setState("config", undefined)
    }
  }
  const refresh = async () => {
    setState("loading", true)
    try {
      const result = await sdk().client.semantic.status()
      if (result.data) {
        apply(result.data)
        return
      }
      setState("error", errorMessage(result.error) ?? language.t("settings.semantic.error.load"))
    } catch (err) {
      setState("error", errorMessage(err) ?? language.t("settings.semantic.error.load"))
    } finally {
      setState("loading", false)
    }
  }

  const warmup = async () => {
    if (state.warming || active() || status() === "disabled") return
    setState("warming", true)
    try {
      const result = await sdk().client.semantic.warmup()
      if (!result.data) {
        const message = errorMessage(result.error) ?? language.t("settings.semantic.error.warmup")
        setState("error", message)
        showToast({ variant: "error", title: language.t("settings.semantic.error.warmup"), description: message })
        return
      }
      apply(result.data)
      showToast({ variant: "success", title: language.t("settings.semantic.toast.warmup") })
    } catch (err) {
      const message = errorMessage(err) ?? language.t("settings.semantic.error.warmup")
      setState("error", message)
      showToast({ variant: "error", title: language.t("settings.semantic.error.warmup"), description: message })
    } finally {
      setState("warming", false)
    }
  }

  // 侧栏跟随当前 session 的 directory；状态请求已由 SDK 按目录路由。
  createEffect(() => {
    const directory = sdk().directory
    setState("local", undefined)
    setState("error", undefined)
    if (directory) {
      void refresh()
      void loadConfig()
    }
  })

  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => void refresh(), 2000)
    onCleanup(() => clearInterval(timer))
  })

  const exposedTools = createMemo(() => state.config?.tools ?? ["read_view"])
  const ideLabel = createMemo(() => {
    const config = state.config
    if (!config) return "—"
    return config.ideHome || config.ide || language.t("settings.semantic.runtime.auto")
  })
  const jdkLabel = createMemo(() => {
    const config = state.config
    if (!config) return "—"
    return config.jdkHome || language.t("settings.semantic.runtime.auto")
  })
  const launchLabel = createMemo(() => {
    const config = state.config
    if (!config) return "—"
    if (config.command?.length) return language.t("settings.semantic.runtime.customCommand")
    return config.jar || language.t("settings.semantic.runtime.auto")
  })
  const enabledLabel = createMemo(() => {
    const config = state.config
    if (!config) return "—"
    return config.enabled
      ? language.t("settings.semantic.runtime.on")
      : language.t("settings.semantic.runtime.off")
  })

  return (
    <ScrollView class="@container h-full">
      <div data-component="session-semantic-tab" class="px-5 pt-4 pb-10 flex flex-col gap-6">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex flex-col gap-1.5">
            <div class="text-12-regular text-text-weak">{language.t("settings.semantic.status.title")}</div>
            <div class="flex items-center gap-2 min-w-0">
              <Tag>{statusLabel(language, status())}</Tag>
              <span class="text-11-regular text-text-weaker truncate" title={sdk().directory}>
                {sdk().directory}
              </span>
            </div>
          </div>
          <div class="shrink-0 flex items-center gap-1.5">
            <Button
              size="small"
              variant="ghost"
              disabled={state.loading}
              onClick={() => void refresh()}
            >
              {language.t("settings.semantic.action.refresh")}
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={state.warming || active() || status() === "disabled"}
              onClick={() => void warmup()}
            >
              {state.warming
                ? language.t("settings.semantic.action.warming")
                : status() === "failed"
                  ? language.t("settings.semantic.action.retry")
                  : language.t("settings.semantic.action.warmup")}
            </Button>
          </div>
        </div>

        <Show when={active()}>
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3 text-11-regular text-text-weak">
              <span class="truncate">{detail() || language.t("settings.semantic.status.starting")}</span>
              <span class="shrink-0 tabular-nums">{percent()}%</span>
            </div>
            <Progress
              indeterminate={status() === "starting"}
              value={percent()}
              minValue={0}
              maxValue={100}
              aria-label={language.t("settings.semantic.status.progress")}
            />
          </div>
        </Show>

        <Show when={errorText()}>
          {(message) => (
            <div class="rounded-md border border-border-critical-base bg-surface-critical-base px-3 py-2">
              <div class="text-12-medium text-syntax-critical">{language.t("settings.semantic.status.error")}</div>
              <div class="mt-1 text-11-regular text-syntax-critical break-words">{message()}</div>
            </div>
          )}
        </Show>

        <Show when={status() === "disabled"}>
          <div class="rounded-md border border-border-weak-base px-3 py-2.5 flex flex-col gap-1">
            <div class="text-12-medium text-text-strong">{language.t("settings.semantic.hint.disabled.title")}</div>
            <div class="text-11-regular text-text-weak leading-relaxed">
              {language.t("settings.semantic.hint.disabled.description")}
            </div>
          </div>
        </Show>
        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("settings.semantic.tools.exposed")}</div>
          <div class="rounded-md border border-border-weak-base px-3 py-2.5 flex flex-wrap gap-1.5">
            <Show
              when={exposedTools().length > 0}
              fallback={<span class="text-11-regular text-text-weak">{language.t("settings.semantic.tools.none")}</span>}
            >
              <For each={exposedTools()}>{(tool) => <Tag variant="accent">{tool}</Tag>}</For>
            </Show>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("settings.semantic.runtime.title")}</div>
          <div class="rounded-md border border-border-weak-base px-3 py-2.5 flex flex-col gap-1.5 text-11-regular">
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-weak">{language.t("settings.semantic.runtime.enabled")}</span>
              <span class="text-text-base text-end">{enabledLabel()}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-weak">{language.t("settings.semantic.runtime.ide")}</span>
              <span class="text-text-base text-end break-all">{ideLabel()}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-weak">{language.t("settings.semantic.runtime.jdk")}</span>
              <span class="text-text-base text-end break-all">{jdkLabel()}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-weak">{language.t("settings.semantic.runtime.launch")}</span>
              <span class="text-text-base text-end break-all">{launchLabel()}</span>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("settings.semantic.config.title")}</div>
          <div class="rounded-md border border-border-weak-base px-3 py-2.5 flex flex-col gap-2">
            <div class="text-11-regular text-text-weak">
              <code>~/.config/opencode/opencode.jsonc</code>
            </div>
            <div class="text-11-regular text-text-weak leading-relaxed">
              {language.t("settings.semantic.tools.description")}
            </div>
            <div class="text-11-regular text-text-weaker leading-relaxed">
              {language.t("settings.semantic.environment.description")}
            </div>
          </div>
        </div>
      </div>
    </ScrollView>
  )
}

function statusLabel(language: ReturnType<typeof useLanguage>, status: SemanticStatusInfo["status"] | undefined) {
  if (!status) return language.t("common.loading")
  if (status === "disabled") return language.t("settings.semantic.status.disabled")
  if (status === "idle") return language.t("settings.semantic.status.idle")
  if (status === "starting") return language.t("settings.semantic.status.starting")
  if (status === "indexing") return language.t("settings.semantic.status.indexing")
  if (status === "ready") return language.t("settings.semantic.status.ready")
  return language.t("settings.semantic.status.failed")
}

function errorMessage(value: unknown) {
  if (value instanceof Error) return value.message
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message
  return undefined
}