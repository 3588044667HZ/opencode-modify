export * as BackupRemote from "./remote"

import { Cause, Duration, Effect, Exit, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { BackupChunk } from "./chunk"
import { BackupManifest } from "./manifest"
import { BackupSettings } from "./settings"

export class RemoteError extends Schema.TaggedErrorClass<RemoteError>()("Backup.RemoteError", {
  operation: Schema.String,
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export interface SnapshotSummary {
  readonly id: string
  readonly created_at: string
  readonly total_bytes?: number
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly size: number
    readonly sha256: string
  }>
  readonly file_count?: number
}

const SnapshotSummarySchema = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  total_bytes: Schema.optional(Schema.Number),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Number,
      sha256: Schema.String,
    }),
  ),
  file_count: Schema.optional(Schema.Number),
})

const SnapshotListSchema = Schema.Struct({ snapshots: Schema.Array(SnapshotSummarySchema) })
const decodeSummaryList = Schema.decodeUnknownOption(SnapshotListSchema)
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export interface Interface {
  readonly headChunk: (sha256: string) => Effect.Effect<"exists" | "missing" | "unknown", RemoteError>
  readonly putChunk: (sha256: string, body: Uint8Array) => Effect.Effect<void, RemoteError>
  readonly listSnapshots: () => Effect.Effect<SnapshotSummary[], RemoteError>
  readonly getManifest: (id: string) => Effect.Effect<BackupManifest.Manifest, RemoteError>
  readonly createSnapshot: (manifest: BackupManifest.Manifest) => Effect.Effect<void, RemoteError>
  readonly getChunk: (sha256: string) => Effect.Effect<Uint8Array, RemoteError>
  readonly deleteSnapshot: (id: string) => Effect.Effect<void, RemoteError>
}

const MAX_RETRIES = 3
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(60)
const DEFAULT_BODY_TIMEOUT = Duration.seconds(60)

export interface Timeouts {
  readonly request?: Duration.Duration
  readonly body?: Duration.Duration
}

