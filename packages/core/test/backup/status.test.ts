import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { BackupStatus } from "@opencode-ai/core/backup/status"
import { tmpdir } from "../fixture/tmpdir"

describe("backup status", () => {
  test("round-trips the documented fields atomically", async () => {
    await using tmp = await tmpdir()
    expect(await BackupStatus.read(tmp.path)).toEqual(BackupStatus.empty)

    const status = {
      running: false,
      lastRunAt: "2026-01-01T00:00:00.000Z",
      lastSuccessAt: "2026-01-01T00:01:00.000Z",
      lastSnapshotID: "snapshot-1",
      lastLogicalBytes: 10,
      lastUploadedBytes: 5,
      lastDurationMs: 1_000,
    }
    await BackupStatus.write(tmp.path, status)
    expect(await BackupStatus.read(tmp.path)).toEqual(status)

    const running = { ...status, running: true, lastRunAt: new Date().toISOString(), lastError: "boom" }
    await BackupStatus.write(tmp.path, running)
    expect(await BackupStatus.read(tmp.path)).toEqual(running)

    const entries = await fs.readdir(path.dirname(BackupSettings.statusFile(tmp.path)))
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })

  test("returns an empty status for corrupt JSON and prunes unknown fields", async () => {
    await using tmp = await tmpdir()
    const file = BackupSettings.statusFile(tmp.path)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{not json")
    expect(await BackupStatus.read(tmp.path)).toEqual(BackupStatus.empty)

    await fs.writeFile(file, JSON.stringify({ running: false, secret: "do-not-copy", lastRunAt: "x" }))
    expect(await BackupStatus.read(tmp.path)).toEqual({ running: false, lastRunAt: "x" })
  })

  test("normalizes stale running flags", () => {
    const now = Date.parse("2026-01-02T00:00:00.000Z")
    expect(
      BackupStatus.normalize({ running: true, lastRunAt: "2026-01-01T23:00:00.000Z" }, now).running,
    ).toBe(true)
    expect(
      BackupStatus.normalize({ running: true, lastRunAt: "2025-12-31T00:00:00.000Z" }, now).running,
    ).toBe(false)
    expect(BackupStatus.normalize({ running: true }, now).running).toBe(false)
    expect(BackupStatus.normalize({ running: true, lastRunAt: "not-a-date" }, now).running).toBe(false)
  })

  test("sanitizes long error messages", () => {
    const message = BackupStatus.sanitizeError(new Error("line one\nline two " + "x".repeat(5_000)))
    expect(message).not.toContain("\n")
    expect(message.length).toBeLessThanOrEqual(2_000)
  })
})