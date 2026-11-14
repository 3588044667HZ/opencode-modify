export * as Backup from "./backup"

import os from "os"
import path from "path"
import { createHash, randomBytes } from "crypto"
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "fs/promises"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { readProjectDirectories, snapshotDatabaseAsync } from "#sqlite"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { Global } from "../global"
import { InstallationVersion } from "../installation/version"
import { Flock } from "../util/flock"
import { BackupChunk } from "./chunk"
import { BackupCron } from "./cron"
import { BackupManifest } from "./manifest"
import { BackupRemote } from "./remote"
import { BackupSettings } from "./settings"
import { BackupSource } from "./source"
import { BackupStatus } from "./status"

export class BackupError extends Schema.TaggedErrorClass<BackupError>()("Backup.Error", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface RunOptions {
  readonly waitForLock?: boolean
  readonly quickCheck?: boolean
  readonly databasePath?: string
  readonly lockDir?: string
  readonly now?: Date
  readonly trigger?: "manual" | "schedule"
}

export interface RunResult {
  readonly skipped: boolean
  readonly snapshotID?: string
  readonly logicalBytes?: number
  readonly uploadedBytes?: number
  readonly files?: number
  readonly chunks?: number
  readonly durationMs: number
  readonly reason?: string
}

export interface PullOptions {
  readonly snapshotID?: string
  readonly out: string
  readonly force?: boolean
}

export interface PullResult {
  readonly snapshotID: string
  readonly totalBytes: number
  readonly files: number
  readonly out: string
}

export interface ConfigureInput {
  readonly enabled?: boolean
  readonly server?: string
  readonly username?: string
  readonly token?: string
  readonly password?: string
  readonly schedule?: string
}

export interface Interface {
  readonly settings: () => Effect.Effect<BackupSettings.Settings, BackupError>
  readonly status: () => Effect.Effect<BackupStatus.Status>
  readonly ready: () => Effect.Effect<boolean>
  readonly authConfigured: () => Effect.Effect<boolean>
  readonly configure: (input: ConfigureInput) => Effect.Effect<void, BackupError>
  readonly run: (options?: RunOptions) => Effect.Effect<RunResult, BackupError>
  readonly list: () => Effect.Effect<BackupRemote.SnapshotSummary[], BackupError>
  readonly pull: (options: PullOptions) => Effect.Effect<PullResult, BackupError>
  readonly restorePlan: (options: { from: string }) => Effect.Effect<string[], BackupError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Backup") {}

const STAGING_PREFIX = "staging-"
// VACUUM runs in a worker so the main event loop and Flock heartbeat keep ticking.
// A wider stale window absorbs other short synchronous stalls, and Flock
// reclaims locks immediately when the recorded local owner PID is gone.
const BACKUP_LOCK_STALE_MS = 10 * 60 * 1000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const roots = {
      data: global.data,
      config: global.config,
      state: global.state,
      cache: global.cache,
    }

    const settings = Effect.fn("Backup.settings")(function* () {
      return yield* loadSettings(roots.config)
    })

    const status = Effect.fn("Backup.status")(function* () {
      const current = BackupStatus.normalize(
        yield* Effect.tryPromise({
          try: () => BackupStatus.read(roots.state),
          catch: (cause) => toBackupError("status", cause),
        }).pipe(Effect.catch(() => Effect.succeed(BackupStatus.empty))),
      )
      if (!current.running) return current
      const live = yield* Effect.tryPromise({
        try: () => Flock.held("backup:run", { staleMs: BACKUP_LOCK_STALE_MS }),
        catch: (cause) => toBackupError("lock", cause),
      }).pipe(Effect.catch(() => Effect.succeed(false)))
      return live ? current : { ...current, running: false }
    })

    const ready = Effect.fn("Backup.ready")(function* () {
      const current = Option.getOrUndefined(yield* Effect.option(settings()))
      if (!current?.server || !current.username) return false
      const auth = Option.getOrUndefined(
        yield* Effect.option(
          Effect.tryPromise({
            try: () => BackupSettings.readAuth(roots.state),
            catch: (cause) => toBackupError("auth", cause),
          }),
        ),
      )
      return Option.isSome(
        yield* Effect.option(
          Effect.try({
            try: () => BackupSettings.resolveConnection({ settings: current, auth }),
            catch: (cause) => toBackupError("connection", cause),
          }),
        ),
      )
    })

    const authConfigured = Effect.fn("Backup.authConfigured")(function* () {
      const current = Option.getOrUndefined(yield* Effect.option(settings()))
      const auth = Option.getOrUndefined(
        yield* Effect.option(
          Effect.tryPromise({
            try: () => BackupSettings.readAuth(roots.state),
            catch: (cause) => toBackupError("auth", cause),
          }),
        ),
      )
      const server = current?.server ?? auth?.server
      const username = current?.username ?? auth?.username
      if (BackupSettings.resolveToken()) return Boolean(server && username)
      return BackupSettings.authMatches(auth, server, username)
    })

    const configure = Effect.fn("Backup.configure")(function* (input: ConfigureInput) {
      const current = yield* settings()
      const serverInput = input.server?.trim()
      const usernameInput = input.username?.trim()
      const scheduleInput = input.schedule?.trim()
      const token = input.token && input.token.length > 0 ? input.token : undefined
      const password = input.password && input.password.length > 0 ? input.password : undefined
      const method: BackupSettings.AuthMethod | undefined = token ? "token" : password ? "password" : undefined
      const secret = token ?? password

      const server = serverInput
        ? yield* Effect.try({
            try: () => BackupSettings.normalizeServer(serverInput),
            catch: (cause) => toBackupError("configure", cause),
          })
        : current.server
      const username = usernameInput
        ? yield* Effect.try({
            try: () => BackupSettings.validateUsername(usernameInput),
            catch: (cause) => toBackupError("configure", cause),
          })
        : current.username
      if (scheduleInput) {
        yield* Effect.try({
          try: () => BackupCron.parseCron(scheduleInput),
          catch: (cause) => toBackupError("configure", cause),
        })
      }
      if (method && secret) {
        yield* Effect.try({
          try: () =>
            method === "token" ? BackupSettings.validateToken(secret) : BackupSettings.validatePassword(secret),
          catch: (cause) => toBackupError("configure", cause),
        })
        if (!server || !username) {
          return yield* Effect.fail(
            new BackupError({
              operation: "configure",
              message: "backup server and username are required when storing a credential",
            }),
          )
        }
      }

      if (!method && !BackupSettings.resolveToken() && (serverInput || usernameInput)) {
        const auth = yield* Effect.tryPromise({
          try: () => BackupSettings.readAuth(roots.state),
          catch: (cause) => toBackupError("configure", cause),
        })
        if (auth?.secret && !BackupSettings.authMatches(auth, server, username)) {
          return yield* Effect.fail(
            new BackupError({
              operation: "configure",
              message:
                "stored backup credential belongs to a different server or username; provide the new token or password with this change",
            }),
          )
        }
      }

      const patch: Record<string, unknown> = {}
      if (input.enabled !== undefined) patch.enabled = input.enabled
      if (serverInput) patch.server = server
      if (usernameInput) patch.username = username
      if (scheduleInput) patch.schedule = scheduleInput
      if (method && secret) {
        yield* Effect.tryPromise({
          try: () => BackupSettings.writeAuth(roots.state, { server: server!, username: username!, method, secret }),
          catch: (cause) => toBackupError("configure", cause),
        })
      }
      if (Object.keys(patch).length) {
        yield* Effect.tryPromise({
          try: () => BackupSettings.writeGlobalConfig(roots.config, patch),
          catch: (cause) => toBackupError("configure", cause),
        })
      }
    })
    const connection = Effect.fnUntraced(function* () {
      const current = yield* settings()
      const auth = yield* Effect.tryPromise({
        try: () => BackupSettings.readAuth(roots.state),
        catch: (cause) => toBackupError("auth", cause),
      })
      return yield* Effect.try({
        try: () => BackupSettings.resolveConnection({ settings: current, auth }),
        catch: (cause) => toBackupError("connection", cause),
      })
    })

    const writeStatus = (next: BackupStatus.Status) =>
      Effect.tryPromise({
        try: () => BackupStatus.write(roots.state, next),
        catch: (cause) => toBackupError("status", cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to write backup status", { message: error.message }),
        ),
      )

    const run = Effect.fn("Backup.run")(function* (options: RunOptions = {}) {
      const started = Date.now()
      const now = options.now ?? new Date()
      const current = yield* settings()
      const auth = yield* Effect.tryPromise({
        try: () => BackupSettings.readAuth(roots.state),
        catch: (cause) => toBackupError("auth", cause),
      })
      const resolved = yield* Effect.try({
        try: () => BackupSettings.resolveConnection({ settings: current, auth }),
        catch: (cause) => toBackupError("connection", cause),
      })
      const lock = yield* acquireLock(options.waitForLock !== false, options.lockDir)
      if (!lock) {
        return {
          skipped: true,
          durationMs: Date.now() - started,
          reason: "another backup is already running",
        } satisfies RunResult
      }

      return yield* Effect.gen(function* () {
        const previous = yield* status()
        yield* writeStatus({ ...previous, running: true, lastRunAt: now.toISOString() })

        const staging = path.join(roots.cache, "backup", `${STAGING_PREFIX}${now.getTime()}-${randomBytes(4).toString("hex")}`)
        return yield* Effect.gen(function* () {
          yield* fs("staging", async () => {
            await cleanupStaging(roots.cache)
            await mkdir(staging, { recursive: true, mode: 0o700 })
          })

          const database = yield* prepareDatabase({
            databasePath: options.databasePath ?? Database.path(),
            staging,
            quickCheck: options.quickCheck === true,
            includeProjectConfig: current.includeProjectConfig,
          })

          const sources = yield* Effect.tryPromise({
            try: () =>
              BackupSource.enumerate(roots, {
                includeToolOutput: current.includeToolOutput,
                includeSnapshots: current.includeSnapshots,
                includeProjectConfig: current.includeProjectConfig,
                projectDirectories: database.projectDirectories,
              }),
            catch: (cause) => toBackupError("source", cause),
          })

          const files = yield* materialize(staging, database.file ? [...sources, database.file] : sources)
          const remote = BackupRemote.make(resolved, http)
          const upload = yield* uploadAll(remote, files, new Set<string>())

          const manifest = yield* Effect.try({
            try: () =>
              BackupManifest.create({
                id: BackupManifest.newID(now),
                created_at: now.toISOString(),
                source: { hostname: os.hostname(), opencode_version: InstallationVersion },
                files: upload.entries,
              }),
            catch: (cause) => toBackupError("manifest", cause),
          })

          let uploadedBytes = upload.uploadedBytes
          yield* remote.createSnapshot(manifest).pipe(
            Effect.catchIf(
              (error: BackupRemote.RemoteError) => error.code === "missing_chunk",
              () =>
                Effect.gen(function* () {
                  const retry = yield* uploadAll(remote, files, new Set<string>())
                  uploadedBytes += retry.uploadedBytes
                  yield* remote.createSnapshot(manifest)
                }),
            ),
            Effect.mapError((error) => toBackupError("upload", error)),
          )

          const finishedAt = new Date()
          yield* writeStatus({
            lastRunAt: now.toISOString(),
            lastSuccessAt: finishedAt.toISOString(),
            lastSnapshotID: manifest.id,
            lastLogicalBytes: manifest.total_bytes,
            lastUploadedBytes: uploadedBytes,
            lastDurationMs: finishedAt.getTime() - started,
            running: false,
          })

          return {
            skipped: false,
            snapshotID: manifest.id,
            logicalBytes: manifest.total_bytes,
            uploadedBytes,
            files: manifest.files.length,
            chunks: manifest.files.reduce((total, file) => total + file.chunks.length, 0),
            durationMs: Date.now() - started,
          } satisfies RunResult
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise({
              try: () => rm(staging, { recursive: true, force: true }),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.catchCause((cause) =>
            writeStatus({
              ...previous,
              running: false,
              lastRunAt: now.toISOString(),
              lastError: BackupStatus.sanitizeError(causeMessage(cause)),
            }).pipe(Effect.flatMap(() => Effect.failCause(cause))),
          ),
        )
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => lock.release(),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to release backup lock", {
                message: BackupStatus.sanitizeError(error),
              }),
            ),
          ),
        ),
      )
    })

    const list = Effect.fn("Backup.list")(function* () {
      const resolved = yield* connection()
      const remote = BackupRemote.make(resolved, http)
      return yield* remote
        .listSnapshots()
        .pipe(Effect.mapError((error) => toBackupError("list", error)))
    })

    const pull = Effect.fn("Backup.pull")(function* (options: PullOptions) {
      const resolved = yield* connection()
      const remote = BackupRemote.make(resolved, http)
      const snapshots = yield* remote
        .listSnapshots()
        .pipe(Effect.mapError((error) => toBackupError("list", error)))
      const id = options.snapshotID ?? snapshots[0]?.id
      if (!id) return yield* Effect.fail(new BackupError({ operation: "pull", message: "no snapshots found" }))
      const manifest = yield* remote
        .getManifest(id)
        .pipe(Effect.mapError((error) => toBackupError("manifest", error)))
      if (manifest.id !== id) {
        return yield* Effect.fail(new BackupError({ operation: "pull", message: "snapshot manifest id mismatch" }))
      }

      const output = yield* prepareOutput(options.out, options.force === true)
      const created = new Date(manifest.created_at)
      let files = 0
      let totalBytes = 0

      for (const file of manifest.files) {
        const target = yield* safeTarget(output, file.path)
        yield* fs("mkdir", () => mkdir(path.dirname(target), { recursive: true }))
        const temporary = path.join(path.dirname(target), `.${path.basename(target)}.backup-${randomBytes(6).toString("hex")}.tmp`)
        const hash = createHash("sha256")
        let size = 0

        yield* Effect.gen(function* () {
          const handle = yield* fs("open", () => open(temporary, "w", 0o600))
          yield* Effect.gen(function* () {
            for (const chunk of file.chunks) {
              const bytes = yield* remote
                .getChunk(chunk)
                .pipe(Effect.mapError((error) => toBackupError("download", error)))
              hash.update(bytes)
              size += bytes.byteLength
              yield* fs("write", () => handle.write(bytes))
            }
          }).pipe(Effect.ensuring(Effect.promise(() => handle.close()).pipe(Effect.catch(() => Effect.void))))

          if (size !== file.size) {
            return yield* Effect.fail(
              new BackupError({
                operation: "pull",
                message: `file size mismatch for ${file.path}: expected ${file.size}, got ${size}`,
              }),
            )
          }
          const sha256 = hash.digest("hex")
          if (sha256 !== file.sha256.toLowerCase()) {
            return yield* Effect.fail(
              new BackupError({ operation: "pull", message: `file SHA-256 mismatch for ${file.path}` }),
            )
          }

          yield* fs("rename", async () => {
            await replace(temporary, target)
            await chmod(target, isSensitive(file.path) ? 0o600 : 0o644).catch(() => undefined)
            await utimes(target, created, created).catch(() => undefined)
          })
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise({ try: () => rm(temporary, { force: true }), catch: () => undefined }).pipe(
              Effect.catch(() => Effect.void),
            ),
          ),
        )
        files += 1
        totalBytes += file.size
      }

      yield* fs("manifest", () =>
        writeFile(path.join(output, "manifest.json"), BackupManifest.encode(manifest), { mode: 0o600 }),
      )

      return { snapshotID: manifest.id, totalBytes, files, out: output } satisfies PullResult
    })

    const restorePlan = Effect.fn("Backup.restorePlan")(function* (options: { from: string }) {
      const text = yield* fs("restore-plan", () => readFile(path.join(options.from, "manifest.json"), "utf8"))
      const manifest = yield* Effect.try({
        try: () => BackupManifest.parseJson(text),
        catch: (cause) => toBackupError("restore-plan", cause),
      })
      const projectIndex = yield* Effect.promise(() => readProjectIndex(options.from))
      const steps: string[] = [
        "Backup restore is manual; no files have been changed.",
        "1. Stop every running opencode server, TUI, desktop, and app process.",
        `2. Move or back up the current data directory: ${roots.data}`,
        `3. Move or back up the current config directory: ${roots.config}`,
        "4. Copy the following files:",
      ]

      for (const file of manifest.files) {
        if (file.path === "projects/index.json") continue
        const target = restoreTarget(roots, projectIndex, file.path)
        steps.push(`   ${path.join(options.from, file.path)} -> ${target}`)
      }

      steps.push(
        "5. Restore file permissions for auth.json and mcp-auth.json (0600) after copying.",
        "6. Start opencode again and verify sessions, providers, and MCP authentication.",
        "7. Keep the displaced directories until the restore is verified.",
      )
      return steps
    })

    return Service.of({ settings, status, ready, authConfigured, configure, run, list, pull, restorePlan })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, httpClient],
})

