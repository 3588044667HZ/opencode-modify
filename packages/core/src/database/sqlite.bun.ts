import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
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

const TypeId = "~@opencode-ai/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
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
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
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
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
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

  const source = new Database(input.source, { readonly: true, create: false, readwrite: false })
  let failure: unknown
  try {
    source.run("VACUUM INTO ?", [input.target])
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
    const snapshot = new Database(input.target, { readonly: true, create: false, readwrite: false })
    let checkFailure: string | undefined
    try {
      const rows = snapshot.query("PRAGMA quick_check").values() as Array<Array<string>>
      const result = rows.flat().join("; ")
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
  const db = new Database(filename, { readonly: true, create: false, readwrite: false })
  try {
    const rows = db.query("SELECT DISTINCT directory FROM project_directory").values() as Array<[string]>
    const worktrees = db.query("SELECT DISTINCT worktree FROM project").values() as Array<[string]>
    return [
      ...new Set(
        [...rows, ...worktrees].flatMap((row) =>
          typeof row[0] === "string" && row[0] ? [row[0]] : [],
        ),
      ),
    ]
  } catch {
    return []
  } finally {
    db.close()
  }
}

const SNAPSHOT_WORKER_SOURCE = `
const { Database } = require("bun:sqlite");
const fs = require("node:fs");
const path = require("node:path");
self.onmessage = (event) => {
  const input = event.data;
  try {
    fs.rmSync(input.target, { force: true });
    fs.mkdirSync(path.dirname(input.target), { recursive: true, mode: 0o700 });
    const source = new Database(input.source, { readonly: true, create: false, readwrite: false });
    let failure;
    try {
      source.run("VACUUM INTO ?", [input.target]);
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
      const snapshot = new Database(input.target, { readonly: true, create: false, readwrite: false });
      let result = "";
      try {
        const rows = snapshot.query("PRAGMA quick_check").values();
        result = rows.flat().join("; ");
      } finally {
        snapshot.close();
      }
      if (result.toLowerCase() !== "ok") throw new Error("SQLite quick_check failed: " + result.slice(0, 500));
    }
    self.postMessage({ ok: true });
  } catch (error) {
    try {
      fs.rmSync(input.target, { force: true });
    } catch {}
    self.postMessage({ ok: false, message: error && error.message ? error.message : String(error) });
  }
};
`;

/** Runs the snapshot in a worker so the server event loop and Flock heartbeat stay responsive. */
export function snapshotDatabaseAsync(input: SnapshotInput, signal?: AbortSignal): Promise<void> {
  if (input.source === input.target) return Promise.reject(new Error("snapshot source and target must differ"))
  if (input.source === ":memory:") return Promise.reject(new Error("cannot snapshot an in-memory database"))
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("snapshot aborted"))

  return new Promise((resolve, reject) => {
    const worker = new Worker("data:text/javascript," + encodeURIComponent(SNAPSHOT_WORKER_SOURCE))
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
    worker.onmessage = (event: MessageEvent<{ ok: boolean; message?: string }>) =>
      finish(event.data.ok ? undefined : new Error(event.data.message ?? "snapshot failed"))
    worker.onerror = (event) => finish(new Error(event.message || "snapshot worker failed"))
    worker.postMessage(input)
  })
}