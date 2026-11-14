import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { drizzle } from "drizzle-orm/node-sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/SqliteNode" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly timeout?: number
  readonly allowExtension?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as DatabaseSync

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed(statement.all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, Client.SafeIntegers))
        statement.setReturnArrays(true)
        try {
          return Effect.succeed(
            statement.all(...(params as SQLInputValue[])) as unknown as ReadonlyArray<ReadonlyArray<unknown>>,
          )
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new DatabaseSync(config.filename, {
        readOnly: config.readonly,
        timeout: config.timeout,
        allowExtension: config.allowExtension,
        enableForeignKeyConstraints: true,
        open: true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true && config.readonly !== true) native.exec("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as DatabaseSync }) as unknown as Sqlite.DrizzleClient
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}

export interface SnapshotInput {
  readonly source: string
  readonly target: string
  readonly quickCheck?: boolean
}

/** Copies a live SQLite database through a separate read-only connection without loading it into memory. */
export function snapshotDatabase(input: SnapshotInput) {
  if (input.source === input.target) throw new Error("snapshot source and target must differ")
  if (input.source === ":memory:") throw new Error("cannot snapshot an in-memory database")
  rmSync(input.target, { force: true })
  mkdirSync(dirname(input.target), { recursive: true, mode: 0o700 })

  const source = new DatabaseSync(input.source, { readOnly: true })
  let failure: unknown
  try {
    source.prepare("VACUUM INTO ?").run(input.target)
  } catch (error) {
    failure = error
  } finally {
    source.close()
  }
  if (failure) {
    rmSync(input.target, { force: true })
    throw failure
  }
  try {
    chmodSync(input.target, 0o600)
  } catch {}

  if (input.quickCheck === true) {
    const snapshot = new DatabaseSync(input.target, { readOnly: true })
    let checkFailure: string | undefined
    try {
      const rows = snapshot.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>
      const result = rows.map((row) => String(Object.values(row)[0])).join("; ")
      if (result.toLowerCase() !== "ok") checkFailure = result
    } finally {
      snapshot.close()
    }
    if (checkFailure !== undefined) {
      rmSync(input.target, { force: true })
      throw new Error(`SQLite quick_check failed: ${checkFailure.slice(0, 500)}`)
    }
  }
}

export function readProjectDirectories(filename: string): string[] {
  if (!existsSync(filename)) return []
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const rows = db.prepare("SELECT DISTINCT directory FROM project_directory").all() as Array<{
      directory?: unknown
    }>
    const worktrees = db.prepare("SELECT DISTINCT worktree FROM project").all() as Array<{
      worktree?: unknown
    }>
    return [
      ...new Set([
        ...rows.flatMap((row) => (typeof row.directory === "string" && row.directory ? [row.directory] : [])),
        ...worktrees.flatMap((row) => (typeof row.worktree === "string" && row.worktree ? [row.worktree] : [])),
      ]),
    ]
  } catch {
    return []
  } finally {
    db.close()
  }
}

const SNAPSHOT_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const input = workerData;
try {
  fs.rmSync(input.target, { force: true });
  fs.mkdirSync(path.dirname(input.target), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(input.source, { readOnly: true });
  let failure;
  try {
    source.prepare("VACUUM INTO ?").run(input.target);
  } catch (error) {
    failure = error;
  } finally {
    source.close();
  }
  if (failure) throw failure;
  try {
    fs.chmodSync(input.target, 0o600);
  } catch {}
  if (input.quickCheck === true) {
    const snapshot = new DatabaseSync(input.target, { readOnly: true });
    let result = "";
    try {
      const rows = snapshot.prepare("PRAGMA quick_check").all();
      result = rows.map((row) => String(Object.values(row)[0])).join("; ");
    } finally {
      snapshot.close();
    }
    if (result.toLowerCase() !== "ok") throw new Error("SQLite quick_check failed: " + result.slice(0, 500));
  }
  parentPort.postMessage({ ok: true });
} catch (error) {
  try {
    fs.rmSync(input.target, { force: true });
  } catch {}
  parentPort.postMessage({ ok: false, message: error && error.message ? error.message : String(error) });
}
`;

/** Runs the snapshot in a worker so the server event loop and Flock heartbeat stay responsive. */
export function snapshotDatabaseAsync(input: SnapshotInput, signal?: AbortSignal): Promise<void> {
  if (input.source === input.target) return Promise.reject(new Error("snapshot source and target must differ"))
  if (input.source === ":memory:") return Promise.reject(new Error("cannot snapshot an in-memory database"))
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("snapshot aborted"))

  return new Promise((resolve, reject) => {
    const worker = new Worker(SNAPSHOT_WORKER_SOURCE, { eval: true, workerData: input })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      void worker.terminate()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(new Error("snapshot aborted"))
    signal?.addEventListener("abort", abort, { once: true })
    worker.once("message", (message: { ok: boolean; message?: string }) =>
      finish(message.ok ? undefined : new Error(message.message ?? "snapshot failed")),
    )
    worker.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}