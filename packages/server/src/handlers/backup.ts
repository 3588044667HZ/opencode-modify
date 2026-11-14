import { Backup } from "@opencode-ai/core/backup/backup"
import { BackupStatus as BackupState } from "@opencode-ai/core/backup/status"
import { ForbiddenError, InvalidRequestError } from "@opencode-ai/protocol/errors"
import {
  BackupError,
  type BackupConfigureInput,
  type BackupRunResult,
  type BackupSnapshotSummary,
  type BackupStatus,
} from "@opencode-ai/protocol/groups/backup"
import { Cause, Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { ServerAuth } from "../auth"
import { Api } from "../api"

export const BackupHandler = HttpApiBuilder.group(Api, "server.backup", (handlers) =>
  handlers
    .handle("backup.status", () => Backup.Service.use(backupStatus))
    .handle("backup.run", () => Backup.Service.use(backupRun))
    .handle("backup.snapshots", (ctx) => Backup.Service.use((backup) => backupSnapshots(backup, ctx.query.limit)))
    .handle("backup.configure", (ctx) => Backup.Service.use((backup) => backupConfigureGuarded(backup, ctx.payload))),
)

export function backupStatus(backup: Backup.Interface): Effect.Effect<BackupStatus, BackupError> {
  return Effect.gen(function* () {
    const settings = yield* backup.settings()
    const status = yield* backup.status()
    const tokenConfigured = yield* backup.authConfigured()
    return {
      running: status.running,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      lastSnapshotID: status.lastSnapshotID,
      lastLogicalBytes: status.lastLogicalBytes,
      lastUploadedBytes: status.lastUploadedBytes,
      lastDurationMs: status.lastDurationMs,
      configured: Boolean(settings.server && settings.username && tokenConfigured),
      enabled: settings.enabled,
      server: settings.server,
      username: settings.username,
      schedule: settings.schedule,
      retention: settings.retention,
      tokenConfigured,
    }
  }).pipe(Effect.mapError((error) => new BackupError({ message: error.message })))
}

export function backupRun(backup: Backup.Interface): Effect.Effect<BackupRunResult, InvalidRequestError> {
  return Effect.gen(function* () {
    if (!(yield* backup.ready())) {
      return yield* Effect.fail(new InvalidRequestError({ message: "Backup is not configured" }))
    }
    const current = yield* backup.status()
    if (current.running) {
      return {
        running: true,
        skipped: true,
        durationMs: 0,
        reason: "another backup is already running",
      } satisfies BackupRunResult
    }

    yield* backup
      .run({ waitForLock: false })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("backup run failed", {
            message: BackupState.sanitizeError(Cause.squash(cause)),
          }),
        ),
        Effect.forkDetach,
      )
    return { running: true, skipped: false, durationMs: 0 } satisfies BackupRunResult
  })
}

export function backupSnapshots(
  backup: Backup.Interface,
  limit?: number,
): Effect.Effect<BackupSnapshotSummary[], InvalidRequestError | BackupError> {
  return Effect.gen(function* () {
    if (!(yield* backup.ready())) {
      return yield* Effect.fail(new InvalidRequestError({ message: "Backup is not configured" }))
    }
    const snapshots = yield* backup.list()
    return snapshots.slice(0, limit ?? snapshots.length).map((snapshot) => ({
      id: snapshot.id,
      createdAt: snapshot.created_at,
      totalBytes: snapshot.total_bytes,
      fileCount: snapshot.file_count ?? snapshot.files.length,
    }))
  }).pipe(
    Effect.catchTag("Backup.Error", (error) => Effect.fail(new BackupError({ message: error.message }))),
  )
}

export function isLoopbackAddress(address: string | undefined) {
  if (!address) return true
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  return normalized === "::1" || /^127\./.test(normalized)
}

export function backupConfigure(
  backup: Backup.Interface,
  input: BackupConfigureInput,
): Effect.Effect<BackupStatus, InvalidRequestError | BackupError> {
  return Effect.gen(function* () {
    yield* backup.configure(input)
    return yield* backupStatus(backup)
  }).pipe(
    Effect.catchTag("Backup.Error", (error) => Effect.fail(new InvalidRequestError({ message: error.message }))),
  )
}

export function backupConfigureGuarded(
  backup: Backup.Interface,
  input: BackupConfigureInput,
): Effect.Effect<
  BackupStatus,
  InvalidRequestError | ForbiddenError | BackupError,
  HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const auth = Option.getOrUndefined(yield* Effect.serviceOption(ServerAuth.Config))
    if (!auth || !ServerAuth.required(auth)) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const address = Option.getOrUndefined(request.remoteAddress)
      const proxied = Boolean(request.headers["x-forwarded-for"] || request.headers["forwarded"])
      if (!isLoopbackAddress(address) || proxied) {
        return yield* Effect.fail(
          new ForbiddenError({
            message: "Backup configuration requires server authentication or a loopback connection",
          }),
        )
      }
    }
    return yield* backupConfigure(backup, input)
  })
}
