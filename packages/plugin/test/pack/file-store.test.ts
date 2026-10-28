import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FilePackStore } from "../../src/pack/file-store"
import { parsePackManifest } from "../../src/pack/manifest"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), "opencode-pack-store-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return new FilePackStore(root)
}

const pack = {
  manifest: parsePackManifest({ id: "a", version: "1.0.0" }),
  source: "test",
  target: "/packs/a",
  installedAt: 1,
}

describe("file pack store", () => {
  test("persists installed packs, enablement, config, and data", async () => {
    const first = await store()
    await first.put(pack)
    await first.setEnabled("project:a", ["a"])
    await first.setConfig("project:a", "a", { enabled: true })
    await first.setData("a", "project:a", "key", { value: 1 })

    const second = new FilePackStore(first.root)
    expect((await second.list()).map((item) => item.manifest.id)).toEqual(["a"])
    expect(await second.enabled("project:a")).toEqual(["a"])
    expect(await second.config("project:a", "a")).toEqual({ enabled: true })
    expect(await second.data("a", "project:a", "key")).toEqual({ value: 1 })
  })

  test("removes pack state and namespace data", async () => {
    const value = await store()
    await value.put(pack)
    await value.setEnabled("project:a", ["a"])
    await value.setConfig("project:a", "a", { enabled: true })
    await value.setData("a", "project:a", "key", { value: 1 })

    await value.remove("a")
    expect(await value.get("a")).toBeUndefined()
    expect(await value.enabled("project:a")).toEqual([])
    expect(await value.config("project:a", "a")).toBeUndefined()
    expect(await value.data("a", "project:a", "key")).toBeUndefined()
  })
})