function loadSettings(configDirectory: string) {
  return Effect.tryPromise({
    try: () => BackupSettings.load({ configDirectory }),
    catch: (cause) => toBackupError("settings", cause),
  }).pipe(Effect.map((loaded) => loaded.settings))
}

function acquireLock(wait: boolean, dir?: string): Effect.Effect<Flock.Lease | undefined, BackupError> {
  const acquire = Effect.tryPromise({
    try: () =>
      Flock.acquire("backup:run", {
        dir,
        staleMs: BACKUP_LOCK_STALE_MS,
        timeoutMs: wait ? undefined : 1,
        baseDelayMs: wait ? undefined : 1,
      }),
    catch: (cause) => cause,
  })
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(acquire)
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    if (failure && isLockTimeout(failure)) return undefined
    return yield* Effect.fail(toBackupError("lock", failure ?? Cause.squash(exit.cause)))
  })
}

function prepareDatabase(input: {
  databasePath: string
  staging: string
  quickCheck: boolean
  includeProjectConfig: boolean
}) {
  return Effect.gen(function* () {
    if (input.databasePath === ":memory:") return { projectDirectories: [] as string[], file: undefined }
    const info = yield* fs("stat", () => statIfExists(input.databasePath))
    if (!info?.isFile()) return { projectDirectories: [] as string[], file: undefined }

    const target = path.join(input.staging, "data", path.basename(input.databasePath))
    yield* Effect.tryPromise({
      try: async (signal) => {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await snapshotDatabaseAsync({ source: input.databasePath, target, quickCheck: input.quickCheck }, signal)
      },
      catch: (cause) => toBackupError("fs:snapshot", cause),
    })
    const projectDirectories = input.includeProjectConfig
      ? yield* Effect.try({
          try: () => readProjectDirectories(target),
          catch: () => [] as string[],
        })
      : []
    return {
      projectDirectories,
      file: { path: `data/${path.basename(input.databasePath)}`, absolute: target } satisfies BackupSource.SourceFile,
    }
  }).pipe(Effect.mapError((cause) => toBackupError("snapshot", cause)))
}

