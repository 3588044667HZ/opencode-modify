import type { PackManifest } from "./manifest.js"

export type InstalledPack = {
  manifest: PackManifest
  source: string
  target: string
  installedAt: number
}

export type PackStore = {
  list(): Promise<InstalledPack[]>
  get(id: string): Promise<InstalledPack | undefined>
  put(pack: InstalledPack): Promise<void>
  remove(id: string): Promise<void>
  enabled(scope: string): Promise<string[]>
  setEnabled(scope: string, ids: string[]): Promise<void>
  config(scope: string, id: string): Promise<unknown>
  setConfig(scope: string, id: string, config: unknown): Promise<void>
  data(packId: string, scope: string, key: string): Promise<unknown>
  setData(packId: string, scope: string, key: string, value: unknown): Promise<void>
  deleteData(packId: string, scope: string, key: string): Promise<void>
  clearData(packId: string): Promise<void>
}

export class MemoryPackStore implements PackStore {
  private packs = new Map<string, InstalledPack>()
  private scopes = new Map<string, string[]>()
  private configs = new Map<string, Map<string, unknown>>()
  private dataStore = new Map<string, Map<string, unknown>>()

  async list() {
    return [...this.packs.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
  }

  async get(id: string) {
    return this.packs.get(id)
  }

  async put(pack: InstalledPack) {
    this.packs.set(pack.manifest.id, pack)
  }

  async remove(id: string) {
    this.packs.delete(id)
    for (const [scope, ids] of this.scopes) {
      this.scopes.set(scope, ids.filter((item) => item !== id))
    }
    for (const configs of this.configs.values()) configs.delete(id)
    this.dataStore.delete(id)
  }

  async enabled(scope: string) {
    return [...(this.scopes.get(scope) ?? [])]
  }

  async setEnabled(scope: string, ids: string[]) {
    this.scopes.set(scope, [...new Set(ids)].filter((id) => this.packs.has(id)).sort())
  }

  async config(scope: string, id: string) {
    return this.configs.get(scope)?.get(id)
  }

  async setConfig(scope: string, id: string, config: unknown) {
    const scoped = this.configs.get(scope) ?? new Map<string, unknown>()
    scoped.set(id, config)
    this.configs.set(scope, scoped)
  }

  async data(packId: string, scope: string, key: string) {
    return this.dataStore.get(packId)?.get(`${scope}\u0000${key}`)
  }

  async setData(packId: string, scope: string, key: string, value: unknown) {
    const data = this.dataStore.get(packId) ?? new Map<string, unknown>()
    data.set(`${scope}\u0000${key}`, value)
    this.dataStore.set(packId, data)
  }

  async deleteData(packId: string, scope: string, key: string) {
    this.dataStore.get(packId)?.delete(`${scope}\u0000${key}`)
  }

  async clearData(packId: string) {
    this.dataStore.delete(packId)
  }
}
