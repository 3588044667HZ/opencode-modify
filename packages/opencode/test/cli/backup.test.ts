import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { BackupManifest } from "@opencode-ai/core/backup/manifest"
import { startFakeServer } from "../../../core/test/backup/fake-server"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

describe("opencode backup CLI", () => {
  cliIt.concurrent(
    "setup writes non-sensitive config and stores the token in state",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "backup",
          "setup",
          "--server",
          "http://127.0.0.1:9",
          "--username",
          "alice",
          "--token",
          "secret-token",
          "--enable",
          "--schedule",
          "*/5 * * * *",
        ])
        opencode.expectExit(result, 0)
        expect(result.stdout).not.toContain("secret-token")
        expect(result.stderr).not.toContain("secret-token")

        const configPath = path.join(home, ".config", "opencode", "opencode.jsonc")
        const configText = yield* Effect.promise(() => Bun.file(configPath).text())
        const config = JSON.parse(configText)
        expect(config.backup).toEqual({
          enabled: true,
          server: "http://127.0.0.1:9",
          username: "alice",
          schedule: "*/5 * * * *",
        })
        expect(configText).not.toContain("secret-token")

        const authPath = path.join(home, ".local", "state", "opencode", "backup", "auth.json")
        const auth = JSON.parse(yield* Effect.promise(() => Bun.file(authPath).text()))
        expect(auth).toMatchObject({
          server: "http://127.0.0.1:9",
          username: "alice",
          token: "secret-token",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "setup rejects a server change without a new token",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const first = yield* opencode.spawn([
          "backup",
          "setup",
          "--server",
          "http://127.0.0.1:9",
          "--username",
          "alice",
          "--token",
          "secret-token",
        ])
        opencode.expectExit(first, 0)

        const second = yield* opencode.spawn(["backup", "setup", "--server", "http://127.0.0.1:10"])
        opencode.expectExit(second, 1)
        expect(second.stderr).toContain("different server or username")

        const config = JSON.parse(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "opencode", "opencode.jsonc")).text()),
        )
        expect(config.backup.server).toBe("http://127.0.0.1:9")
      }),
    60_000,
  )

  cliIt.concurrent(
    "status --json reports an empty status before the first run",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["backup", "status", "--json"])
        opencode.expectExit(result, 0)
        expect(JSON.parse(result.stdout)).toEqual({ running: false })
      }),
    60_000,
  )

  cliIt.concurrent(
    "restore-plan prints manual steps",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const manifest = BackupManifest.create({
          id: "2026-01-01T00-00-00Z-deadbeef",
          created_at: "2026-01-01T00:00:00.000Z",
          source: { hostname: "test", opencode_version: "1.0.0" },
          files: [{ path: "data/auth.json", size: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] }],
        })
        const directory = path.join(home, "restore")
        yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(directory, "manifest.json"), BackupManifest.encode(manifest)),
        )

        const result = yield* opencode.spawn(["backup", "restore-plan", "--from", directory])
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("Stop every running opencode")
        expect(result.stdout).toContain("auth.json")
        expect(result.stdout).toContain(path.join(home, ".local", "share", "opencode"))
      }),
    60_000,
  )

  cliIt.concurrent(
    "setup --password-stdin validates Basic credentials without persisting the password",
    ({ home, llm }) =>
      Effect.gen(function* () {
        const server = yield* Effect.promise(() =>
          startFakeServer({ basic: { username: "alice", password: "super-secret-password-123" } }),
        )
        try {
          const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")
          const process_ = Bun.spawn(
            [
              "bun",
              "run",
              cliEntry,
              "backup",
              "setup",
              "--server",
              server.url,
              "--username",
              "alice",
              "--password-stdin",
            ],
            {
              cwd: home,
              env: {
                ...process.env,
                OPENCODE_TEST_HOME: home,
                HOME: home,
                XDG_CONFIG_HOME: path.join(home, ".config"),
                XDG_DATA_HOME: path.join(home, ".local", "share"),
                XDG_STATE_HOME: path.join(home, ".local", "state"),
                XDG_CACHE_HOME: path.join(home, ".cache"),
                OPENCODE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)),
                OPENCODE_DISABLE_PROJECT_CONFIG: "1",
                OPENCODE_PURE: "1",
                OPENCODE_DISABLE_AUTOUPDATE: "1",
                OPENCODE_DISABLE_AUTOCOMPACT: "1",
                OPENCODE_DISABLE_MODELS_FETCH: "1",
                OPENCODE_AUTH_CONTENT: "{}",
              },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          process_.stdin!.write("super-secret-password-123\n")
          process_.stdin!.end()
          const exitCode = yield* Effect.promise(() => process_.exited)
          const stdout = yield* Effect.promise(() => new Response(process_.stdout).text())
          const stderr = yield* Effect.promise(() => new Response(process_.stderr).text())
          expect(exitCode).toBe(0)
          expect(stdout).toContain("Basic credentials verified")
          expect(stdout).not.toContain("super-secret-password-123")
          expect(stderr).not.toContain("super-secret-password-123")

          const configText = yield* Effect.promise(() =>
            Bun.file(path.join(home, ".config", "opencode", "opencode.jsonc")).text(),
          )
          expect(configText).not.toContain("super-secret-password-123")
          const auth = Bun.file(path.join(home, ".local", "state", "opencode", "backup", "auth.json"))
          expect(yield* Effect.promise(() => auth.exists())).toBe(false)
        } finally {
          yield* Effect.promise(() => server.stop())
        }
      }),
    60_000,
  )

  cliIt.concurrent(
    "run fails cleanly when credentials are not configured",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["backup", "run"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("backup server is not configured")
      }),
    60_000,
  )
})