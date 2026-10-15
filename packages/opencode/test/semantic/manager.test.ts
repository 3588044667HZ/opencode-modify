import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as Client from "@/semantic/client"
import { Semantic, socketPathFor } from "@/semantic/manager"
import * as Protocol from "@/semantic/protocol"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import {
  disposeAllInstancesEffect,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { SAMPLE_RESULT } from "./fixture"

const fakeDaemon = path.join(import.meta.dir, "fake-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const semanticLayer = () => LayerNode.compile(LayerNode.group([Semantic.node, EventV2Bridge.node]))
const it = testEffect(semanticLayer())

const statusOf = (event: { data: unknown }) => (event.data as { status?: string }).status

// 需要真实 InstanceStore（而非 it.instance 的固定 config 选项）：socket_dir / 预启动守护
// 必须依赖运行期生成的临时目录，因此手动用 tmpdirScoped + provideInstance 搭实例。
const withInstanceStores = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))

const canConnect = async (socketPath: string) => {
  const client = await Client.connect(socketPath, { connect_timeout_ms: 200 }).catch(() => undefined)
  if (!client) return false
  client.close()
  return true
}

// Windows 下已绑定的 AF_UNIX socket 文件 fs.stat 会 EACCES，用 fs.access 判断存在性。
const exists = (p: string) => fs.access(p).then(() => true, () => false)

const spawnFakeDaemon = (args: string[]) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.spawn([process.execPath, fakeDaemon, ...args], { stdout: "ignore", stderr: "ignore" })),
    (daemon) =>
      Effect.promise(async () => {
        daemon.kill()
        await daemon.exited.catch(() => {})
      }),
  )

const waitForSocket = (socketPath: string) =>
  pollWithTimeout(
    Effect.promise(async () => ((await canConnect(socketPath)) ? true : undefined)),
    `no daemon listening on ${socketPath}`,
    "10 seconds",
  )

const pollReady = (semantic: Semantic.Interface) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const current = yield* semantic.status()
      return current.status === "ready" ? current : undefined
    }),
    "semantic engine never became ready",
    "15 seconds",
  )

describe("semantic manager", () => {
  it.instance("reports disabled when semantic is not enabled", () =>
    Effect.gen(function* () {
      const semantic = yield* Semantic.Service
      const status = yield* semantic.status()
      expect(status.status).toBe("disabled")

      const error = yield* semantic.readView({ file: "a.py", view: "entry" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Protocol.UnavailableError)
      expect(error.message).toContain("disabled")
    }),
  )

  it.instance(
    "fails when command is not configured and publishes the failure",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        const events = yield* EventV2Bridge.Service
        const failed = yield* Deferred.make<void>()
        const seen: string[] = []
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== "semantic.indexing") return Effect.void
          seen.push(statusOf(event) ?? "")
          if (statusOf(event) === "failed") Deferred.doneUnsafe(failed, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* semantic.init()
        yield* awaitWithTimeout(Deferred.await(failed), "no failed semantic.indexing event")

        const status = yield* semantic.status()
        expect(status.status).toBe("failed")
        expect(status.error).toBe("semantic.command is not configured")
        expect(seen.at(-1)).toBe("failed")
      }),
    { config: { semantic: { enabled: true } } },
    20_000,
  )

  it.instance(
    "spawns the daemon, publishes transitions, and answers read_view",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        const events = yield* EventV2Bridge.Service
        const statuses: string[] = []
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === "semantic.indexing") statuses.push(statusOf(event) ?? "")
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* semantic.init()
        const status = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* semantic.status()
            return current.status === "ready" ? current : undefined
          }),
          "semantic engine never became ready",
          "15 seconds",
        )

        expect(status.progress).toBe(1)
        expect(statuses[0]).toBe("starting")
        expect(statuses).toContain("indexing")
        expect(statuses.at(-1)).toBe("ready")

        const result = yield* semantic.readView({ file: "engine.ts", view: "entry" })
        expect(result).toEqual(SAMPLE_RESULT)
      }),
    { config: { semantic: { enabled: true, command: command("--indexing") } } },
    20_000,
  )

  it.instance(
    "reports progress while indexing",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        yield* semantic.init()
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* semantic.status()
            return current.status === "indexing" ? current : undefined
          }),
          "semantic engine never reported indexing",
          "15 seconds",
        )

        const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
        if (!(error instanceof Protocol.UnavailableError)) throw new Error(`unexpected error: ${String(error)}`)
        expect(error.progress).toBe(0.42)
        expect(error.message).toContain("not ready")
      }),
    { config: { semantic: { enabled: true, command: command("--indexing-forever") } } },
    20_000,
  )

  it.instance(
    "marks failed when the daemon exits early",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        yield* semantic.init()
        const status = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* semantic.status()
            return current.status === "failed" ? current : undefined
          }),
          "semantic engine never reported failure",
          "15 seconds",
        )
        expect(status.error).toContain("exited with code 3")

        const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Protocol.UnavailableError)
        expect(error.message).toContain("semantic engine failed")
      }),
    { config: { semantic: { enabled: true, command: [process.execPath, "-e", "process.exit(3)"] } } },
    20_000,
  )
})

