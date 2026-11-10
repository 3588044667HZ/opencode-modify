import { createEffect, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useTabs } from "@/context/tabs"
import { MobileSessionTabs } from "@/pages/layout/mobile-session-tabs"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))

  createEffect(() => {
    if (tabs.store.length > 0) return
    layout.mobileSidebar.hide()
  })

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <Show when={layout.mobileSidebar.opened() && tabs.store.length > 0}>
        <div class="fixed inset-0 z-50 xl:hidden">
          <div
            class="absolute inset-0 bg-v2-overlay-simple-overlay-scrim backdrop-blur-[2px]"
            onClick={() => layout.mobileSidebar.hide()}
          />
          <nav
            aria-label={language.t("session.tab.session")}
            class="absolute inset-y-0 start-0 flex w-full max-w-[320px] flex-col border-e border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)]"
            style={{
              "padding-top": "env(safe-area-inset-top, 0px)",
              "padding-bottom": "env(safe-area-inset-bottom, 0px)",
            }}
          >
            <div class="flex h-12 shrink-0 items-center justify-between border-b border-v2-border-border-muted px-3">
              <span class="text-[13px] font-[530] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
                {language.t("session.tab.session")}
              </span>
              <IconButtonV2
                size="small"
                variant="ghost-muted"
                icon={<IconV2 name="xmark-small" />}
                aria-label={language.t("common.close")}
                onClick={() => layout.mobileSidebar.hide()}
              />
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto no-scrollbar p-2">
              <MobileSessionTabs class="w-full" onNavigate={() => layout.mobileSidebar.hide()} />
            </div>
          </nav>
        </div>
      </Show>
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
