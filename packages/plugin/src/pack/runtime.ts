import { isAbsolute, relative, resolve } from "node:path"
import { spawnPlugin, type PluginProcess } from "../ipc/process.js"
import type { InstalledPack } from "./store.js"
import type { LifecycleReason } from "../ipc/lifecycle.js"

export type PackRuntimeContext = {
  scope: string
  project?: { id?: string; directory?: string }
  config?: unknown
}

export type PackRuntimeHandle = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  unmount(reason?: LifecycleReason): Promise<void>
  remove(): Promise<void>
}

export type PackRuntime = {
  mount(pack: InstalledPack, context: PackRuntimeContext): Promise<PackRuntimeHandle>
}

export type ProcessPackRuntimeOptions = {
  command?: string
  env?: NodeJS.ProcessEnv
  stopTimeoutMs?: number
  lifecycleTimeoutMs?: number
  maxMessageBytes?: number
  onStderr?: (chunk: string) => void
}

export class ProcessPackRuntime implements PackRuntime {
  constructor(private readonly options: ProcessPackRuntimeOptions = {}) {}

  async mount(pack: InstalledPack, context: PackRuntimeContext): Promise<PackRuntimeHandle> {
    const manifest = pack.manifest
    if (!manifest.command && !manifest.entry) {
      return {
        call: () => Promise.reject(new Error(`Pack ${manifest.id} has no runtime entry`)),
        unmount: async () => undefined,
        remove: async () => undefined,
      }
    }
    const command = this.options.command ?? manifest.command?.[0] ?? process.execPath
    const args = manifest.command ? manifest.command.slice(1) : [entryPath(pack)]
    let plugin: PluginProcess | undefined
    try {
      plugin = await spawnPlugin({
        command,
        args,
        cwd: pack.target,
        env: this.options.env,
        pluginId: manifest.id,
        lifecycleTimeoutMs: this.options.lifecycleTimeoutMs,
        stopTimeoutMs: this.options.stopTimeoutMs,
        maxMessageBytes: this.options.maxMessageBytes,
        onStderr: this.options.onStderr,
      })
      await plugin.mount({
        scope: context.scope,
        project: context.project,
        config: context.config,
        capabilities: [],
      })
    } catch (error) {
      await plugin?.stop({ force: true })
      throw error
    }
    const active = plugin
    let closed = false
    return {
      call<T = unknown>(method: string, params?: unknown) {
        if (closed) return Promise.reject(new Error(`Pack ${manifest.id} is not mounted`))
        return active.peer.request<T>(method, params)
      },
      async unmount(reason: LifecycleReason = "disable") {
        if (closed) return
        closed = true
        let failure: unknown
        try {
          await active.unmount(reason)
        } catch (error) {
          failure = error
        } finally {
          await active.stop({ force: true })
        }
        if (failure) throw failure
      },
      async remove() {
        if (closed) return
        closed = true
        let failure: unknown
        try {
          await active.remove()
        } catch (error) {
          failure = error
        } finally {
          await active.stop({ force: true })
        }
        if (failure) throw failure
      },
    }
  }
}

function entryPath(pack: InstalledPack) {
  const root = resolve(pack.target)
  const entry = resolve(root, pack.manifest.entry!)
  const rel = relative(root, entry)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Pack ${pack.manifest.id} entry escapes its target directory`)
  }
  return entry
}

