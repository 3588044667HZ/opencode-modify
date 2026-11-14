import { describe, expect, test } from "bun:test"
import { BackupScheduler } from "@opencode-ai/core/backup/scheduler"

describe("backup cron", () => {
  test("parses five-field expressions and ranges", () => {
    const cron = BackupScheduler.parseCron("*/15 3-4 * * 1-5")
    expect([...cron.minutes]).toEqual([0, 15, 30, 45])
    expect([...cron.hours]).toEqual([3, 4])
    expect([...cron.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect(cron.dayOfMonthRestricted).toBe(false)
    expect(cron.dayOfWeekRestricted).toBe(true)
  })

  test("matches local minutes and supports Sunday as 7", () => {
    const cron = BackupScheduler.parseCron("30 3 * * 7")
    const sunday = new Date(2026, 0, 4, 3, 30, 0)
    expect(sunday.getDay()).toBe(0)
    expect(BackupScheduler.cronMatches(cron, sunday)).toBe(true)
    expect(BackupScheduler.cronMatches(cron, new Date(2026, 0, 5, 3, 30, 0))).toBe(false)
  })

  test("finds the latest occurrence for catch-up", () => {
    const cron = BackupScheduler.parseCron("30 3 * * *")
    const occurrence = BackupScheduler.previousOccurrence(cron, new Date(2026, 0, 2, 10, 0, 0))
    expect(occurrence).toEqual(new Date(2026, 0, 2, 3, 30, 0))
  })

  test("is due only when the latest occurrence is newer than the last attempt", () => {
    const cron = BackupScheduler.parseCron("30 3 * * *")
    const now = new Date(2026, 0, 2, 3, 30, 30)
    expect(BackupScheduler.isDue(cron, now)).toBe(true)
    expect(BackupScheduler.isDue(cron, new Date(2026, 0, 2, 1, 0, 0))).toBe(false)
    expect(BackupScheduler.isDue(cron, now, new Date(2026, 0, 2, 3, 30, 0).toISOString())).toBe(false)
    expect(BackupScheduler.isDue(cron, now, new Date(2026, 0, 2, 3, 29, 0).toISOString())).toBe(true)
    expect(
      BackupScheduler.isDue(
        cron,
        now,
        new Date(2026, 0, 1, 4, 0, 0).toISOString(),
        new Date(2026, 0, 1, 4, 0, 0).toISOString(),
      ),
    ).toBe(true)
  })

  test("rejects invalid cron expressions", () => {
    for (const expression of ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "1-2-3 * * * *"]) {
      expect(() => BackupScheduler.parseCron(expression)).toThrow()
    }
  })
})