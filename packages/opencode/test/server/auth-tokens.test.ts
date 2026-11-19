import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerAuth } from "@opencode-ai/server/auth"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-auth-tokens-"))
  dirs.push(dir)
  return path.join(dir, "tokens.json")
}

describe("ServerAuth.TokenStore", () => {
  test("issues, verifies, rotates, and revokes opaque tokens", async () => {
    const file = await tempFile()
    let now = 1_000_000
    const store = new ServerAuth.TokenStore({
      file,
      accessTtlMs: 1_000,
      refreshTtlMs: 5_000,
      now: () => now,
    })

    const first = await store.issue({ username: "opencode", deviceName: "test-device" })
    expect(first.accessToken.startsWith("oc_at_")).toBe(true)
    expect(first.refreshToken.startsWith("oc_rt_")).toBe(true)
    expect(first.session.deviceName).toBe("test-device")
    expect(await store.verifyAccess(first.accessToken)).toBe(true)
    expect(await store.session(first.accessToken)).toMatchObject({ username: "opencode" })

    now += 1_001
    expect(await store.verifyAccess(first.accessToken)).toBe(false)
    expect(await store.session(first.accessToken)).toBeUndefined()

    const second = await store.refresh(first.refreshToken)
    if (!second) throw new Error("expected refresh token to rotate")
    expect(second.accessToken).not.toBe(first.accessToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)
    expect(await store.verifyAccess(second.accessToken)).toBe(true)
    expect(await store.refresh(first.refreshToken)).toBeUndefined()

    expect(await store.revoke(second.accessToken)).toBe(true)
    expect(await store.verifyAccess(second.accessToken)).toBe(false)
    expect(await store.revoke(second.refreshToken)).toBe(false)
  })

  test("persists tokens across store instances and drops expired sessions", async () => {
    const file = await tempFile()
    let now = 2_000_000
    const firstStore = new ServerAuth.TokenStore({
      file,
      accessTtlMs: 1_000,
      refreshTtlMs: 5_000,
      now: () => now,
    })
    const pair = await firstStore.issue({ username: "opencode" })

    const secondStore = new ServerAuth.TokenStore({
      file,
      accessTtlMs: 1_000,
      refreshTtlMs: 5_000,
      now: () => now,
    })
    expect(await secondStore.verifyAccess(pair.accessToken)).toBe(true)

    now += 6_000
    const thirdStore = new ServerAuth.TokenStore({
      file,
      accessTtlMs: 1_000,
      refreshTtlMs: 5_000,
      now: () => now,
    })
    expect(await thirdStore.verifyAccess(pair.accessToken)).toBe(false)
    expect(await thirdStore.refresh(pair.refreshToken)).toBeUndefined()
  })
})