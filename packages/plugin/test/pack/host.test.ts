import { describe, expect, test } from "bun:test"
import { PackHost } from "../../src/pack/host"
import { parsePackManifest } from "../../src/pack/manifest"
import { MemoryPackStore, type InstalledPack } from "../../src/pack/store"
import type { PackRuntime, PackRuntimeHandle } from "../../src/pack/runtime"

class FakeRuntime implements PackRuntime {
  readonly mounted: string[] = []
  readonly unmounted: string[] = []
  readonly unmountReasons: Array<string | undefined> = []
  readonly removed: string[] = []
  readonly failures = new Set<string>()
  readonly unmountFailures = new Set<string>()
  readonly removeFailures = new Set<string>()

  async mount(pack: InstalledPack): Promise<PackRuntimeHandle> {
    if (this.failures.has(pack.manifest.id)) throw new Error(`mount failed: ${pack.manifest.id}`)
    this.mounted.push(pack.manifest.id)
    return {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fake runtime returns a typed test fixture.
      call: async <T>(method: string, params?: unknown) => ({ method, params }) as T,
      unmount: async (reason?: string) => {
        this.unmounted.push(pack.manifest.id)
        this.unmountReasons.push(reason)
        if (this.unmountFailures.has(pack.manifest.id)) throw new Error(`unmount failed: ${pack.manifest.id}`)
      },
      remove: async () => {
        this.removed.push(pack.manifest.id)
        if (this.removeFailures.has(pack.manifest.id)) throw new Error(`remove failed: ${pack.manifest.id}`)
      },
    }
  }
}

function pack(id: string, tools: string[] = []): InstalledPack {
  return {
    manifest: parsePackManifest({
      id,
      version: "1.0.0",
      entry: "plugin.js",
      contributes: {
        tools: tools.map((tool) => ({ id: tool, description: tool })),
      },
    }),
    source: "test",
    target: `/packs/${id}`,
    installedAt: 0,
  }
}

function setup(scope = "project:a") {
  const store = new MemoryPackStore()
  const runtime = new FakeRuntime()
  const host = new PackHost({ store, runtime, scope })
  return { store, runtime, host }
}

describe("pack host", () => {
  test("installs, enables, disables, remounts, and uninstalls with cleanup", async () => {
    const { store, runtime, host } = setup()
    await host.install(pack("a", ["a.one"]))
    await host.enable("a")

    expect(runtime.mounted).toEqual(["a"])
    expect(host.contributions("tool").map((item) => item.id)).toEqual(["a.one"])

    await store.setData("a", "project:a", "key", { value: 1 })
    await host.disable("a")
    expect(runtime.unmounted).toEqual(["a"])
    expect(host.contributions()).toHaveLength(0)
    expect(await store.enabled("project:a")).toEqual([])

    await host.enable("a")
    expect(runtime.mounted).toEqual(["a", "a"])

    await host.uninstall("a")
    expect(runtime.removed).toEqual(["a"])
    expect(host.contributions()).toHaveLength(0)
    expect(await store.get("a")).toBeUndefined()
    expect(await store.data("a", "project:a", "key")).toBeUndefined()
  })

  test("uses reload and shutdown reasons for runtime unmounts", async () => {
    const { runtime, host } = setup()
    await host.install(pack("a"))
    await host.enable("a")
    await host.reload()
    await host.unmount()
    expect(runtime.unmountReasons).toEqual(["reload", "shutdown"])
  })

  test("keeps enabled packs when the host is unmounted and remounted", async () => {
    const { runtime, host } = setup()
    await host.install(pack("a"))
    await host.enable("a")
    await host.unmount()
    expect(runtime.unmounted).toEqual(["a"])
    await host.mount()
    expect(runtime.mounted).toEqual(["a", "a"])
  })

  test("rejects conflicting contributions without activating the second pack", async () => {
    const { runtime, host } = setup()
    await host.install(pack("a", ["shared"]))
    await host.install(pack("b", ["shared"]))
    await host.enable("a")

    await expect(host.enable("b")).rejects.toThrow("already owned by a")
    expect(runtime.mounted).toEqual(["a", "b"])
    expect(runtime.unmounted).toEqual(["b"])
    expect(host.contributions("tool").map((item) => item.packId)).toEqual(["a"])
    expect((await host.list()).find((item) => item.pack.manifest.id === "b")?.enabled).toBe(false)
  })

  test("does not leave contributions or enablement when mount fails", async () => {
    const { runtime, host } = setup()
    runtime.failures.add("broken")
    await host.install(pack("broken", ["broken.one"]))

    await expect(host.enable("broken")).rejects.toThrow("mount failed")
    expect(host.contributions()).toHaveLength(0)
    expect((await host.list()).find((item) => item.pack.manifest.id === "broken")?.enabled).toBe(false)
  })

  test("clears ledger and installation state even when runtime cleanup fails", async () => {
    const { store, runtime, host } = setup()
    await host.install(pack("a", ["a.one"]))
    await host.enable("a")
    await store.setData("a", "project:a", "key", { value: 1 })
    runtime.removeFailures.add("a")

    await expect(host.uninstall("a")).rejects.toThrow("remove failed")
    expect(host.contributions()).toHaveLength(0)
    expect(await store.get("a")).toBeUndefined()
    expect(await store.data("a", "project:a", "key")).toBeUndefined()
  })

  test("remounts with new config and clears failures on success", async () => {
    const { runtime, host } = setup()
    await host.install(pack("a"))
    await host.enable("a")
    await host.setConfig("a", { value: true })
    expect(runtime.unmounted).toEqual(["a"])
    expect(runtime.mounted).toEqual(["a", "a"])
    await expect(host.call("a", "ping")).resolves.toEqual({ method: "ping", params: undefined })
  })
})
