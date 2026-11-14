import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Backup } from "@opencode-ai/core/backup/backup"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { ForbiddenError, InvalidRequestError } from "@opencode-ai/protocol/errors"
import { BackupGroup } from "@opencode-ai/protocol/groups/backup"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { ServerAuth } from "@opencode-ai/server/auth"
import { sanitizeSchemaReason } from "@opencode-ai/server/middleware/schema-error"
import {
  backupConfigure,
  backupConfigureGuarded,
  backupRun,
  isLoopbackAddress,
  backupSnapshots,
  backupStatus,
} from "@opencode-ai/server/handlers/backup"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint } from "effect/unstable/httpapi"
import { testEffect } from "../lib/effect"

const settings: BackupSettings.Settings = {
  enabled: true,
  server: "https://backup.example.com",
  username: "alice",
  schedule: "30 3 * * *",
  retention: 7,
  includeToolOutput: true,
  includeSnapshots: false,
  includeProjectConfig: false,
}

const status = {
  running: false,
  lastRunAt: "2026-11-14T03:30:00.000Z",
  lastSuccessAt: "2026-11-14T03:31:00.000Z",
  lastSnapshotID: "2026-11-14T03-30-00Z-abcd1234",
  lastLogicalBytes: 2048,
  lastUploadedBytes: 1024,
  lastDurationMs: 5000,
}

