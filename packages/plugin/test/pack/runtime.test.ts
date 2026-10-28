import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { parsePackManifest } from "../../src/pack/manifest"
import { ProcessPackRuntime, type PackRuntimeHandle } from "../../src/pack/runtime"

const target = fileURLToPath(new URL("../ipc/fixtures", import.meta.url))
const manifest = parsePackManifest({ id: "echo", version: "1.0.0", entry: "echo-plugin.ts" })
const pack = { manifest, source: "test", target, installedAt: 0 }

describe("process pack runtime", () => {
  test("mounts a process and unmounts it idempotently", async () => {
    const runtime = new ProcessPackRuntime({ lifecycleTimeoutMs: 2_000, stopTimeoutMs: 500 })
    let handle: PackRuntimeHandle | undefined
    try {
      handle = await runtime.mount(pack, { scope: "project:a" })
      expect(await handle.call("echo", { value: 4 })).toEqual({ value: 4 })
      await handle.unmount()
      await handle.unmount()
      await expect(handle.call("echo", { value: 5 })).rejects.toThrow("not mounted")
    } finally {
      await handle?.remove()
    }
  })

  test("rejects entries that escape the pack target", async () => {
    const runtime = new ProcessPackRuntime()
    await expect(
      runtime.mount(
        { ...pack, manifest: parsePackManifest({ id: "escape", version: "1", entry: "../../outside.js" }) },
        { scope: "project:a" },
      ),
    ).rejects.toThrow("escapes its target")
  })
})