function materialize(staging: string, files: readonly BackupSource.SourceFile[]) {
  return Effect.gen(function* () {
    const result: BackupSource.SourceFile[] = []
    for (const file of files) {
      if (!file.content) {
        result.push(file)
        continue
      }
      const target = path.join(staging, "synthetic", `${BackupChunk.hashBytes(file.content)}.bin`)
      yield* fs("materialize", async () => {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, file.content!, { mode: 0o600 })
      })
      result.push({ path: file.path, absolute: target })
    }
    return result
  }).pipe(Effect.mapError((cause) => toBackupError("materialize", cause)))
}

function uploadAll(remote: BackupRemote.Interface, files: readonly BackupSource.SourceFile[], seen: Set<string>) {
  return Effect.gen(function* () {
    const entries: BackupManifest.FileEntry[] = []
    let uploadedBytes = 0
    for (const file of files) {
      const result = yield* uploadFile(remote, file, seen)
      entries.push(result.entry)
      uploadedBytes += result.uploaded
    }
    return { entries, uploadedBytes }
  })
}

function uploadFile(remote: BackupRemote.Interface, file: BackupSource.SourceFile, seen: Set<string>) {
  if (!file.absolute) return Effect.fail(new BackupError({ operation: "upload", message: `missing local file: ${file.path}` }))
  return Effect.gen(function* () {
    const handle = yield* fs("open", () => open(file.absolute!, "r"))
    const hash = createHash("sha256")
    const chunks: string[] = []
    let size = 0
    let uploaded = 0
    let index = 0

    yield* Effect.gen(function* () {
      while (true) {
        const buffer = Buffer.allocUnsafe(BackupChunk.CHUNK_SIZE)
        const { bytesRead } = yield* fs("read", () => handle.read(buffer, 0, BackupChunk.CHUNK_SIZE, index * BackupChunk.CHUNK_SIZE))
        if (bytesRead === 0) break
        const data = buffer.subarray(0, bytesRead)
        const sha256 = BackupChunk.hashBytes(data)
        hash.update(data)
        size += bytesRead
        chunks.push(sha256)

        if (!seen.has(sha256)) {
          const exists = yield* remote
            .headChunk(sha256)
            .pipe(Effect.mapError((error) => toBackupError("upload", error)))
          if (exists === "exists") {
            seen.add(sha256)
          } else {
            yield* remote
              .putChunk(sha256, data)
              .pipe(Effect.mapError((error) => toBackupError("upload", error)))
            seen.add(sha256)
            uploaded += bytesRead
          }
        }
        index += 1
      }
    }).pipe(Effect.ensuring(Effect.promise(() => handle.close()).pipe(Effect.catch(() => Effect.void))))

    return {
      entry: { path: file.path, size, sha256: hash.digest("hex"), chunks } satisfies BackupManifest.FileEntry,
      uploaded,
    }
  }).pipe(Effect.mapError((cause) => toBackupError("upload", cause)))
}

