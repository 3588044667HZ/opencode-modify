import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Backup } from "@opencode-ai/core/backup/backup"
import { BackupCron } from "@opencode-ai/core/backup/cron"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { BackupStatus } from "@opencode-ai/core/backup/status"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { tmpdir } from "../fixture/tmpdir"
import { startFakeServer } from "./fake-server"

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function fixture() {
  const tmp = await tmpdir()
  const roots = {
    data: path.join(tmp.path, "data"),
    config: path.join(tmp.path, "config"),
    state: path.join(tmp.path, "state"),
    cache: path.join(tmp.path, "cache"),
  }
  await fs.mkdir(roots.data, { recursive: true })
  await fs.mkdir(roots.config, { recursive: true })
  const databasePath = path.join(roots.data, "opencode.db")
  const db = new Database(databasePath)
  db.run("CREATE TABLE message (id INTEGER PRIMARY KEY, text TEXT)")
  db.run("INSERT INTO message (text) VALUES (?)", ["persisted"])
  db.close()
  await write(path.join(roots.data, "auth.json"), '{"provider":"secret"}')
  await write(path.join(roots.data, "mcp-auth.json"), '{"mcp":"secret"}')
  await write(path.join(roots.data, "tool-output", "session", "out.txt"), "tool output")
  await write(path.join(roots.data, "log", "ignored.txt"), "log")
  await write(path.join(roots.data, "repos", "ignored", "file"), "repo")
  return { tmp, roots, databasePath }
}

function backupLayer(roots: { data: string; config: string; state: string; cache: string }) {
  return AppNodeBuilder.build(LayerNode.group([Backup.node]), [
    [Global.node, Global.layerWith(roots)],
  ])
}

function runBackup(roots: { data: string; config: string; state: string; cache: string }, options: Backup.RunOptions) {
  return Effect.gen(function* () {
    const backup = yield* Backup.Service
    return yield* backup.run(options)
  }).pipe(Effect.provide(backupLayer(roots)), Effect.runPromise)
}

function useBackup<A>(
  roots: { data: string; config: string; state: string; cache: string },
  body: (backup: Backup.Interface) => Effect.Effect<A, Backup.BackupError>,
) {
  return Effect.gen(function* () {
    return yield* body(yield* Backup.Service)
  }).pipe(Effect.provide(backupLayer(roots)), Effect.runPromise)
}

