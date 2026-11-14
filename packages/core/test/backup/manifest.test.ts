import { describe, expect, test } from "bun:test"
import { BackupManifest } from "@opencode-ai/core/backup/manifest"

const sha = "a".repeat(64)
const source = { hostname: "workstation", opencode_version: "1.0.0" }

function file(path: string, text: string) {
  return {
    path,
    size: Buffer.byteLength(text),
    sha256: sha,
    chunks: [sha],
  }
}

describe("backup manifest", () => {
  test("is deterministic and sorts files by path", () => {
    const first = BackupManifest.create({
      id: "2026-01-01T10-00-00Z-abcdef12",
      created_at: "2026-01-01T10:00:00.000Z",
      source,
      files: [file("config/opencode.jsonc", "b"), file("data/auth.json", "a")],
    })
    const second = BackupManifest.create({
      id: first.id,
      created_at: first.created_at,
      source,
      files: [file("data/auth.json", "a"), file("config/opencode.jsonc", "b")],
    })

    expect(BackupManifest.encode(first)).toBe(BackupManifest.encode(second))
    expect(first.files.map((item) => item.path)).toEqual(["config/opencode.jsonc", "data/auth.json"])
    expect(first.total_bytes).toBe(2)

    const parsed = BackupManifest.parseJson(BackupManifest.encode(first))
    expect(parsed).toEqual(first)
  })

  test("rejects unsafe paths", () => {
    for (const path of [
      "../escape",
      "data/../../escape",
      "/absolute",
      "\\absolute",
      "data\\..\\escape",
      "C:/windows",
      "data/\0file",
      "data//file",
      "data/./file",
      "",
    ]) {
      expect(() => BackupManifest.validatePath(path)).toThrow()
    }
    expect(() => BackupManifest.validatePath("data/auth.json")).not.toThrow()
  })

  test("treats literal percent signs as safe and decodes valid sequences", () => {
    expect(() => BackupManifest.validatePath("data/100%done.json")).not.toThrow()
    expect(() => BackupManifest.validatePath("data/%ZZ.json")).not.toThrow()
    expect(() => BackupManifest.validatePath("data/%2e%2e/escape")).toThrow(/segments/)
    expect(() => BackupManifest.validatePath("data/%2Fabsolute")).toThrow(/segments/)
  })
  test("rejects Windows case-insensitive duplicates", () => {
    expect(() =>
      BackupManifest.create({
        source,
        files: [file("data/Auth.json", "a"), file("data/auth.json", "b")],
      }),
    ).toThrow(/collide/i)
  })

  test("validates shape, totals, and chunk hashes", () => {
    const manifest = BackupManifest.create({ source, files: [file("data/auth.json", "a")] })
    expect(() => BackupManifest.parse({ ...manifest, version: 2 })).toThrow(/version/)
    expect(() => BackupManifest.parse({ ...manifest, total_bytes: 99 })).toThrow(/total_bytes/)

    const badChunk = {
      ...manifest,
      files: [{ ...manifest.files[0], chunks: ["not-a-hash"] }],
      total_bytes: manifest.files[0].size,
    }
    expect(() => BackupManifest.parse(badChunk)).toThrow(/chunk sha256/)

    const empty = BackupManifest.create({ source, files: [] })
    expect(empty.total_bytes).toBe(0)
  })

  test("creates server-compatible snapshot ids", () => {
    const id = BackupManifest.newID(new Date("2026-01-01T10:00:00.000Z"))
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
    expect(id).toBe("2026-01-01T10-00-00Z-" + id.slice(-8))
    expect(BackupManifest.newID()).not.toBe(BackupManifest.newID())
  })
})