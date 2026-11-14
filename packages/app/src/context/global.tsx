import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects, RECENTLY_CLOSED_DISPLAY_LIMIT, ServerConnection, useServer } from "./server"
import { pathKey } from "@/utils/path-key"
import { useServerHealth } from "@/utils/server-health"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import { getOwner } from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import { authTokenFromCredentials } from "@/utils/server"
import { recentSessionDirectories } from "./global-sync/session-projects"

export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
  name: "Global",
  init: () => {
    const server = useServer()
    const serverHealth = useServerHealth(
      () => server.list,
      () => true,
    )
    const [store, setStore] = createStore({
      settings: {
        serverKey: undefined as ServerConnection.Key | undefined,
      },
    })

    const settingsServer = createMemo(() => {
      const list = server.list
      return list.find((conn) => ServerConnection.key(conn) === store.settings.serverKey) ?? list[0]
    })

    createEffect(() => {
      const conn = settingsServer()
      const key = conn ? ServerConnection.key(conn) : undefined
      if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
    })

    const serverCtxs = new Map<
      ServerConnection.Key,
      { dispose: () => void; serverCtx: ReturnType<typeof createServerCtx> }
    >()

    const owner = getOwner()

    const ensureServerCtx = (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      const existing = serverCtxs.get(key)
      if (existing) return existing.serverCtx
      const root = createRoot((dispose) => {
        const serverCtx = createServerCtx(conn, server.scope(key), server.projects.forServer(key))
        return { dispose, serverCtx }
      }, owner as any)
      serverCtxs.set(key, root)
      return root.serverCtx
    }

    createMemo(() => {
      for (const conn of server.list) {
        ensureServerCtx(conn)
      }
    })

    createEffect(() => {
      for (const [key] of serverCtxs) {
        if (!server.list.find((conn) => ServerConnection.key(conn) === key)) {
          const { dispose } = serverCtxs.get(key)!
          dispose()
          serverCtxs.delete(key)
        }
      }
    })

    return {
      servers: {
        list: () => server.list,
        health: serverHealth,
      },
      settings: {
        server: {
          get key() {
            return store.settings.serverKey
          },
          selected: settingsServer,
          set(key: ServerConnection.Key) {
            if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
          },
        },
      },
      ensureServerCtx(conn: ServerConnection.Any) {
        return ensureServerCtx(conn)
      },
    }
  },
})

async function loadLanProjects(conn: ServerConnection.Http) {
  const headers = conn.http.password
    ? {
        authorization: `Basic ${authTokenFromCredentials({
          username: conn.http.username,
          password: conn.http.password,
        })}`,
      }
    : undefined
  const response = await fetch(new URL("/__cockpit/projects", conn.http.url), { headers })
  if (!response.ok) return
  const body = (await response.json()) as { directories?: unknown; lastProject?: unknown }
  if (!Array.isArray(body.directories)) return
  return {
    directories: body.directories.filter((item): item is string => typeof item === "string" && !!item),
    lastProject: typeof body.lastProject === "string" ? body.lastProject : undefined,
  }
}

