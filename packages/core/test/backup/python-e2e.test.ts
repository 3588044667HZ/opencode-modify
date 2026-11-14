import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { randomBytes } from "crypto"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Backup } from "@opencode-ai/core/backup/backup"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/tmpdir"

const enabled = process.env.OPENCODE_BACKUP_E2E === "1"
const python = process.env.OPENCODE_BACKUP_PYTHON ?? "E:\\python311\\python.exe"
const serverScript = path.resolve(import.meta.dir, "../../../../backup-server/server.py")

const suite = enabled && existsSync(serverScript) ? describe : describe.skip

suite("backup-server python e2e", () => {
  test("uploads and pulls a small snapshot through the real server", async () => {
    await using tmp = await tmpdir()
    const dataDir = path.join(tmp.path, "server-data")
    const roots = {
      data: path.join(tmp.path, "data"),
      config: path.join(tmp.path, "config"),
      state: path.join(tmp.path, "state"),
      cache: path.join(tmp.path, "cache"),
    }
    const token = randomBytes(16).toString("hex")
    const port = 20_000 + Math.floor(Math.random() * 20_000)

    const run = async (args: string[]) => {
      const result = await Bun.spawn([python, serverScript, ...args], { stdout: "ignore", stderr: "ignore" }).exited
      if (result !== 0) throw new Error(`backup-server command failed: ${args[0]}`)
    }
    await run(["init", "--data-dir", dataDir, "--admin-password", randomBytes(12).toString("hex")])
    await run(["adduser", "--data-dir", dataDir, "--user", "alice", "--token", token])

    const child = Bun.spawn(
      [python, serverScript, "serve", "--data-dir", dataDir, "--host", "127.0.0.1", "--port", String(port)],
      { stdout: "ignore", stderr: "ignore" },
    )
    try {
      const base = `http://127.0.0.1:${port}`
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await fetch(`${base}/v1/health`).then((response) => response.ok).catch(() => false)
        if (ready) break
        await Bun.sleep(100)
      }
      if (!ready) throw new Error("backup-server did not become healthy")

      await fs.mkdir(roots.data, { recursive: true })
      await fs.mkdir(roots.config, { recursive: true })
      const db = new Database(path.join(roots.data, "opencode.db"))
      db.run("CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)")
      db.run("INSERT INTO item (value) VALUES (?)", ["e2e"])
      db.close()
      await fs.writeFile(path.join(roots.data, "auth.json"), '{"token":"snapshot-secret"}')
      await fs.writeFile(
        path.join(roots.config, "opencode.jsonc"),
        JSON.stringify({ backup: { enabled: true, server: base, username: "alice" } }),
      )
      await BackupSettings.writeAuth(roots.state, { server: base, username: "alice", method: "token", secret: token })

      const layer = AppNodeBuilder.build(LayerNode.group([Backup.node]), [
        [Global.node, Global.layerWith(roots)],
      ])
      const result = await Effect.gen(function* () {
        const backup = yield* Backup.Service
        const run = yield* backup.run({ databasePath: path.join(roots.data, "opencode.db"), quickCheck: true })
        const out = path.join(tmp.path, "restored")
        const pulled = yield* backup.pull({ snapshotID: run.snapshotID, out })
        return { run, pulled, out }
      }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(result.run.skipped).toBe(false)
      expect(result.pulled.files).toBeGreaterThanOrEqual(3)
      expect(await fs.readFile(path.join(result.out, "data", "auth.json"), "utf8")).toBe(
        '{"token":"snapshot-secret"}',
      )
      const restored = new Database(path.join(result.out, "data", "opencode.db"), { readonly: true })
      expect(restored.query("SELECT value FROM item").values()).toEqual([["e2e"]])
      restored.close()
    } finally {
      child.kill()
      await child.exited
      await tmp[Symbol.asyncDispose]()
    }
  }, 120_000)
})