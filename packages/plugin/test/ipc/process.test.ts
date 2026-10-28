import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { spawnPlugin, type PluginProcess } from "../../src/ipc/process"

const fixture = fileURLToPath(new URL("./fixtures/echo-plugin.ts", import.meta.url))

describe("ipc plugin process", () => {
  test("mounts, unmounts, and removes an out-of-process plugin", async () => {
    const reports: unknown[] = []
    let plugin: PluginProcess | undefined
    try {
      plugin = await spawnPlugin({
        command: process.execPath,
        args: [fixture],
        pluginId: "echo",
        lifecycleTimeoutMs: 2_000,
        stopTimeoutMs: 500,
      })
      plugin.peer.onRequest("report", (params) => {
        reports.push(params)
      })

      await plugin.mount({ project: { directory: "/project" } })
      expect(plugin.lifecycle).toBe("mounted")
      expect(await plugin.peer.request("echo", { value: 3 })).toEqual({ value: 3 })

      await plugin.unmount("disable")
      expect(plugin.lifecycle).toBe("unmounted")
      expect(await plugin.peer.request("trace")).toEqual(["mount", "unmount:disable", "cleanup"])

      await plugin.mount()
      await plugin.remove()
      expect(plugin.lifecycle).toBe("deleted")
      await plugin.exited
      expect(reports).toEqual([
        {
          trace: ["mount", "unmount:disable", "cleanup", "mount", "unmount:uninstall", "cleanup", "delete"],
        },
      ])
    } finally {
      await plugin?.stop({ force: true })
    }
  })
})
