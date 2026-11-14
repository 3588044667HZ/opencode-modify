import { describe, expect, test } from "bun:test"
import type {
  BackupConfigureInput,
  BackupRunResult,
  BackupSnapshotSummary,
  BackupStatus,
} from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createBackupSettingsController, formatByteSize, type BackupApi } from "./backup-controller"

function status(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    running: false,
    configured: true,
    enabled: true,
    schedule: "30 3 * * *",
    retention: 7,
    tokenConfigured: true,
    server: "https://backup.example.com",
    username: "alice",
    lastSuccessAt: "2026-11-14T03:30:00.000Z",
    lastSnapshotID: "2026-11-14T03-30-00Z-abcd1234",
    lastLogicalBytes: 2048,
    lastUploadedBytes: 1024,
    lastDurationMs: 5000,
    ...overrides,
  }
}

function snapshot(id: string): BackupSnapshotSummary {
  return { id, createdAt: "2026-11-14T03:30:00.000Z", totalBytes: 2048, fileCount: 4 }
}

function setup(api: BackupApi) {
  return createRoot((dispose) => {
    const controller = createBackupSettingsController({ api, sleep: async () => {}, pollIntervalMs: 1, pollAttempts: 5 })
    return { controller, dispose }
  })
}

describe("backup settings controller", () => {
  test("loads status without refilling the token", async () => {
    const { controller, dispose } = setup({
      status: async () => status(),
      run: async () => ({ running: true, skipped: false, durationMs: 0 }),
      snapshots: async () => [],
      configure: async () => status(),
    })
    try {
      await controller.refresh()
      expect(controller.state.form.server).toBe("https://backup.example.com")
      expect(controller.state.form.username).toBe("alice")
      expect(controller.state.form.schedule).toBe("30 3 * * *")
      expect(controller.state.form.enabled).toBe(true)
      expect(controller.state.form.token).toBe("")
      expect(controller.state.status?.tokenConfigured).toBe(true)
    } finally {
      dispose()
    }
  })

  test("saves the token once and clears the write-only field", async () => {
    const calls: BackupConfigureInput[] = []
    const { controller, dispose } = setup({
      status: async () => status(),
      run: async () => ({ running: true, skipped: false, durationMs: 0 }),
      snapshots: async () => [],
      configure: async (input) => {
        calls.push(input)
        return status({ tokenConfigured: true })
      },
    })
    try {
      controller.setField("server", "https://backup.example.com")
      controller.setField("username", "alice")
      controller.setField("schedule", "30 3 * * *")
      controller.setField("token", "secret-token")
      const result = await controller.save()
      expect(result.ok).toBe(true)
      expect(calls[0]?.token).toBe("secret-token")
      expect(controller.state.form.token).toBe("")
      expect(controller.state.status?.tokenConfigured).toBe(true)
    } finally {
      dispose()
    }
  })

  test("saves a password through the same write-only credential field and never refills it", async () => {
    const calls: BackupConfigureInput[] = []
    const { controller, dispose } = setup({
      status: async () => status(),
      run: async () => ({ running: true, skipped: false, durationMs: 0 }),
      snapshots: async () => [],
      configure: async (input) => {
        calls.push(input)
        return status({ tokenConfigured: true })
      },
    })
    try {
      controller.setField("server", "https://backup.example.com")
      controller.setField("username", "alice")
      controller.setField("token", "user-password")
      const result = await controller.save()
      expect(result.ok).toBe(true)
      expect(calls[0]?.token).toBe("user-password")
      expect(controller.state.form.token).toBe("")
      await controller.reloadStatus()
      expect(controller.state.form.token).toBe("")
    } finally {
      dispose()
    }
  })
  test("does not send an empty token", async () => {
    const calls: BackupConfigureInput[] = []
    const { controller, dispose } = setup({
      status: async () => status(),
      run: async () => ({ running: true, skipped: false, durationMs: 0 }),
      snapshots: async () => [],
      configure: async (input) => {
        calls.push(input)
        return status()
      },
    })
    try {
      await controller.save()
      expect(calls[0]).toBeDefined()
      expect(calls[0] && "token" in calls[0]).toBe(false)
    } finally {
      dispose()
    }
  })

  test("polls until the backup is idle and refreshes snapshots", async () => {
    const statuses = [status(), status({ running: true }), status(), status()]
    let snapshotLoads = 0
    const { controller, dispose } = setup({
      status: async () => statuses.shift() ?? status(),
      run: async (): Promise<BackupRunResult> => ({ running: true, skipped: false, durationMs: 0 }),
      snapshots: async () => {
        snapshotLoads += 1
        return []
      },
      configure: async () => status(),
    })
    try {
      await controller.refresh()
      const before = snapshotLoads
      const result = await controller.run()
      expect(result.ok).toBe(true)
      expect(controller.state.running).toBe(false)
      expect(snapshotLoads).toBeGreaterThan(before)
      expect(controller.state.snapshots).toEqual([])
    } finally {
      dispose()
    }
  })

  test("shows an empty snapshot list and recovers after a retry", async () => {
    let calls = 0
    const { controller, dispose } = setup({
      status: async () => status(),
      run: async () => ({ running: true, skipped: false, durationMs: 0 }),
      snapshots: async () => {
        calls += 1
        if (calls === 1) throw new Error("network down")
        return [snapshot("snap-1")]
      },
      configure: async () => status(),
    })
    try {
      await controller.refresh()
      expect(controller.state.snapshotsError).toBe("network down")
      await controller.reloadSnapshots()
      expect(controller.state.snapshotsError).toBeUndefined()
      expect(controller.state.snapshots.map((item) => item.id)).toEqual(["snap-1"])
    } finally {
      dispose()
    }
  })
})

describe("backup formatting", () => {
  test("formats byte sizes", () => {
    expect(formatByteSize(0, "en")).toBe("0 B")
    expect(formatByteSize(1024, "en")).toBe("1 KB")
    expect(formatByteSize(1536, "en")).toBe("1.5 KB")
    expect(formatByteSize(undefined, "en")).toBe("—")
  })
})