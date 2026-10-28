import { describe, expect, test } from "bun:test"
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  generatePassword,
  normalizeTarget,
  passwordError,
  sameTarget,
} from "./lan-settings"

describe("lan settings", () => {
  test("generates a 24 character base64url password", () => {
    const password = generatePassword()
    expect(password).toHaveLength(24)
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("generates distinct passwords", () => {
    expect(new Set(Array.from({ length: 20 }, generatePassword)).size).toBe(20)
  })

  test("validates password length and characters", () => {
    expect(passwordError("a".repeat(MIN_PASSWORD_LENGTH - 1))).toContain("at least")
    expect(passwordError("a".repeat(MAX_PASSWORD_LENGTH + 1))).toContain("at most")
    expect(passwordError("bad\npassword")).toContain("printable ASCII")
    expect(passwordError("good-password")).toBeUndefined()
    expect(passwordError("a".repeat(MAX_PASSWORD_LENGTH))).toBeUndefined()
  })

  test("normalizes wildcard targets to loopback", () => {
    const target = { url: "http://0.0.0.0:4096", username: "opencode", password: "secret" }
    expect(normalizeTarget(target).url).toBe("http://127.0.0.1:4096/")
    expect(normalizeTarget({ ...target, url: "http://[::]:4096" }).url).toBe("http://127.0.0.1:4096/")
    expect(normalizeTarget({ ...target, url: "http://127.0.0.1:4096" }).url).toBe("http://127.0.0.1:4096")
  })

  test("compares target identity", () => {
    const a = { url: "http://127.0.0.1:4096", username: "opencode", password: "secret" }
    expect(sameTarget(a, { ...a })).toBe(true)
    expect(sameTarget(a, { ...a, password: "other" })).toBe(false)
    expect(sameTarget(undefined, a)).toBe(false)
  })
})
