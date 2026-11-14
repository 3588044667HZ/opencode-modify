import { createHash } from "crypto"

export interface FakeServerOptions {
  readonly token?: string
  readonly basic?: { readonly username: string; readonly password: string }
  readonly supportHead?: boolean
  readonly failPutTimes?: number
  readonly putErrorStatus?: number
  readonly delayMs?: number
}

export interface FakeServer {
  readonly url: string
  readonly chunks: Map<string, Uint8Array>
  readonly snapshots: Map<string, unknown>
  readonly manifests: unknown[]
  readonly requests: string[]
  putAttempts: number
  headAttempts: number
  stop: () => Promise<void>
}

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const token = options.token ?? "test-token"
  const chunks = new Map<string, Uint8Array>()
  const snapshots = new Map<string, unknown>()
  const manifests: unknown[] = []
  const requests: string[] = []
  const state = {
    putAttempts: 0,
    headAttempts: 0,
  }
  const supportHead = options.supportHead === true
  const failPutTimes = options.failPutTimes ?? 0

  const expected = options.basic
    ? "Basic " + Buffer.from(`${options.basic.username}:${options.basic.password}`).toString("base64")
    : "Bearer " + token

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const parts = url.pathname.split("/").filter(Boolean)
      requests.push(`${request.method} ${url.pathname}`)
      if (options.delayMs) await Bun.sleep(options.delayMs)

      if (url.pathname === "/v1/health") return json(200, { ok: true, version: "1" })
      if (request.headers.get("authorization") !== expected) {
        return json(401, { error: { code: "unauthorized", message: "bad credentials" } })
      }
      if (parts[0] !== "v1" || parts[1] !== "users" || parts[2] !== "alice") {
        return json(404, { error: { code: "not_found", message: "not found" } })
      }

      if (parts[3] === "chunks" && parts[4]) {
        const sha = decodeURIComponent(parts[4])
        if (request.method === "PUT") {
          if (options.putErrorStatus) {
            return json(options.putErrorStatus, {
              error: {
                code: options.putErrorStatus === 507 ? "insufficient_storage" : "server_error",
                message: "injected failure",
              },
            })
          }
          state.putAttempts += 1
          if (state.putAttempts <= failPutTimes) {
            return json(500, { error: { code: "server_error", message: "injected failure" } })
          }
          const bytes = new Uint8Array(await request.arrayBuffer())
          if (sha256(bytes) !== sha) {
            return json(400, { error: { code: "sha256_mismatch", message: "body hash mismatch" } })
          }
          const existed = chunks.has(sha)
          chunks.set(sha, bytes)
          return new Response(null, { status: existed ? 204 : 201 })
        }
        if (request.method === "HEAD") {
          state.headAttempts += 1
          if (!supportHead) return new Response(null, { status: 405 })
          return new Response(null, { status: chunks.has(sha) ? 200 : 404 })
        }
        if (request.method === "GET") {
          const bytes = chunks.get(sha)
          if (!bytes) return json(404, { error: { code: "chunk_not_found", message: "missing" } })
          return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          })
        }
        return new Response(null, { status: 405 })
      }

      if (parts[3] === "snapshots" && parts[4]) {
        const id = decodeURIComponent(parts[4])
        if (request.method === "GET") {
          const manifest = snapshots.get(id)
          if (!manifest) return json(404, { error: { code: "snapshot_not_found", message: "missing" } })
          return json(200, manifest)
        }
        if (request.method === "DELETE") {
          snapshots.delete(id)
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 405 })
      }

      if (parts[3] === "snapshots") {
        if (request.method === "POST") {
          const manifest = (await request.json()) as {
            id: string
            created_at: string
            total_bytes: number
            files: Array<{ path: string; size: number; sha256: string; chunks: string[] }>
          }
          for (const file of manifest.files) {
            for (const chunk of file.chunks) {
              if (!chunks.has(chunk)) {
                return json(400, {
                  error: { code: "missing_chunk", message: `chunk ${chunk} is not stored` },
                })
              }
            }
          }
          if (snapshots.has(manifest.id)) {
            return json(409, { error: { code: "snapshot_exists", message: "exists" } })
          }
          snapshots.set(manifest.id, manifest)
          manifests.push(manifest)
          return json(201, { id: manifest.id })
        }
        if (request.method === "GET") {
          return json(200, {
            snapshots: [...snapshots.values()].reverse().map((value) => {
              const manifest = value as {
                id: string
                created_at: string
                total_bytes: number
                files: Array<{ path: string; size: number; sha256: string }>
              }
              return {
                id: manifest.id,
                created_at: manifest.created_at,
                total_bytes: manifest.total_bytes,
                files: manifest.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
                file_count: manifest.files.length,
              }
            }),
          })
        }
      }

      return json(404, { error: { code: "not_found", message: "not found" } })
    },
  })

  return {
    url: server.url.toString().replace(/\/$/, ""),
    chunks,
    snapshots,
    manifests,
    requests,
    get putAttempts() {
      return state.putAttempts
    },
    set putAttempts(value: number) {
      state.putAttempts = value
    },
    get headAttempts() {
      return state.headAttempts
    },
    set headAttempts(value: number) {
      state.headAttempts = value
    },
    stop: () => server.stop(true),
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}