import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "../fixture/tmpdir"

describe("backup flock", () => {
  test("allows only one owner and can be reacquired after release", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const first = await Flock.acquire("backup:run", { dir, timeoutMs: 1, baseDelayMs: 1, maxDelayMs: 1 })
    await expect(
      Flock.acquire("backup:run", { dir, timeoutMs: 1, baseDelayMs: 1, maxDelayMs: 1 }),
    ).rejects.toThrow(/Timed out waiting for lock/)

    await first.release()
    const second = await Flock.acquire("backup:run", { dir, timeoutMs: 1, baseDelayMs: 1, maxDelayMs: 1 })
    await second.release()
  })

  test("reclaims a lock whose recorded owner process is gone", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const first = await Flock.acquire("backup:run", { dir, staleMs: 60_000, timeoutMs: 1, baseDelayMs: 1 })
    const metaPath = path.join(dir, Hash.fast("backup:run") + ".lock", "meta.json")
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"))
    meta.pid = 2_147_483_647
    await fs.writeFile(metaPath, JSON.stringify(meta))

    const second = await Flock.acquire("backup:run", { dir, staleMs: 60_000, timeoutMs: 1_000, baseDelayMs: 1 })
    await first.release().catch(() => undefined)
    await second.release()
  })

  test("withLock serializes callbacks on the same key", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const order: string[] = []
    const first = Flock.withLock(
      "backup:run",
      async () => {
        order.push("first:start")
        await Bun.sleep(20)
        order.push("first:end")
      },
      { dir },
    )
    await Bun.sleep(5)
    const second = Flock.withLock(
      "backup:run",
      async () => {
        order.push("second")
      },
      { dir },
    )
    await Promise.all([first, second])
    expect(order).toEqual(["first:start", "first:end", "second"])
  })
})