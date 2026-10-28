import { createPeer, type Peer, type PeerOptions } from "./peer.js"
import { ErrorCodes, IpcError, isRecord } from "./protocol.js"
import type { Transport } from "./transport.js"

export type LifecycleReason = "disable" | "reload" | "shutdown" | "uninstall"

export type LifecycleContext = {
  pluginId: string
  scope?: string
  project?: { id?: string; directory?: string }
  config?: unknown
  reason?: LifecycleReason
}

export type MountContext = LifecycleContext & {
  effect(cleanup: Cleanup): () => void
}

export type Cleanup = () => void | Promise<void>

export type LifecycleHandlers = {
  onMount?: (context: MountContext) => Cleanup | void | Promise<Cleanup | void>
  onUnmount?: (context: LifecycleContext) => void | Promise<void>
  onDelete?: (context: LifecycleContext) => void | Promise<void>
}

export type PluginPeerOptions = PeerOptions & {
  protocol?: number
  pluginId?: string
  version?: string
  token?: string
}

export type PluginPeer = {
  peer: Peer
  readonly mounted: boolean
  readonly deleted: boolean
}

const reasons: LifecycleReason[] = ["disable", "reload", "shutdown", "uninstall"]

function context(value: unknown, fallback?: LifecycleReason): LifecycleContext {
  const input = isRecord(value) ? value : {}
  const project = isRecord(input.project)
    ? {
        id: typeof input.project.id === "string" ? input.project.id : undefined,
        directory: typeof input.project.directory === "string" ? input.project.directory : undefined,
      }
    : undefined
  const reason = reasons.find((item) => item === input.reason) ?? fallback
  return {
    pluginId: typeof input.pluginId === "string" ? input.pluginId : "plugin",
    scope: typeof input.scope === "string" ? input.scope : undefined,
    project,
    config: input.config,
    reason,
  }
}

async function run(cleanups: Cleanup[]) {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
}

export function createPluginPeer(
  transport: Transport,
  handlers: LifecycleHandlers = {},
  options: PluginPeerOptions = {},
): PluginPeer {
  const peer = createPeer(transport, options)
  let cleanups: Cleanup[] = []
  let mounted = false
  let deleted = false
  const protocol = options.protocol ?? 1
  const expectedToken =
    options.token ?? (typeof process !== "undefined" ? process.env.OPENCODE_PACK_TOKEN : undefined)

  peer.onRequest("initialize", (params) => {
    if (!isRecord(params) || params.protocol !== protocol) {
      throw new IpcError(ErrorCodes.InvalidRequest, "IPC protocol version mismatch")
    }
    if (expectedToken !== undefined && params.token !== expectedToken) {
      throw new IpcError(ErrorCodes.InvalidRequest, "Invalid IPC token")
    }
    return {
      protocol,
      pluginId: options.pluginId ?? "plugin",
      version: options.version,
    }
  })

  const unmount = async (context: LifecycleContext) => {
    if (!mounted) return
    let failure: unknown
    try {
      await handlers.onUnmount?.(context)
    } catch (error) {
      failure = error
    } finally {
      try {
        await run(cleanups)
      } finally {
        mounted = false
      }
    }
    if (failure) throw failure
  }

  peer.onRequest("onMount", async (params) => {
    if (deleted) throw new Error("Plugin has been deleted")
    if (mounted) return { mounted: true }
    const mountContext: MountContext = {
      ...context(params),
      effect(cleanup) {
        cleanups.push(cleanup)
        return () => {
          cleanups = cleanups.filter((item) => item !== cleanup)
        }
      },
    }
    try {
      const cleanup = await handlers.onMount?.(mountContext)
      if (cleanup) cleanups.push(cleanup)
      mounted = true
      return { mounted: true }
    } catch (error) {
      await run(cleanups).catch(() => undefined)
      throw error
    }
  })

  peer.onRequest("onUnmount", async (params) => {
    await unmount(context(params))
    return { mounted: false }
  })

  peer.onRequest("onDelete", async (params) => {
    if (deleted) return { deleted: true }
    const deleteContext = context(params, "uninstall")
    await unmount(deleteContext)
    await handlers.onDelete?.(deleteContext)
    deleted = true
    return { deleted: true }
  })

  return {
    peer,
    get mounted() {
      return mounted
    },
    get deleted() {
      return deleted
    },
  }
}
