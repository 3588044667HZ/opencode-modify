import { ContributionLedger, type Contribution, type ContributionKind } from "./ledger.js"
import type { InstalledPack, PackStore } from "./store.js"
import type { PackRuntime, PackRuntimeHandle } from "./runtime.js"
import type { LifecycleReason } from "../ipc/lifecycle.js"

export type PackHostOptions = {
  store: PackStore
  runtime: PackRuntime
  scope: string
  project?: { id?: string; directory?: string }
  onError?: (packId: string, error: Error) => void
}

export type PackStatus = {
  pack: InstalledPack
  enabled: boolean
  mounted: boolean
  error?: string
}

export class PackHost {
  private ledger = new ContributionLedger()
  private mounted = new Map<string, PackRuntimeHandle>()
  private errors = new Map<string, string>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: PackHostOptions) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task, task)
    this.pending = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private fail(packId: string, error: unknown) {
    const value = error instanceof Error ? error : new Error(String(error))
    this.errors.set(packId, value.message)
    this.options.onError?.(packId, value)
    return value
  }

  private packContributions(pack: InstalledPack): Contribution[] {
    const scope = this.options.scope
    const contributes = pack.manifest.contributes ?? {}
    return [
      ...(contributes.tools ?? []).map((value) => ({
        packId: pack.manifest.id,
        scope,
        kind: "tool" as const,
        id: value.id,
        value,
      })),
      ...(contributes.agents ?? []).map((value) => ({
        packId: pack.manifest.id,
        scope,
        kind: "agent" as const,
        id: value.id,
        value,
      })),
      ...(contributes.prompts ?? []).map((value) => ({
        packId: pack.manifest.id,
        scope,
        kind: "prompt" as const,
        id: value.id,
        value,
      })),
      ...(contributes.rpc ?? []).map((value) => ({
        packId: pack.manifest.id,
        scope,
        kind: "rpc" as const,
        id: value.id,
        value,
      })),
      ...(contributes.ui ?? []).map((value) => ({
        packId: pack.manifest.id,
        scope,
        kind: "ui" as const,
        id: value.id,
        value,
      })),
    ]
  }

  private async mountPack(pack: InstalledPack) {
    if (this.mounted.has(pack.manifest.id)) return
    const handle = await this.options.runtime.mount(pack, {
      scope: this.options.scope,
      project: this.options.project,
      config: await this.options.store.config(this.options.scope, pack.manifest.id),
    })
    const disposers: Array<() => void> = []
    try {
      for (const contribution of this.packContributions(pack)) {
        disposers.push(this.ledger.add(contribution))
      }
      this.mounted.set(pack.manifest.id, handle)
      this.errors.delete(pack.manifest.id)
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      await handle.unmount().catch(() => undefined)
      throw error
    }
  }

  private async disposePack(packId: string, mode: "unmount" | "remove", reason?: LifecycleReason) {
    this.ledger.removePack(packId, this.options.scope)
    const handle = this.mounted.get(packId)
    this.mounted.delete(packId)
    if (!handle) return
    await (mode === "remove" ? handle.remove() : handle.unmount(reason))
  }

  install(pack: InstalledPack) {
    return this.run(async () => {
      if (this.mounted.has(pack.manifest.id)) throw new Error(`Pack ${pack.manifest.id} is mounted`)
      await this.options.store.put(pack)
      this.errors.delete(pack.manifest.id)
    })
  }

  setConfig(packId: string, config: unknown) {
    return this.run(async () => {
      const enabled = (await this.options.store.enabled(this.options.scope)).includes(packId)
      if (this.mounted.has(packId)) await this.disposePack(packId, "unmount", "reload")
      await this.options.store.setConfig(this.options.scope, packId, config)
      if (!enabled) return
      const pack = await this.options.store.get(packId)
      if (!pack) throw new Error(`Pack not installed: ${packId}`)
      await this.mountPack(pack)
    })
  }

  enable(packId: string, config?: unknown) {
    return this.run(async () => {
      const pack = await this.options.store.get(packId)
      if (!pack) throw new Error(`Pack not installed: ${packId}`)
      if (config !== undefined) await this.options.store.setConfig(this.options.scope, packId, config)
      if (!this.mounted.has(packId)) {
        try {
          await this.mountPack(pack)
        } catch (error) {
          throw this.fail(packId, error)
        }
      }
      const enabled = await this.options.store.enabled(this.options.scope)
      if (!enabled.includes(packId)) {
        try {
          await this.options.store.setEnabled(this.options.scope, [...enabled, packId])
        } catch (error) {
          await this.disposePack(packId, "unmount", "disable").catch(() => undefined)
          throw error
        }
      }
    })
  }

  disable(packId: string) {
    return this.run(async () => {
      let failure: Error | undefined
      try {
        await this.disposePack(packId, "unmount", "disable")
      } catch (error) {
        failure = this.fail(packId, error)
      }
      const enabled = await this.options.store.enabled(this.options.scope)
      await this.options.store.setEnabled(
        this.options.scope,
        enabled.filter((id) => id !== packId),
      )
      if (failure) throw failure
    })
  }

  mount() {
    return this.run(async () => {
      const enabled = await this.options.store.enabled(this.options.scope)
      for (const packId of enabled) {
        if (this.mounted.has(packId)) continue
        const pack = await this.options.store.get(packId)
        if (!pack) continue
        try {
          await this.mountPack(pack)
        } catch (error) {
          this.fail(packId, error)
        }
      }
    })
  }

  unmount() {
    return this.run(async () => {
      const ids = [...this.mounted.keys()]
      let failure: Error | undefined
      for (const packId of ids) {
        try {
          await this.disposePack(packId, "unmount", "shutdown")
        } catch (error) {
          failure ??= this.fail(packId, error)
        }
      }
      if (failure) throw failure
    })
  }

  reload() {
    return this.run(async () => {
      const ids = [...this.mounted.keys()]
      for (const packId of ids) await this.disposePack(packId, "unmount", "reload")
      const enabled = await this.options.store.enabled(this.options.scope)
      for (const packId of enabled) {
        const pack = await this.options.store.get(packId)
        if (!pack) continue
        try {
          await this.mountPack(pack)
        } catch (error) {
          this.fail(packId, error)
        }
      }
    })
  }

  uninstall(packId: string) {
    return this.run(async () => {
      const enabled = await this.options.store.enabled(this.options.scope)
      await this.options.store.setEnabled(
        this.options.scope,
        enabled.filter((id) => id !== packId),
      )
      let failure: Error | undefined
      try {
        await this.disposePack(packId, "remove")
      } catch (error) {
        failure = this.fail(packId, error)
      }
      try {
        await this.options.store.remove(packId)
      } catch (error) {
        failure ??= this.fail(packId, error)
      }
      this.errors.delete(packId)
      if (failure) throw failure
    })
  }

  list(): Promise<PackStatus[]> {
    return this.run(async () => {
      const installed = await this.options.store.list()
      const enabled = new Set(await this.options.store.enabled(this.options.scope))
      return installed.map((pack) => ({
        pack,
        enabled: enabled.has(pack.manifest.id),
        mounted: this.mounted.has(pack.manifest.id),
        error: this.errors.get(pack.manifest.id),
      }))
    })
  }

  contributions(kind?: ContributionKind) {
    return this.ledger.list(this.options.scope, kind)
  }

  snapshot() {
    return this.ledger.snapshot()
  }

  call<T = unknown>(packId: string, method: string, params?: unknown) {
    const handle = this.mounted.get(packId)
    if (!handle) return Promise.reject(new Error(`Pack not mounted: ${packId}`))
    return handle.call<T>(method, params)
  }
}
