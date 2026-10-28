import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createComponent, createMemo, createRoot, getOwner } from "solid-js"
import { reconcile } from "solid-js/store"
import { createChildStoreManager } from "@/context/global-sync/child-store"
import { MAX_DIR_STORES } from "@/context/global-sync/types"
import type { QueryOptionsApi } from "@/context/server-sync"
import type { persisted } from "@/utils/persist"
import { ServerScope } from "@/utils/server-scope"

const directories = Array.from({ length: MAX_DIR_STORES + 10 }, (_, index) => `/project-${index}`)

const provider = { all: new Map(), connected: [], default: {} }

const queryOptions = {
  path: (directory: string) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({ state: "", config: "", worktree: directory, directory, home: "" }),
  }),
  mcp: (directory: string) => ({ queryKey: [directory, "mcp"], queryFn: async () => ({}) }),
  mcpResources: (directory: string) => ({ queryKey: [directory, "mcp-resources"], queryFn: async () => ({}) }),
  lsp: (directory: string) => ({ queryKey: [directory, "lsp"], queryFn: async () => [] }),
  providers: (directory: string) => ({ queryKey: [directory, "providers"], queryFn: async () => provider }),
  references: (directory: string) => ({ queryKey: [directory, "references"], queryFn: async () => [] }),
} as unknown as QueryOptionsApi

test("keeps project stores alive when a memo over more directories than the store limit re-runs", async () => {
  const created: string[] = []
  const hydrations: Promise<void>[] = []
  const limit = directories.length * 10

  const persist = ((target, store) => {
    const [state, setState] = store
    const key = typeof target === "string" ? target : target.key
    if (key === "workspace:project") created.push(key)
    const shouldHydrate = key === "workspace:project" && created.length <= limit
    const init = shouldHydrate
      ? Promise.resolve().then(() => {
          setState(reconcile({ value: { name: "stored" } }))
        })
      : Promise.resolve()
    if (key === "workspace:project") hydrations.push(init)
    return [state, setState, init, Object.assign(() => true, { promise: init })]
  }) as typeof persisted

  const root = createRoot((dispose) => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    createComponent(QueryClientProvider, {
      client: new QueryClient(),
      get children() {
        const owner = getOwner()
        if (!owner) throw new Error("owner required")
        manager = createChildStoreManager({
          owner,
          scope: ServerScope.local,
          persist,
          isBooting: () => false,
          isLoadingSessions: () => false,
          onBootstrap() {},
          onMcp() {},
          onDispose() {},
          translate: (key) => key,
          queryOptions,
          global: { provider },
        })
        return undefined
      },
    })

    if (!manager) throw new Error("manager required")
    const children = manager

    createMemo(() => directories.map((directory) => children.child(directory, { bootstrap: false })[0].projectMeta))

    return { manager: children, dispose }
  })

  try {
    while (hydrations.length > 0) await Promise.all(hydrations.splice(0))

    expect(created.filter((key) => key === "workspace:project")).toHaveLength(directories.length)
    expect(directories.map((directory) => root.manager.children[directory]?.[0].projectMeta?.name)).toEqual(
      directories.map(() => "stored"),
    )
  } finally {
    root.dispose()
  }
})