function createServerCtx(
  conn: ServerConnection.Any,
  scope: ServerScope,
  projects: ReturnType<typeof createServerProjects>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  const sdk = createServerSdkContext(conn, scope)
  const sync = createServerSyncContext(sdk)

  function enrich(project: { worktree: string; expanded: boolean }) {
    // Do not create a child store just to render the project list. A phone with
    // dozens of projects would otherwise hydrate dozens of stores on first paint.
    const childStore = sync.hasChild(project.worktree)
      ? sync.child(project.worktree, { bootstrap: false })[0]
      : undefined
    const projectID = childStore?.project
    const metadata = projectID
      ? sync.data.project.find((x) => x.id === projectID)
      : sync.data.project.find((x) => x.worktree === project.worktree || x.sandboxes?.includes(project.worktree))

    // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
    // Without this, different subdirectories of the same git repo would share the same
    // icon from the database instead of using their individual overrides.
    const base = { ...metadata, ...project }
    if (childStore?.icon) {
      return { ...base, icon: { ...base.icon, override: childStore.icon } }
    }
    return base
  }

  const isLocal =
    (conn?.type === "sidecar" && conn.variant === "base") || (conn?.type === "http" && isLocalHost(conn.http.url))
  // Merge the server project list into the local list. A fresh browser (e.g. a
  // phone opening the LAN URL) starts empty, while a desktop may have a stale
  // or partial persisted list. Respect recently-closed entries so closing a
  // project does not immediately re-add it.
  createEffect(() => {
    if (!sync.data.ready) return
    const closed = new Set(projects.recentlyClosed().map((worktree) => pathKey(worktree)))
    const existing = new Set(projects.list().map((project) => pathKey(project.worktree)))
    const candidates = sync.data.project
      .filter(
        (project) =>
          project.id !== "global" &&
          !!project.worktree &&
          !closed.has(pathKey(project.worktree)) &&
          !existing.has(pathKey(project.worktree)),
      )
      .sort((left, right) => left.time.updated - right.time.updated)
    if (candidates.length === 0) return
    batch(() => {
      for (const project of candidates) projects.open(project.worktree)
      projects.touch(candidates[candidates.length - 1]!.worktree)
    })
  })

  // The LAN proxy exposes the desktop's open-project list. Web/LAN clients have
  // no local project store, and the server only knows git projects, so merge the
  // desktop directories once the server project list is available.
  let lanProjectsRequested = false
  createEffect(() => {
    if (!sync.data.ready || lanProjectsRequested) return
    if (conn?.type !== "http") return
    lanProjectsRequested = true
    void loadLanProjects(conn)
      .then((state) => {
        if (!state) return
        const closed = new Set(projects.recentlyClosed().map((worktree) => pathKey(worktree)))
        const existing = new Set(projects.list().map((project) => pathKey(project.worktree)))
        const candidates = state.directories.filter(
          (directory) => !closed.has(pathKey(directory)) && !existing.has(pathKey(directory)),
        )
        if (candidates.length === 0) return
        batch(() => {
          // The desktop list is newest-first; open() prepends, so reverse it.
          for (const directory of candidates.slice().reverse()) projects.open(directory)
          if (state.lastProject && !closed.has(pathKey(state.lastProject))) projects.touch(state.lastProject)
        })
      })
      .catch(() => {})
  })

  // Headless servers group sessions from non-git directories under the single
  // `global` project, so /project cannot enumerate them. Seed known projects
  // from recent sessions for clients without a desktop-side project store.
  let sessionProjectsRequested = false
  createEffect(() => {
    if (!sync.data.ready || sessionProjectsRequested) return
    if (conn.type === "sidecar") return
    sessionProjectsRequested = true
    void sdk.client.v2.session
      .list({ limit: 200, order: "desc" })
      .then((result) => {
        const candidates = recentSessionDirectories({
          sessions: result.data?.data ?? [],
          projects: sync.data.project,
          recentlyClosed: projects.recentlyClosed(),
        })
        if (candidates.length === 0) return
        batch(() => {
          for (const directory of candidates.slice().reverse()) projects.open(directory)
          if (!projects.last()) projects.touch(candidates[0])
        })
      })
      .catch(() => {})
  })

  const projectsList = createMemo(() => projects.list().map(enrich))
  const recentlyClosedList = createMemo(() => {
    const known = new Set(sync.data.project.map((project) => pathKey(project.worktree)))
    return projects
      .recentlyClosed()
      .filter((worktree) => known.has(pathKey(worktree)))
      .slice(0, RECENTLY_CLOSED_DISPLAY_LIMIT)
      .map((worktree) => enrich({ worktree, expanded: false }))
  })

  return {
    queryClient,
    sdk,
    sync,
    isLocal,
    projects: {
      ...projects,
      list: projectsList,
      recentlyClosed: recentlyClosedList,
    },
  }
}

export type ServerCtx = ReturnType<typeof createServerCtx>

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}