describe("backup engine", () => {
  test("uploads a DB snapshot and pull restores the recorded files", async () => {
    const { tmp, roots, databasePath } = await fixture()
    const server = await startFakeServer({ supportHead: true })
    const previous = process.env.OPENCODE_BACKUP_TOKEN
    process.env.OPENCODE_BACKUP_TOKEN = ""
    try {
      await write(
        path.join(roots.config, "opencode.jsonc"),
        JSON.stringify({
          backup: {
            enabled: true,
            server: server.url,
            username: "alice",
            include_tool_output: true,
          },
        }),
      )
      await BackupSettings.writeAuth(roots.state, {
        server: server.url,
        username: "alice",
        method: "token",
        secret: "test-token",
      })

      const result = await runBackup(roots, {
        databasePath,
        quickCheck: true,
        lockDir: path.join(roots.state, "locks"),
      })
      expect(result.skipped).toBe(false)
      expect(result.snapshotID).toBeDefined()
      expect(result.files).toBeGreaterThanOrEqual(4)
      expect(server.manifests).toHaveLength(1)

      const manifest = server.manifests[0] as {
        id: string
        files: Array<{ path: string; size: number; chunks: string[] }>
        total_bytes: number
      }
      const paths = manifest.files.map((file) => file.path)
      expect(paths).toContain("data/opencode.db")
      expect(paths).toContain("data/auth.json")
      expect(paths).toContain("data/mcp-auth.json")
      expect(paths).toContain("data/tool-output/session/out.txt")
      expect(paths.some((value) => value.startsWith("data/repos/"))).toBe(false)
      expect(paths.some((value) => value.startsWith("data/log/"))).toBe(false)
      expect(manifest.total_bytes).toBeGreaterThan(0)

      const status = await BackupStatus.read(roots.state)
      expect(status.running).toBe(false)
      expect(status.lastSnapshotID).toBe(manifest.id)
      expect(status.lastLogicalBytes).toBe(manifest.total_bytes)
      expect(JSON.stringify(status)).not.toContain("test-token")

      const staging = await fs.readdir(path.join(roots.cache, "backup")).catch(() => [])
      expect(staging.filter((entry) => entry.startsWith("staging-"))).toEqual([])

      const out = path.join(tmp.path, "restore")
      const pulled = await useBackup(roots, (backup) => backup.pull({ out }))
      expect(pulled.snapshotID).toBe(manifest.id)
      expect(pulled.files).toBe(manifest.files.length)
      expect(await fs.readFile(path.join(out, "data", "auth.json"), "utf8")).toBe('{"provider":"secret"}')
      expect(await fs.readFile(path.join(out, "data", "tool-output", "session", "out.txt"), "utf8")).toBe(
        "tool output",
      )
      const restored = new Database(path.join(out, "data", "opencode.db"), { readonly: true })
      expect(restored.query("SELECT text FROM message").values()).toEqual([["persisted"]])
      restored.close()
      expect(await fs.readFile(path.join(out, "manifest.json"), "utf8")).toContain(manifest.id)

      await expect(useBackup(roots, (backup) => backup.pull({ out }))).rejects.toThrow(/not empty/)
      await useBackup(roots, (backup) => backup.pull({ out, force: true }))
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BACKUP_TOKEN
      else process.env.OPENCODE_BACKUP_TOKEN = previous
      await server.stop()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("records a sanitized failure, removes staging, and skips while locked", async () => {
    const { tmp, roots, databasePath } = await fixture()
    const server = await startFakeServer({ supportHead: true, putErrorStatus: 507 })
    const previous = process.env.OPENCODE_BACKUP_TOKEN
    process.env.OPENCODE_BACKUP_TOKEN = ""
    try {
      await write(
        path.join(roots.config, "opencode.json"),
        JSON.stringify({ backup: { enabled: true, server: server.url, username: "alice" } }),
      )
      await BackupSettings.writeAuth(roots.state, {
        server: server.url,
        username: "alice",
        method: "token",
        secret: "test-token",
      })

      const now = new Date("2026-01-02T03:30:00.000Z")
      const outcome = await runBackup(roots, {
        databasePath,
        now,
        lockDir: path.join(roots.state, "locks"),
      }).catch((cause: unknown) => cause as Backup.BackupError)
      expect(outcome instanceof Error).toBe(true)
      expect(String((outcome as Backup.BackupError).message)).toMatch(/insufficient_storage|507/)

      const status = await BackupStatus.read(roots.state)
      expect(status.running).toBe(false)
      expect(status.lastRunAt).toBe(now.toISOString())
      expect(status.lastError).toBeDefined()
      expect(
        BackupCron.isDue(BackupCron.parseCron("30 3 * * *"), now, status.lastRunAt, status.lastSuccessAt),
      ).toBe(false)
      expect(JSON.stringify(status)).not.toContain("test-token")
      expect(await fs.readdir(path.join(roots.cache, "backup")).catch(() => [])).toEqual([])

      const lockDir = path.join(roots.state, "locks")
      const lease = await Flock.acquire("backup:run", { dir: lockDir, timeoutMs: 1, baseDelayMs: 1 })
      const skipped = await runBackup(roots, { databasePath, lockDir, waitForLock: false })
      expect(skipped.skipped).toBe(true)
      await lease.release()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BACKUP_TOKEN
      else process.env.OPENCODE_BACKUP_TOKEN = previous
      await server.stop()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("restore-plan prints manual steps without touching the filesystem", async () => {
    const { tmp, roots } = await fixture()
    try {
      const out = path.join(tmp.path, "pulled")
      const manifest = {
        version: 1,
        id: "2026-01-01T00-00-00Z-deadbeef",
        created_at: "2026-01-01T00:00:00.000Z",
        source: { hostname: "test", opencode_version: "1.0.0" },
        files: [
          { path: "data/auth.json", size: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
          { path: "config/opencode.jsonc", size: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
        ],
        total_bytes: 2,
      }
      await write(path.join(out, "manifest.json"), JSON.stringify(manifest))
      const steps = await useBackup(roots, (backup) => backup.restorePlan({ from: out }))
      expect(steps.join("\n")).toContain("Stop every running opencode")
      expect(steps.join("\n")).toContain(path.join(roots.data, "auth.json"))
      expect(steps.join("\n")).toContain(path.join(roots.config, "opencode.jsonc"))
      await expect(fs.access(path.join(roots.config, "opencode.jsonc"))).rejects.toThrow()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
  test("status clears running when the backup lock is gone and keeps it while held", async () => {
    const { tmp, roots } = await fixture()
    const previous = Global.Path.state
    try {
      Flock.setGlobal({ state: roots.state })
      await BackupStatus.write(roots.state, { running: true, lastRunAt: new Date().toISOString() })

      const missing = await useBackup(roots, (backup) => backup.status())
      expect(missing.running).toBe(false)

      const lease = await Flock.acquire("backup:run", { timeoutMs: 1, baseDelayMs: 1 })
      const live = await useBackup(roots, (backup) => backup.status())
      expect(live.running).toBe(true)
      await lease.release()

      const released = await useBackup(roots, (backup) => backup.status())
      expect(released.running).toBe(false)
    } finally {
      Flock.setGlobal({ state: previous })
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("removes leftover staging directories on the next run", async () => {
    const { tmp, roots, databasePath } = await fixture()
    const server = await startFakeServer({ supportHead: true })
    const previous = process.env.OPENCODE_BACKUP_TOKEN
    process.env.OPENCODE_BACKUP_TOKEN = ""
    try {
      await write(
        path.join(roots.config, "opencode.jsonc"),
        JSON.stringify({ backup: { enabled: true, server: server.url, username: "alice" } }),
      )
      await BackupSettings.writeAuth(roots.state, { server: server.url, username: "alice", method: "token", secret: "test-token" })
      const leftover = path.join(roots.cache, "backup", "staging-leftover")
      await write(path.join(leftover, "data", "opencode.db"), "stale snapshot")
      const now = new Date()
      await fs.utimes(leftover, now, now)

      const result = await runBackup(roots, {
        databasePath,
        quickCheck: true,
        lockDir: path.join(roots.state, "locks"),
      })
      expect(result.skipped).toBe(false)
      expect(await fs.readdir(path.join(roots.cache, "backup"))).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BACKUP_TOKEN
      else process.env.OPENCODE_BACKUP_TOKEN = previous
      await server.stop()
      await tmp[Symbol.asyncDispose]()
    }
  })
})