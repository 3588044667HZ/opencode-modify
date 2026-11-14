import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { tmpdir } from "../fixture/tmpdir"

async function writeConfig(directory: string, name: string, value: unknown) {
  await fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2))
}

describe("backup settings", () => {
  test("returns defaults when no config exists", async () => {
    await using tmp = await tmpdir()
    const loaded = await BackupSettings.load({
      configDirectory: tmp.path,
      files: [path.join(tmp.path, "opencode.jsonc")],
    })
    expect(loaded.settings).toEqual(BackupSettings.defaults)
    expect(loaded.configPath).toBeUndefined()
  })

  test("merges global config files with jsonc winning and ignores project config", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    await fs.mkdir(project)
    await writeConfig(tmp.path, "config.json", {
      backup: { server: "http://old.example.com/", username: "alice", include_snapshots: true },
    })
    await writeConfig(tmp.path, "opencode.jsonc", {
      backup: {
        enabled: true,
        server: "https://backup.example.com/",
        schedule: " 15 4 * * * ",
        retention: 14,
        include_tool_output: false,
      },
    })
    await writeConfig(project, "opencode.json", { backup: { enabled: false, server: "http://project.example" } })

    const files = BackupSettings.configFiles(tmp.path)
    expect(files.indexOf(path.join(tmp.path, "config.json"))).toBeLessThan(
      files.indexOf(path.join(tmp.path, "opencode.jsonc")),
    )
    const loaded = await BackupSettings.load({ configDirectory: tmp.path, files })

    expect(loaded.settings).toEqual({
      enabled: true,
      server: "https://backup.example.com",
      username: "alice",
      schedule: "15 4 * * *",
      retention: 14,
      includeToolOutput: false,
      includeSnapshots: true,
      includeProjectConfig: false,
    })
    expect(loaded.configPath).toBe(path.join(tmp.path, "opencode.jsonc"))
  })

  test("rejects invalid values", async () => {
    await using tmp = await tmpdir()
    await writeConfig(tmp.path, "opencode.json", { backup: { server: "ftp://example.com" } })
    await expect(
      BackupSettings.load({ configDirectory: tmp.path, files: [path.join(tmp.path, "opencode.json")] }),
    ).rejects.toThrow(/http/)

    expect(() => BackupSettings.validateUsername("../alice")).toThrow()
    expect(() => BackupSettings.validateUsername("CON")).toThrow()
    expect(() => BackupSettings.validateToken("has space")).toThrow()
    expect(() => BackupSettings.normalizeServer("http://user:pass@example.com")).toThrow()
    expect(() => BackupSettings.normalizeServer("http://example.com?token=x")).toThrow()
  })

  test("prefers OPENCODE_BACKUP_TOKEN over the state token", async () => {
    await using tmp = await tmpdir()
    const settings = { ...BackupSettings.defaults, server: "http://127.0.0.1:9", username: "alice" }
    const auth = {
      server: "http://127.0.0.1:9",
      username: "alice",
      token: "state-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    }

    const fromState = BackupSettings.resolveConnection({ settings, auth, env: {} })
    expect(fromState.credential).toEqual({ type: "bearer", token: "state-token" })
    expect(fromState.tokenSource).toBe("state")

    const fromEnv = BackupSettings.resolveConnection({
      settings,
      auth,
      env: { OPENCODE_BACKUP_TOKEN: "env-token" },
    })
    expect(fromEnv.credential).toEqual({ type: "bearer", token: "env-token" })
    expect(fromEnv.tokenSource).toBe("env")

    expect(() => BackupSettings.resolveConnection({ settings, env: {} })).toThrow(/token/)
  })

  test("binds the state token to its server and username", () => {
    const settings = { ...BackupSettings.defaults, server: "http://127.0.0.1:9", username: "alice" }
    const auth = {
      server: "http://127.0.0.1:8",
      username: "alice",
      token: "state-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    }
    expect(() => BackupSettings.resolveConnection({ settings, auth, env: {} })).toThrow(/different server/)
    expect(() =>
      BackupSettings.resolveConnection({
        settings: { ...settings, username: "bob" },
        auth,
        env: {},
      }),
    ).toThrow(/different server/)
    expect(
      BackupSettings.resolveConnection({
        settings,
        auth,
        env: { OPENCODE_BACKUP_TOKEN: "env-token" },
      }).credential,
    ).toEqual({ type: "bearer", token: "env-token" })
    expect(BackupSettings.authMatches(auth, settings.server, settings.username)).toBe(false)
    expect(BackupSettings.authMatches({ ...auth, server: settings.server! }, settings.server, "alice")).toBe(true)
  })

  test("writes auth.json with 0600 and never persists passwords", async () => {
    await using tmp = await tmpdir()
    const file = await BackupSettings.writeAuth(tmp.path, {
      server: "http://127.0.0.1:9",
      username: "alice",
      token: "secret-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(file).toBe(BackupSettings.authFile(tmp.path))

    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("secret-token")
    expect(text).toContain("alice")
    expect(text).not.toContain("password")
    expect(await BackupSettings.readAuth(tmp.path)).toEqual({
      server: "http://127.0.0.1:9",
      username: "alice",
      token: "secret-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    })

    if (process.platform !== "win32") {
      const info = await fs.stat(file)
      expect(info.mode & 0o777).toBe(0o600)
    }
  })
})