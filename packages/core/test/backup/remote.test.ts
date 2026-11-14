import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { BackupChunk } from "@opencode-ai/core/backup/chunk"
import { BackupManifest } from "@opencode-ai/core/backup/manifest"
import { BackupRemote } from "@opencode-ai/core/backup/remote"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { startFakeServer } from "./fake-server"

function connection(server: string, token = "test-token"): BackupSettings.Connection {
  return {
    server,
    username: "alice",
    credential: { type: "bearer", token },
    tokenSource: "state",
  }
}

function withConnection<A>(
  input: BackupSettings.Connection,
  body: (remote: BackupRemote.Interface) => Effect.Effect<A, BackupRemote.RemoteError>,
  timeouts?: BackupRemote.Timeouts,
) {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const remote = BackupRemote.make(input, http, { timeouts })
    return yield* body(remote)
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise)
}

function withRemote<A>(
  server: string,
  body: (remote: BackupRemote.Interface) => Effect.Effect<A, BackupRemote.RemoteError>,
  token?: string,
  timeouts?: BackupRemote.Timeouts,
) {
  return withConnection(connection(server, token), body, timeouts)
}

describe("backup remote", () => {
  test("uses HEAD to skip existing chunks and PUT to upload missing ones", async () => {
    const server = await startFakeServer({ supportHead: true })
    try {
      const bytes = new TextEncoder().encode("chunk-body")
      const sha = BackupChunk.hashBytes(bytes)
      await withRemote(server.url, (remote) =>
        Effect.gen(function* () {
          expect(yield* remote.headChunk(sha)).toBe("missing")
          yield* remote.putChunk(sha, bytes)
          expect(yield* remote.headChunk(sha)).toBe("exists")
        }),
      )
      expect(server.chunks.get(sha)).toEqual(bytes)
      expect(server.putAttempts).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("falls back to PUT when HEAD is unsupported", async () => {
    const server = await startFakeServer({ supportHead: false })
    try {
      const bytes = new TextEncoder().encode("fallback")
      const sha = BackupChunk.hashBytes(bytes)
      await withRemote(server.url, (remote) =>
        Effect.gen(function* () {
          expect(yield* remote.headChunk(sha)).toBe("unknown")
          yield* remote.putChunk(sha, bytes)
        }),
      )
      expect(server.putAttempts).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("lists snapshots, fetches manifests, and verifies downloaded chunks", async () => {
    const server = await startFakeServer({ supportHead: true })
    try {
      const bytes = new TextEncoder().encode("snapshot-content")
      const sha = BackupChunk.hashBytes(bytes)
      const manifest = BackupManifest.create({
        id: "2026-01-01T00-00-00Z-deadbeef",
        created_at: "2026-01-01T00:00:00.000Z",
        source: { hostname: "test", opencode_version: "1.0.0" },
        files: [{ path: "data/test.txt", size: bytes.byteLength, sha256: sha, chunks: [sha] }],
      })

      await withRemote(server.url, (remote) =>
        Effect.gen(function* () {
          yield* remote.putChunk(sha, bytes)
          yield* remote.createSnapshot(manifest)
          const list = yield* remote.listSnapshots()
          expect(list).toHaveLength(1)
          expect(list[0].id).toBe(manifest.id)
          expect(list[0].file_count).toBe(1)
          expect(list[0].files[0]).toEqual({ path: "data/test.txt", size: bytes.byteLength, sha256: sha })
          expect(yield* remote.getManifest(manifest.id)).toEqual(manifest)
          expect(yield* remote.getChunk(sha)).toEqual(bytes)
        }),
      )

      server.chunks.set(sha, new TextEncoder().encode("tampered"))
      await expect(
        withRemote(server.url, (remote) => remote.getChunk(sha)),
      ).rejects.toMatchObject({ _tag: "Backup.RemoteError", code: "chunk_corrupt" })
    } finally {
      await server.stop()
    }
  })

  test("supports Basic credentials when explicitly provided", async () => {
    const server = await startFakeServer({ supportHead: true, basic: { username: "alice", password: "pw" } })
    try {
      const http = await Effect.runPromise(Effect.gen(function* () {
        return yield* HttpClient.HttpClient
      }).pipe(Effect.provide(FetchHttpClient.layer)))
      const remote = BackupRemote.make(
        {
          server: server.url,
          username: "alice",
          credential: { type: "basic", username: "alice", password: "pw" },
        },
        http,
      )
      expect(await Effect.runPromise(remote.listSnapshots())).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test("treats 409 for an existing snapshot id as success", async () => {
    const server = await startFakeServer({ supportHead: true })
    try {
      const bytes = new TextEncoder().encode("idempotent")
      const sha = BackupChunk.hashBytes(bytes)
      const manifest = BackupManifest.create({
        id: "2026-01-01T00-00-00Z-feedface",
        created_at: "2026-01-01T00:00:00.000Z",
        source: { hostname: "test", opencode_version: "1.0.0" },
        files: [{ path: "data/test.txt", size: bytes.byteLength, sha256: sha, chunks: [sha] }],
      })
      await withRemote(server.url, (remote) =>
        Effect.gen(function* () {
          yield* remote.putChunk(sha, bytes)
          yield* remote.createSnapshot(manifest)
          yield* remote.createSnapshot(manifest)
        }),
      )
      expect(server.snapshots.size).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("times out stalled requests with a retryable error", async () => {
    const server = await startFakeServer({ supportHead: true, delayMs: 500 })
    try {
      const error = (await withRemote(server.url, (remote) => remote.listSnapshots(), undefined, {
        request: Duration.millis(20),
      }).catch((cause: unknown) => cause)) as BackupRemote.RemoteError
      expect(error.message).toMatch(/timed out/)
      expect(error.retryable).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("unknown method falls back from Bearer to Basic on safe requests", async () => {
    const server = await startFakeServer({ basic: { username: "alice", password: "pw" } })
    try {
      const result = await withConnection(
        { server: server.url, username: "alice", credential: { type: "unknown", secret: "pw" } },
        (remote) => remote.listSnapshots(),
      )
      expect(result).toEqual([])
      expect(server.requests.filter((request) => request.startsWith("GET /v1/users/alice/snapshots"))).toHaveLength(2)
    } finally {
      await server.stop()
    }
  })

  test("unknown method resolves Bearer without retrying Basic", async () => {
    const server = await startFakeServer({ token: "test-token" })
    try {
      const result = await withConnection(
        { server: server.url, username: "alice", credential: { type: "unknown", secret: "test-token" } },
        (remote) => remote.listSnapshots(),
      )
      expect(result).toEqual([])
      expect(server.requests.filter((request) => request.startsWith("GET /v1/users/alice/snapshots"))).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test("token method never silently falls back to Basic", async () => {
    const server = await startFakeServer({ basic: { username: "alice", password: "pw" } })
    try {
      const error = (await withRemote(server.url, (remote) => remote.listSnapshots(), "pw").catch(
        (cause: unknown) => cause,
      )) as BackupRemote.RemoteError
      expect(error.status).toBe(401)
      expect(error.message).not.toContain("pw")
      expect(server.requests.filter((request) => request.startsWith("GET /v1/users/alice/snapshots"))).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test("password method never silently falls back to Bearer", async () => {
    const server = await startFakeServer({ token: "test-token" })
    try {
      const error = (await withConnection(
        {
          server: server.url,
          username: "alice",
          credential: { type: "basic", username: "alice", password: "test-token" },
        },
        (remote) => remote.listSnapshots(),
      ).catch((cause: unknown) => cause)) as BackupRemote.RemoteError
      expect(error.status).toBe(401)
      expect(server.requests.filter((request) => request.startsWith("GET /v1/users/alice/snapshots"))).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test("does not retry side-effecting snapshot creation with another method", async () => {
    const server = await startFakeServer({ basic: { username: "alice", password: "pw" } })
    try {
      const manifest = BackupManifest.create({
        source: { hostname: "test", opencode_version: "1.0.0" },
        files: [],
      })
      const error = (await withConnection(
        { server: server.url, username: "alice", credential: { type: "unknown", secret: "pw" } },
        (remote) => remote.createSnapshot(manifest),
      ).catch((cause: unknown) => cause)) as BackupRemote.RemoteError
      expect(error.status).toBe(401)
      expect(server.requests.filter((request) => request.startsWith("POST /v1/users/alice/snapshots"))).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test("surfaces authentication errors without leaking the token", async () => {
    const server = await startFakeServer({ supportHead: true })
    try {
      const failure = (await withRemote(server.url, (remote) => remote.listSnapshots(), "wrong-token").catch(
        (error: unknown) => error,
      )) as BackupRemote.RemoteError
      expect(failure.status).toBe(401)
      expect(failure.message).not.toContain("wrong-token")
    } finally {
      await server.stop()
    }
  })

  test("retries transient 5xx failures and does not retry 507", async () => {
    const retryServer = await startFakeServer({ supportHead: true, failPutTimes: 1 })
    try {
      const bytes = new TextEncoder().encode("retry")
      const sha = BackupChunk.hashBytes(bytes)
      await withRemote(retryServer.url, (remote) => remote.putChunk(sha, bytes))
      expect(retryServer.putAttempts).toBe(2)
    } finally {
      await retryServer.stop()
    }

    const fullServer = await startFakeServer({ supportHead: true, putErrorStatus: 507 })
    try {
      const bytes = new TextEncoder().encode("full")
      const error = (await withRemote(fullServer.url, (remote) =>
        remote.putChunk(BackupChunk.hashBytes(bytes), bytes),
      ).catch((cause: unknown) => cause)) as BackupRemote.RemoteError
      expect(error.status).toBe(507)
      expect(error.retryable).toBe(false)
    } finally {
      await fullServer.stop()
    }
  })
})