function prepareOutput(input: string, force: boolean) {
  return Effect.gen(function* () {
    const info = yield* fs("lstat", () => lstatIfExists(input))
    if (info && !info.isDirectory()) {
      return yield* Effect.fail(new BackupError({ operation: "pull", message: `output path is not a directory: ${input}` }))
    }
    if (info && !force) {
      const entries = yield* fs("readdir", () => readdir(input))
      if (entries.length) {
        return yield* Effect.fail(
          new BackupError({
            operation: "pull",
            message: `output directory is not empty: ${input} (use --force to overwrite)`,
          }),
        )
      }
    }
    yield* fs("mkdir", () => mkdir(input, { recursive: true, mode: 0o700 }))
    return yield* fs("realpath", () => realpath(input))
  })
}

function safeTarget(root: string, logical: string) {
  return Effect.gen(function* () {
    BackupManifest.validatePath(logical)
    const target = path.resolve(root, logical)
    const relative = path.relative(root, target)
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* Effect.fail(new BackupError({ operation: "pull", message: `unsafe manifest path: ${logical}` }))
    }
    const parent = path.dirname(target)
    yield* fs("mkdir", () => mkdir(parent, { recursive: true, mode: 0o700 }))
    const parentReal = yield* fs("realpath", () => realpath(parent))
    const fromRoot = path.relative(root, parentReal)
    if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
      return yield* Effect.fail(new BackupError({ operation: "pull", message: `output path escapes the output directory: ${logical}` }))
    }
    return target
  })
}