function service(overrides: Partial<Backup.Interface> = {}): Backup.Interface {
  return {
    settings: () => Effect.succeed(settings),
    status: () => Effect.succeed(status),
    ready: () => Effect.succeed(true),
    authConfigured: () => Effect.succeed(true),
    configure: () => Effect.void,
    run: () => Effect.succeed({ skipped: false, durationMs: 0 }),
    list: () => Effect.succeed([]),
    pull: () => Effect.die("unexpected pull"),
    restorePlan: () => Effect.succeed([]),
    ...overrides,
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("backup handlers", () => {
  test("status includes configuration without exposing a token", async () => {
    const result = await run(backupStatus(service()))
    expect(result).toMatchObject({
      running: false,
      configured: true,
      enabled: true,
      server: "https://backup.example.com",
      username: "alice",
      schedule: "30 3 * * *",
      retention: 7,
      tokenConfigured: true,
      lastSnapshotID: status.lastSnapshotID,
    })
    expect(Object.hasOwn(result, "token")).toBe(false)
  })

  test("run rejects when the backup is not configured", async () => {
    const error = await run(
      backupRun(service({ ready: () => Effect.succeed(false) })).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect(error.message).toContain("not configured")
  })

  test("run reports a skipped start when another backup is running", async () => {
    const result = await run(
      backupRun(
        service({
          status: () => Effect.succeed({ ...status, running: true }),
          run: () => Effect.die("should not start another backup"),
        }),
      ),
    )
    expect(result).toEqual({
      running: true,
      skipped: true,
      durationMs: 0,
      reason: "another backup is already running",
    })
  })

  test("run starts a background backup", async () => {
    const started = Deferred.makeUnsafe<void>()
    const calls: Backup.RunOptions[] = []
    const result = await run(
      backupRun(
        service({
          run: (options) => {
            if (options) calls.push(options)
            return Deferred.succeed(started, undefined).pipe(
              Effect.as({ skipped: false, durationMs: 0 } satisfies Backup.RunResult),
            )
          },
        }),
      ),
    )
    expect(result).toEqual({ running: true, skipped: false, durationMs: 0 })
    await run(Deferred.await(started).pipe(Effect.timeout("2 seconds")))
    expect(calls[0]?.waitForLock).toBe(false)
  })

  test("run endpoint declares a 202 success response", () => {
    const endpoint = BackupGroup.endpoints["backup.run"]
    expect(Array.from(endpoint.success).some((schema) => schema.ast.annotations?.httpApiStatus === 202)).toBe(true)
  })

  test("run endpoint does not accept connection fields", () => {
    expect(BackupGroup.endpoints["backup.run"].payload.size).toBe(0)
  })

  test("snapshots map the remote summary and apply the limit", async () => {
    const result = await run(
      backupSnapshots(
        service({
          list: () =>
            Effect.succeed([
              { id: "snap-1", created_at: "2026-11-14T03:30:00.000Z", total_bytes: 2048, files: [{ path: "a", size: 1, sha256: "a".repeat(64) }] },
              { id: "snap-2", created_at: "2026-11-13T03:30:00.000Z", total_bytes: 4096, file_count: 3, files: [] },
              { id: "snap-3", created_at: "2026-11-12T03:30:00.000Z", files: [] },
            ]),
        }),
        2,
      ),
    )
    expect(result).toEqual([
      { id: "snap-1", createdAt: "2026-11-14T03:30:00.000Z", totalBytes: 2048, fileCount: 1 },
      { id: "snap-2", createdAt: "2026-11-13T03:30:00.000Z", totalBytes: 4096, fileCount: 3 },
    ])
  })

  test("snapshots return an empty list", async () => {
    expect(await run(backupSnapshots(service()))).toEqual([])
  })

  test("snapshots reject when the backup is not configured", async () => {
    const error = await run(
      backupSnapshots(service({ ready: () => Effect.succeed(false) })).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(InvalidRequestError)
  })

  test("detects loopback addresses", () => {
    expect(isLoopbackAddress(undefined)).toBe(true)
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("127.8.9.10")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("192.168.1.10")).toBe(false)
    expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false)
  })

  test("redacts token fields from schema error reasons", () => {
    const reason = sanitizeSchemaReason(`Expected string\n  at ["token"]\n{"token":"secret-token"}`)
    expect(reason).not.toContain("secret-token")
    expect(reason).toContain("[redacted]")
  })

  test("configure rejects non-loopback requests when server auth is disabled", async () => {
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/backup/configure", { method: "POST" }),
    ).modify({ remoteAddress: Option.some("192.168.1.10") })
    const error = await run(
      backupConfigureGuarded(service(), {}).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(
          ServerAuth.Config,
          ServerAuth.Config.of({ username: "opencode", password: Option.none() }),
        ),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(ForbiddenError)
  })

  test("configure allows unauthenticated loopback requests", async () => {
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/backup/configure", { method: "POST" }),
    ).modify({ remoteAddress: Option.some("127.0.0.1") })
    const result = await run(
      backupConfigureGuarded(service(), {}).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(
          ServerAuth.Config,
          ServerAuth.Config.of({ username: "opencode", password: Option.none() }),
        ),
      ),
    )
    expect(result.configured).toBe(true)
  })

  test("configure does not echo the token", async () => {
    const inputs: unknown[] = []
    const result = await run(
      backupConfigure(
        service({
          configure: (input) => {
            inputs.push(input)
            return Effect.void
          },
        }),
        { enabled: true, server: "https://backup.example.com", username: "alice", token: "secret-token" },
      ),
    )
    expect(inputs[0]).toEqual({
      enabled: true,
      server: "https://backup.example.com",
      username: "alice",
      token: "secret-token",
    })
    expect(JSON.stringify(result)).not.toContain("secret-token")
    expect(result.tokenConfigured).toBe(true)
  })
})

const AuthApi = HttpApi.make("backup-auth-test")
  .add(BackupGroup)
  .middleware(Authorization)

const authHandlers = HttpApiBuilder.group(AuthApi, "server.backup", (handlers) =>
  handlers
    .handle("backup.status", () => Effect.die("unreachable"))
    .handle("backup.run", () => Effect.die("unreachable"))
    .handle("backup.snapshots", () => Effect.die("unreachable"))
    .handle("backup.configure", () => Effect.die("unreachable")),
)

const authLayer = HttpRouter.serve(
  HttpApiBuilder.layer(AuthApi).pipe(Layer.provide(authHandlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const itSecret = testEffect(
  authLayer.pipe(
    Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.some("secret") })),
  ),
)

describe("backup authorization", () => {
  itSecret.live("rejects unauthenticated access", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/api/backup/status").pipe(HttpClient.execute)
      expect(response.status).toBe(401)
    }),
  )
})