describe("semantic manager socket reuse", () => {
  it.live("uses a stable per-directory socket path", () =>
    Effect.sync(() => {
      const dir = path.join(os.tmpdir(), "opencode-semantic-manager-path")
      const socketDir = path.join(os.tmpdir(), "opencode-semantic-manager-path-sockets")
      const first = socketPathFor(dir, socketDir)
      const name = path.basename(first.path)
      expect(name).toMatch(/^opencode-semantic-[0-9a-f]{10}\.sock$/)
      expect(first.path).toBe(path.join(socketDir, name))
      expect(socketPathFor(dir, socketDir)).toEqual(first)
      expect(path.basename(socketPathFor(dir).path)).toBe(name)
      expect(socketPathFor(dir).dir).toBe(os.tmpdir())
      expect(socketPathFor(path.join(dir, "nested"), socketDir).path).not.toBe(first.path)
      if (process.platform === "win32") {
        expect(socketPathFor(dir.toUpperCase(), socketDir)).toEqual(first)
        expect(socketPathFor(dir.replace(/\\/g, "/"), socketDir)).toEqual(first)
      }
    }),
  )

  it.live(
    "reuses an existing daemon instead of spawning the configured command",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "spawned.marker")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              // 一旦被执行的 command 会写 marker 并退出 3；marker 不存在即证明复用路径没有 spawn。
              command: [
                process.execPath,
                "-e",
                `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(3)`,
              ],
            },
          },
        })
        const socket = socketPathFor(dir, socketDir)
        const daemon = yield* spawnFakeDaemon([socket.path])
        yield* waitForSocket(socket.path)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          const status = yield* pollReady(semantic)
          expect(status.progress).toBe(1)
          expect(yield* semantic.readView({ file: "engine.ts", view: "entry" })).toEqual(SAMPLE_RESULT)
        }).pipe(provideInstance(dir))

        expect(daemon.exitCode).toBe(null)
        expect(yield* Effect.promise(() => exists(marker))).toBe(false)
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "removes a stale socket file and spawns a fresh daemon",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, socket_dir: socketDir, command: command() } },
        })
        const socket = socketPathFor(dir, socketDir)
        yield* Effect.promise(() => fs.writeFile(socket.path, "stale"))
        expect(yield* Effect.promise(() => exists(socket.path))).toBe(true)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* pollReady(semantic)
          expect(yield* semantic.readView({ file: "engine.ts", view: "entry" })).toEqual(SAMPLE_RESULT)
        }).pipe(provideInstance(dir))
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "keeps a reused daemon and its socket alive when the instance is disposed",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "spawned.marker")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              command: [
                process.execPath,
                "-e",
                `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(3)`,
              ],
            },
          },
        })
        const socket = socketPathFor(dir, socketDir)
        const daemon = yield* spawnFakeDaemon([socket.path])
        yield* waitForSocket(socket.path)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* pollReady(semantic)
          yield* disposeAllInstancesEffect
        }).pipe(provideInstance(dir))

        // dispose 后守护不收到 shutdown、socket 不删：等一段真实时间再确认进程仍存活且可 ping。
        yield* Effect.sleep("300 millis")
        expect(daemon.exitCode).toBe(null)
        expect(yield* Effect.promise(() => exists(socket.path))).toBe(true)
        expect(yield* Effect.promise(() => exists(marker))).toBe(false)
        const client = yield* Effect.promise(() => Client.connect(socket.path, { connect_timeout_ms: 500 }))
        const ping = yield* Effect.promise(() => client.ping())
        expect(ping.indexing).toBe(false)
        client.close()
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "cleans up a daemon it spawned when the instance is disposed",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, socket_dir: socketDir, command: command() } },
        })
        const socket = socketPathFor(dir, socketDir)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* pollReady(semantic)
          yield* disposeAllInstancesEffect
        }).pipe(provideInstance(dir))

        yield* pollWithTimeout(
          Effect.promise(async () => ((await canConnect(socket.path)) ? undefined : true)),
          "socket still accepted connections after dispose",
          "10 seconds",
        )
        expect(yield* Effect.promise(() => exists(socket.path))).toBe(false)
      }).pipe(withInstanceStores),
    20_000,
  )
})