async function readProjectIndex(from: string) {
  const text = await readFile(path.join(from, "projects", "index.json"), "utf8").catch(() => undefined)
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || !("projects" in parsed)) return {}
    const projects = (parsed as { projects?: unknown }).projects
    if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return {}
    return Object.fromEntries(
      Object.entries(projects).flatMap(([key, value]) => (typeof value === "string" ? [[key, value] as const] : [])),
    )
  } catch {
    return {}
  }
}

function restoreTarget(
  roots: { data: string; config: string },
  projectIndex: Readonly<Record<string, string>>,
  logical: string,
) {
  const parts = logical.split("/")
  if (parts[0] === "data") return path.join(roots.data, ...parts.slice(1))
  if (parts[0] === "config") return path.join(roots.config, ...parts.slice(1))
  if (parts[0] === "projects" && parts[1] !== undefined) {
    const root = projectIndex[parts[1]]
    if (root) return path.join(root, ...parts.slice(2))
  }
  return `<unmapped:${logical}>`
}

function isSensitive(logical: string) {
  const name = logical.split("/").at(-1)
  return name === "auth.json" || name === "mcp-auth.json"
}

async function cleanupStaging(cacheDirectory: string) {
  const root = path.join(cacheDirectory, "backup")
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return []
    throw error
  })
  // Runs while holding the backup lock, so every staging-* directory is a leftover from an interrupted run.
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue
    await rm(path.join(root, entry.name), { recursive: true, force: true })
  }
}

async function replace(source: string, target: string) {
  try {
    await rename(source, target)
  } catch (error) {
    if (!isCode(error, "EEXIST") && !isCode(error, "EPERM") && !isCode(error, "EACCES")) throw error
    await rm(target, { force: true })
    await rename(source, target)
  }
}

async function statIfExists(file: string) {
  try {
    return await stat(file)
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  }
}

async function lstatIfExists(file: string) {
  try {
    return await lstat(file)
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  }
}

function fs<A>(operation: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toBackupError(`fs:${operation}`, cause),
  })
}

function toBackupError(operation: string, cause: unknown) {
  if (cause instanceof BackupError) return cause
  if (typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Backup.Error") {
    return cause as BackupError
  }
  return new BackupError({ operation, message: BackupStatus.sanitizeError(cause) })
}

function causeMessage(cause: Cause.Cause<unknown>) {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (failure instanceof Error) return failure.message
  return BackupStatus.sanitizeError(Cause.squash(cause))
}

function isLockTimeout(error: unknown) {
  return error instanceof Error && error.message.startsWith("Timed out waiting for lock")
}

function isCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
