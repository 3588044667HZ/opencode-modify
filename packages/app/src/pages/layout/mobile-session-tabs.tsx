import { For, Show, createEffect, createMemo, createResource } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { tabHref, tabKey, useTabs, type Tab } from "@/context/tabs"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"

function TabAvatar(props: { tab: Tab; directory?: string }) {
  return (
    <Show
      when={props.tab.type === "session" ? props.tab : undefined}
      fallback={<IconV2 name="edit" size="small" class="text-icon-weak" />}
    >
      {(tab) => (
        <Show when={props.directory} fallback={<IconV2 name="folder" size="small" class="text-icon-weak" />}>
          {(directory) => (
            <SessionTabAvatar directory={directory()} server={tab().server} sessionId={tab().sessionId} />
          )}
        </Show>
      )}
    </Show>
  )
}

function MobileSessionTabRow(props: { tab: Tab; active: boolean; onNavigate: () => void; onClose: () => void }) {
  const tabs = useTabs()
  const global = useGlobal()
  const language = useLanguage()
  const key = tabKey(props.tab)
  const serverCtx = createMemo(() => {
    if (props.tab.type !== "session") return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.tab.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const cached = createMemo(() => {
    if (props.tab.type !== "session") return
    return serverCtx()?.sync.session.peek(props.tab.sessionId)
  })
  const [loaded] = createResource(
    () => {
      if (props.tab.type !== "session") return
      const ctx = serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : undefined
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cached() ?? loaded())
  const title = createMemo(() => {
    if (props.tab.type === "draft") return language.t("command.session.new")
    return session()?.title || tabs.info[key]?.title || language.t("session.tab.unknown")
  })
  const directory = createMemo(() =>
    props.tab.type === "session" ? (session()?.directory ?? tabs.info[key]?.directory) : undefined,
  )

  createEffect(() => {
    const value = session()
    if (!value || props.tab.type !== "session") return
    tabs.rememberSessionInfo(props.tab, value)
  })

  return (
    <div class="flex min-w-0 items-center gap-1 rounded-md" role="listitem">
      <a
        href={tabHref(props.tab)}
        data-active={props.active ? "" : undefined}
        aria-current={props.active ? "page" : undefined}
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-14-regular text-text-strong hover:bg-surface-raised-base-hover data-[active]:bg-surface-base-active"
        onClick={(event) => {
          event.preventDefault()
          tabs.select(props.tab)
          props.onNavigate()
        }}
      >
        <span class="flex size-4 shrink-0 items-center justify-center">
          <TabAvatar tab={props.tab} directory={directory()} />
        </span>
        <span class="min-w-0 flex-1 truncate">{title()}</span>
      </a>
      <IconButtonV2
        size="small"
        variant="ghost-muted"
        icon={<IconV2 name="xmark-small" />}
        aria-label={language.t("common.closeTab")}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }}
      />
    </div>
  )
}

export function MobileSessionTabs(props: { onNavigate?: () => void; class?: string }) {
  const tabs = useTabs()
  const location = useLocation()
  const current = createMemo(() => `${location.pathname}${location.search}`)

  return (
    <Show when={tabs.store.length > 0}>
      <div class={`flex flex-col gap-0.5 ${props.class ?? ""}`} role="list">
        <For each={tabs.store}>
          {(tab) => {
            const key = tabKey(tab)
            return (
              <MobileSessionTabRow
                tab={tab}
                active={current() === tabHref(tab)}
                onNavigate={() => props.onNavigate?.()}
                onClose={() => {
                  const index = tabs.store.findIndex((item) => tabKey(item) === key)
                  if (index !== -1) tabs.closeTab(index)
                }}
              />
            )
          }}
        </For>
      </div>
    </Show>
  )
}