export function make(
  connection: BackupSettings.Connection,
  client: HttpClient.HttpClient,
  options: { readonly timeouts?: Timeouts } = {},
) {
  const requestTimeout = options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT
  const bodyTimeout = options.timeouts?.body ?? DEFAULT_BODY_TIMEOUT
  const base = connection.server.replace(/\/+$/, "")
  const user = encodeURIComponent(connection.username)

  type AuthorizedCredential =
    | { readonly type: "bearer"; readonly token: string }
    | { readonly type: "basic"; readonly username: string; readonly password: string }

  let resolved: AuthorizedCredential | undefined
  if (connection.credential.type === "bearer" || connection.credential.type === "basic") {
    resolved = connection.credential
  }

  const authorizeWith = (request: HttpClientRequest.HttpClientRequest, credential: AuthorizedCredential) =>
    credential.type === "bearer"
      ? HttpClientRequest.bearerToken(request, credential.token)
      : HttpClientRequest.basicAuth(request, credential.username, credential.password)

  const fallbackCredentials = (): AuthorizedCredential[] => {
    if (connection.credential.type !== "unknown") return [connection.credential]
    return [
      { type: "bearer", token: connection.credential.secret },
      { type: "basic", username: connection.username, password: connection.credential.secret },
    ]
  }

  const timeout = (operation: string, duration: Duration.Duration) =>
    <A>(effect: Effect.Effect<A, RemoteError>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration,
          orElse: () =>
            Effect.fail(
              new RemoteError({
                operation,
                message: "request timed out",
                retryable: true,
              }),
            ),
        }),
      )

  const execute = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    options: { readonly allowFallback?: boolean } = {},
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, RemoteError> => {
    const candidates = resolved ? [resolved] : fallbackCredentials()
    const canFallback =
      options.allowFallback === true && connection.credential.type === "unknown" && resolved === undefined
    const attempts = canFallback ? candidates : candidates.slice(0, 1)

    const attempt = (index: number): Effect.Effect<HttpClientResponse.HttpClientResponse, RemoteError> =>
      client.execute(authorizeWith(request, attempts[index]!)).pipe(
        Effect.mapError(
          (cause) =>
            new RemoteError({
              operation,
              message: `network request failed (${cause.reason._tag})`,
              retryable: true,
            }),
        ),
        timeout(operation, requestTimeout),
        Effect.flatMap((response) => {
          if (response.status === 401 && index + 1 < attempts.length) return attempt(index + 1)
          if (response.status !== 401) resolved = attempts[index]!
          return Effect.succeed(response)
        }),
      )

    return attempt(0)
  }
  const responseError = (operation: string, response: { status: number; text: Effect.Effect<string, unknown> }) =>
    Effect.gen(function* () {
      const text = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
        Effect.timeoutOrElse({ duration: bodyTimeout, orElse: () => Effect.succeed("") }),
      )
      const decoded = decodeJson(text)
      const body = decoded._tag === "None" ? undefined : decoded.value
      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
      const code = typeof error?.code === "string" ? error.code : undefined
      const detail = typeof error?.message === "string" ? error.message : undefined
      const message = detail ? (code ? `${code}: ${detail}` : detail) : `HTTP ${response.status}`
      return new RemoteError({
        operation,
        status: response.status,
        code,
        message: message.slice(0, 2_000),
        retryable: (response.status >= 500 && response.status !== 507) || response.status === 408 || response.status === 429,
      })
    })

  const expect = (operation: string, response: { status: number; text: Effect.Effect<string, unknown> }, ok: readonly number[]) =>
    ok.includes(response.status)
      ? Effect.void
      : Effect.flatMap(responseError(operation, response), (error) => Effect.fail(error))

  const retry = <A>(effect: Effect.Effect<A, RemoteError>): Effect.Effect<A, RemoteError> =>
    Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const exit = yield* Effect.exit(effect)
        if (Exit.isSuccess(exit)) return exit.value
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        if (!error || !error.retryable || attempt >= MAX_RETRIES) return yield* Effect.failCause(exit.cause)
        yield* Effect.sleep(Duration.millis(Math.min(4_000, 250 * 2 ** attempt)))
      }
    })

  const endpoint = (suffix: string) => `${base}/v1/users/${user}${suffix}`

  const headChunk = (sha256: string) =>
    execute("headChunk", HttpClientRequest.head(endpoint(`/chunks/${encodeURIComponent(sha256)}`)), { allowFallback: true }).pipe(
      Effect.flatMap((response) => {
        if (response.status === 200) return Effect.succeed("exists" as const)
        if (response.status === 404) return Effect.succeed("missing" as const)
        if (response.status === 401) {
          return Effect.flatMap(responseError("headChunk", response), (error) => Effect.fail(error))
        }
        return Effect.succeed("unknown" as const)
      }),
      Effect.catchIf(
        (error) => error.status === undefined,
        () => Effect.succeed("unknown" as const),
      ),
    )

  const putChunk = (sha256: string, body: Uint8Array) =>
    retry(
      execute(
        "putChunk",
        HttpClientRequest.bodyUint8Array(
          HttpClientRequest.put(endpoint(`/chunks/${encodeURIComponent(sha256)}`)),
          body,
          "application/octet-stream",
        ),
      ).pipe(Effect.flatMap((response) => expect("putChunk", response, [201, 204]))),
    )

  const listSnapshots = () =>
    retry(
      execute("listSnapshots", HttpClientRequest.acceptJson(HttpClientRequest.get(endpoint("/snapshots"))), { allowFallback: true }).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text.pipe(
                Effect.mapError(
                  () =>
                    new RemoteError({
                      operation: "listSnapshots",
                      status: response.status,
                      message: "failed to read snapshot list",
                      retryable: true,
                    }),
                ),
                timeout("listSnapshots", bodyTimeout),
              )
            : Effect.flatMap(responseError("listSnapshots", response), (error) => Effect.fail(error)),
        ),
        Effect.flatMap((text) => {
          const decoded = decodeJson(text)
          if (decoded._tag === "None") {
            return Effect.fail(
              new RemoteError({
                operation: "listSnapshots",
                message: "snapshot list is not valid JSON",
                retryable: false,
              }),
            )
          }
          const list = decodeSummaryList(decoded.value)
          if (list._tag === "None") {
            return Effect.fail(
              new RemoteError({
                operation: "listSnapshots",
                message: "snapshot list has an unexpected shape",
                retryable: false,
              }),
            )
          }
          return Effect.succeed([...list.value.snapshots])
        }),
      ),
    )

  const getManifest = (id: string) =>
    retry(
      execute(
        "getManifest",
        HttpClientRequest.acceptJson(HttpClientRequest.get(endpoint(`/snapshots/${encodeURIComponent(id)}`))),
        { allowFallback: true },
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text.pipe(
                Effect.mapError(
                  () =>
                    new RemoteError({
                      operation: "getManifest",
                      status: response.status,
                      message: "failed to read snapshot manifest",
                      retryable: true,
                    }),
                ),
                timeout("getManifest", bodyTimeout),
              )
            : Effect.flatMap(responseError("getManifest", response), (error) => Effect.fail(error)),
        ),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => BackupManifest.parseJson(text),
            catch: (cause) =>
              new RemoteError({
                operation: "getManifest",
                message: cause instanceof Error ? cause.message : "invalid snapshot manifest",
                retryable: false,
              }),
          }),
        ),
      ),
    )

  const createSnapshot = (manifest: BackupManifest.Manifest) =>
    retry(
      execute(
        "createSnapshot",
        HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.post(endpoint("/snapshots")),
          BackupManifest.parse(manifest),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 201 || response.status === 409
            ? Effect.void
            : Effect.flatMap(responseError("createSnapshot", response), (error) => Effect.fail(error)),
        ),
      ),
    )

  const getChunk = (sha256: string) =>
    retry(
      execute("getChunk", HttpClientRequest.get(endpoint(`/chunks/${encodeURIComponent(sha256)}`)), { allowFallback: true }).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.arrayBuffer.pipe(
                Effect.mapError(
                  () =>
                    new RemoteError({
                      operation: "getChunk",
                      status: response.status,
                      message: "failed to read chunk body",
                      retryable: true,
                    }),
                ),
                Effect.map((buffer) => new Uint8Array(buffer)),
                timeout("getChunk", bodyTimeout),
              )
            : Effect.flatMap(responseError("getChunk", response), (error) => Effect.fail(error)),
        ),
        Effect.flatMap((bytes) =>
          BackupChunk.hashBytes(bytes) === sha256.toLowerCase()
            ? Effect.succeed(bytes)
            : Effect.fail(
                new RemoteError({
                  operation: "getChunk",
                  message: `downloaded chunk failed SHA-256 verification: ${sha256}`,
                  code: "chunk_corrupt",
                  retryable: false,
                }),
              ),
        ),
      ),
    )

  const deleteSnapshot = (id: string) =>
    retry(
      execute("deleteSnapshot", HttpClientRequest.make("DELETE")(endpoint(`/snapshots/${encodeURIComponent(id)}`))).pipe(
        Effect.flatMap((response) => expect("deleteSnapshot", response, [200, 204])),
      ),
    )

  return {
    headChunk,
    putChunk,
    listSnapshots,
    getManifest,
    createSnapshot,
    getChunk,
    deleteSnapshot,
  } satisfies Interface
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
