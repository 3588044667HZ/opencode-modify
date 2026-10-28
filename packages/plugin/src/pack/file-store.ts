import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { InstalledPack, PackStore } from "./store.js"

type State = {
  packs: Record<string, InstalledPack>
  enabled: Record<string, string[]>
  config: Record<string, Record<string, unknown>>
}

const empty = (): State => ({ packs: {}, enabled: {}, config: {} })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

export class FilePackStore implements PackStore {
  private statePromise: Promise<State> | undefined

  constructor(readonly root: string) {}

  private state() {
    this.statePromise ??= this.load()
    return this.statePromise
  }

  private async load() {
    try {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- state.json is written by this store; missing fields are normalized below.
      const value = JSON.parse(await readFile(join(this.root, "state.json"), "utf8")) as Partial<State>
      return {
        packs: value.packs ?? {},
        enabled: value.enabled ?? {},
        config: value.config ?? {},
      }
    } catch (error) {
      if (isMissing(error)) return empty()
      throw error
    }
  }

  private async save(state: State) {
    await mkdir(this.root, { recursive: true })
    await writeFile(join(this.root, "state.json"), JSON.stringify(state, null, 2), "utf8")
  }

  private async dataPath(packId: string, scope: string, key: string) {
    const path = join(this.root, "data", encodeURIComponent(packId), encodeURIComponent(scope), `${encodeURIComponent(key)}.json`)
    return path
  }

  async list() {
    const state = await this.state()
    return Object.values(state.packs).sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
  }

  async get(id: string) {
    return (await this.state()).packs[id]
  }

  async put(pack: InstalledPack) {
    const state = await this.state()
    state.packs[pack.manifest.id] = pack
    await this.save(state)
  }

  async remove(id: string) {
    const state = await this.state()
    delete state.packs[id]
    for (const scope of Object.keys(state.enabled)) {
      const ids = state.enabled[scope]
      if (ids) state.enabled[scope] = ids.filter((item) => item !== id)
    }
    for (const scope of Object.keys(state.config)) {
      const config = state.config[scope]
      if (config) delete config[id]
    }
    await this.save(state)
    await this.clearData(id)
  }

  async enabled(scope: string) {
    return [...((await this.state()).enabled[scope] ?? [])]
  }

  async setEnabled(scope: string, ids: string[]) {
    const state = await this.state()
    state.enabled[scope] = [...new Set(ids)].filter((id) => state.packs[id]).sort()
    await this.save(state)
  }

  async config(scope: string, id: string) {
    return (await this.state()).config[scope]?.[id]
  }

  async setConfig(scope: string, id: string, config: unknown) {
    const state = await this.state()
    state.config[scope] = { ...state.config[scope], [id]: config }
    await this.save(state)
  }

  async data(packId: string, scope: string, key: string) {
    try {
      return JSON.parse(await readFile(await this.dataPath(packId, scope, key), "utf8"))
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async setData(packId: string, scope: string, key: string, value: unknown) {
    const path = await this.dataPath(packId, scope, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value), "utf8")
  }

  async deleteData(packId: string, scope: string, key: string) {
    await rm(await this.dataPath(packId, scope, key), { force: true })
  }

  async clearData(packId: string) {
    await rm(join(this.root, "data", encodeURIComponent(packId)), { recursive: true, force: true })
  }
}

