import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { Splash } from "@opencode-ai/ui/logo"
import { For, Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { BlackboardPanel, PeerInboxPanel, TeamPanel } from "@/components/agent-teams-panels"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { SDKProvider } from "@/context/sdk"
import { authTokenFromCredentials } from "@/utils/server"
import {
  agentTeamsViews,
  isAgentTeamsView,
  requireServerKey,
  sessionHref,
  type AgentTeamsView,
} from "@/utils/session-route"

const tabKeys: Record<AgentTeamsView, "agentTeams.tab.blackboard" | "agentTeams.tab.inbox" | "agentTeams.tab.team"> = {
  blackboard: "agentTeams.tab.blackboard",
  inbox: "agentTeams.tab.inbox",
  team: "agentTeams.tab.team",
}

const titleKeys: Record<
  AgentTeamsView,
  "dialog.blackboard.title" | "dialog.peerInbox.title" | "dialog.team.title"
> = {
  blackboard: "dialog.blackboard.title",
  inbox: "dialog.peerInbox.title",
  team: "dialog.team.title",
}

const descriptionKeys: Record<
  AgentTeamsView,
  "dialog.blackboard.description" | "dialog.peerInbox.description" | "dialog.team.description"
> = {
  blackboard: "dialog.blackboard.description",
  inbox: "dialog.peerInbox.description",
  team: "dialog.team.description",
}

/**
 * Standalone agent-teams page. The desktop app opens it in its own window via
 * `Platform.openAppWindow` so the blackboard/inbox/team panels do not cover the
 * session being worked on.
 */
export function AgentTeamsPage() {
  const params = useParams<{ serverKey: string; id: string }>()
  const serverSDK = useServerSDK()
  const [session] = createResource(
    () => params.id,
    (sessionID) => serverSDK().client.session.get({ sessionID }).then((result) => result.data),
  )
  const directory = createMemo(() => session()?.directory)

  return (
    <div class="relative size-full overflow-hidden flex flex-col p-2">
      <div class="flex-1 min-h-0 flex flex-col bg-v2-background-bg-base rounded-[10px] overflow-hidden">
        <Show
          when={directory()}
          fallback={
            <div class="flex-1 min-h-0 flex items-center justify-center">
              <Splash class="w-12 h-15 opacity-50 animate-pulse" />
            </div>
          }
        >
          {(dir) => (
            <SDKProvider directory={dir}>
              <AgentTeamsView sessionID={params.id} title={() => session()?.title} />
            </SDKProvider>
          )}
        </Show>
      </div>
    </div>
  )
}

function AgentTeamsView(props: { sessionID: string; title: () => string | undefined }) {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const server = useServer()
  const navigate = useNavigate()
  const params = useParams<{ serverKey: string }>()
  const [search, setSearch] = useSearchParams<{ view?: string }>()
  const view = () => (isAgentTeamsView(search.view) ? search.view : "blackboard")
  const guiBuild = import.meta.env.OPENCODE_BUILD_ID ?? "local"
  // 每次挂载只取一次服务端 Build ID：优先走类型化客户端，生成类型可能剥掉
  // build 字段，失败时回退到带 Basic Auth 的原始请求。
  const [serverBuild] = createResource(async (): Promise<string | undefined> => {
    try {
      const result = await serverSDK().client.global.health()
      const data: unknown = result.data
      if (typeof data === "object" && data !== null && "build" in data && typeof data.build === "string") return data.build
    } catch {}
    const http = server.current?.http
    if (!http) return undefined
    try {
      const response = await (platform.fetch ?? globalThis.fetch)(`${http.url}/global/health`, {
        headers: http.password
          ? { Authorization: `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}` }
          : undefined,
      })
      if (!response.ok) return undefined
      const data: unknown = await response.json()
      if (typeof data !== "object" || data === null || !("build" in data)) return undefined
      return typeof data.build === "string" ? data.build : undefined
    } catch {}
    return undefined
  })
  const buildMismatch = createMemo(() => {
    const build = serverBuild()
    return build !== undefined && build !== guiBuild
  })
  const stop = platform.onAppWindowView?.((next) => {
    if (isAgentTeamsView(next)) setSearch({ view: next })
  })
  // Member rows open the subagent session in its own window (web falls back to
  // in-window navigation).
  const openMember = (sessionID: string) => {
    const route = sessionHref(requireServerKey(params.serverKey), sessionID)
    if (platform.openAppWindow) {
      void platform.openAppWindow({ route })
      return
    }
    navigate(route)
  }
  // Desktop mirrors document.title to the native window title, so a dedicated
  // window never looks like another plain session window in the taskbar.
  const previousTitle = typeof document === "object" ? document.title : undefined
  createEffect(() => {
    const title = props.title()
    document.title = title ? language.t("agentTeams.windowTitle", { title }) : language.t("agentTeams.title")
  })
  onCleanup(() => {
    if (previousTitle !== undefined) document.title = previousTitle
    stop?.()
  })

  return (
    <>
      <header class="flex items-center gap-3 px-4 py-3 border-b border-border-weak-base">
        <div class="flex flex-col min-w-0">
          <span class="text-14-medium text-text-strong">{language.t("agentTeams.title")}</span>
          <Show when={props.title()}>
            {(title) => <span class="text-12-regular text-text-weak truncate">{title()}</span>}
          </Show>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <For each={agentTeamsViews}>
            {(item) => (
              <button
                type="button"
                class="rounded-md px-2.5 py-1 text-12-medium transition-colors"
                classList={{
                  "bg-surface-raised-base-hover text-text-strong": view() === item,
                  "text-text-weak hover:text-text-strong": view() !== item,
                }}
                onClick={() => setSearch({ view: item })}
              >
                {language.t(tabKeys[item])}
              </button>
            )}
          </For>
        </div>
        <span class="text-11-regular text-text-weaker shrink-0">
          {language.t("agentTeams.build", { build: guiBuild })}
        </span>
      </header>
      <Show when={buildMismatch()}>
        <div class="px-4 py-2 border-b border-v2-state-border-warning bg-v2-state-bg-warning text-12-regular text-v2-state-fg-warning">
          {language.t("agentTeams.build.mismatch", { gui: guiBuild, server: serverBuild() ?? "" })}
        </div>
      </Show>
      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        <div class="flex flex-col gap-1 pb-3">
          <span class="text-13-medium text-text-strong">{language.t(titleKeys[view()])}</span>
          <span class="text-12-regular text-text-weak">{language.t(descriptionKeys[view()])}</span>
        </div>
        <Show when={view() === "blackboard"}>
          <BlackboardPanel sessionID={props.sessionID} />
        </Show>
        <Show when={view() === "inbox"}>
          <PeerInboxPanel sessionID={props.sessionID} />
        </Show>
        <Show when={view() === "team"}>
          <TeamPanel sessionID={props.sessionID} onOpen={openMember} />
        </Show>
      </div>
    </>
  )
}
