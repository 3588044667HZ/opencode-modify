import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer } from "effect"
import { createHash } from "crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "os"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as Client from "@/semantic/client"
import { RetryPolicy, Semantic, locatorPathFor } from "@/semantic/manager"
import * as Protocol from "@/semantic/protocol"
import * as Transport from "@/semantic/transport"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import {
  disposeAllInstancesEffect,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { SAMPLE_RESULT } from "./fixture"

const fakeDaemon = path.join(import.meta.dir, "fake-daemon.ts")
const slowDaemon = path.join(import.meta.dir, "slow-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const semanticLayer = () => LayerNode.compile(LayerNode.group([Semantic.node, EventV2Bridge.node]))
const it = testEffect(semanticLayer())

const statusOf = (event: { data: unknown }) => (event.data as { status?: string }).status

// 需要真实 InstanceStore（而非 it.instance 的固定 config 选项）：socket_dir / 预启动守护
// 必须依赖运行期生成的临时目录，因此手动用 tmpdirScoped + provideInstance 搭实例。
const withInstanceStores = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))

interface Locator {
  readonly port: number
  readonly token: string
}

const readLocator = async (locatorPath: string): Promise<Locator | undefined> => {
  const text = await fs.readFile(locatorPath, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Locator
  } catch {
    return undefined
  }
}

const connectLocator = async (locatorPath: string, timeoutMs = 200) => {
  const locator = await readLocator(locatorPath)
  if (!locator) return undefined
  return Client.connect(
    { host: "127.0.0.1", port: locator.port, token: locator.token },
    { connect_timeout_ms: timeoutMs },
  ).catch(() => undefined)
}

// locator 不可读或 hello 失败都算"连不上"。
const canConnect = async (locatorPath: string) => {
  const client = await connectLocator(locatorPath)
  if (!client) return false
  client.close()
  return true
}

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

const waitForLocator = (locatorPath: string) =>
  pollWithTimeout(
    Effect.promise(async () => ((await canConnect(locatorPath)) ? true : undefined)),
    `no daemon listening for ${locatorPath}`,
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

// 惰性拉起：首次公开请求会触发后台 spawn，该请求本身立即以 UnavailableError 返回。
const triggerSpawn = (semantic: Semantic.Interface) =>
  semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.catch(() => Effect.void))

const countLines = (file: string) =>
  Effect.promise(() =>
    fs.readFile(file, "utf8").then(
      (text) => text.trim().split("\n").filter(Boolean).length,
      () => 0,
    ),
  )

interface RecordedEnv {
  readonly exclude: string
  readonly ide: string
  readonly ideHome: string
  readonly jdkHome: string
}

// 启动一个带 --record-env / --record-argv 的 fake daemon，返回落盘的环境记录、位置参数与临时目录。
const recordedDaemon = (input: { exclude?: string[]; ide?: string; ide_home?: string; jdk_home?: string }) =>
  Effect.gen(function* () {
    const socketDir = yield* tmpdirScoped()
    const envRecord = path.join(socketDir, "recorded-env.json")
    const argvRecord = path.join(socketDir, "recorded-argv.json")
    const dir = yield* tmpdirScoped({
      config: {
        semantic: {
          enabled: true,
          socket_dir: socketDir,
          command: command(`--record-env=${envRecord}`, `--record-argv=${argvRecord}`),
          ...input,
        },
      },
    })

    yield* Effect.gen(function* () {
      const semantic = yield* Semantic.Service
      yield* semantic.init()
      yield* triggerSpawn(semantic)
      yield* pollReady(semantic)
    }).pipe(provideInstance(dir))

    const env = JSON.parse(yield* Effect.promise(() => fs.readFile(envRecord, "utf8"))) as RecordedEnv
    const argv = JSON.parse(yield* Effect.promise(() => fs.readFile(argvRecord, "utf8"))) as string[]
    return { env, argv, dir, socketDir }
  }).pipe(withInstanceStores)

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

  it.live(
    "materializes an idle state on init without spawning the configured command",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "spawned.marker")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              // 一旦被执行的 command 会写 marker 并退出 3；marker 不存在即证明 init 没有 spawn。
              command: [
                process.execPath,
                "-e",
                `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(3)`,
              ],
            },
          },
        })

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          expect((yield* semantic.status()).status).toBe("idle")
          // 给潜在的错误 spawn 留出真实时间。
          yield* Effect.sleep("500 millis")
          expect(yield* Effect.promise(() => exists(marker))).toBe(false)
          expect((yield* semantic.status()).status).toBe("idle")
        }).pipe(provideInstance(dir))
      }).pipe(withInstanceStores),
    20_000,
  )

  it.instance(
    "first readView lazily spawns the daemon and eventually answers",
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
        expect((yield* semantic.status()).status).toBe("idle")
        expect(statuses).toEqual([])

        // 首次请求触发惰性拉起：本请求立即返回 starting，warmup 在后台继续。
        const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
        if (!(error instanceof Protocol.UnavailableError)) throw new Error(`unexpected error: ${String(error)}`)
        expect(error.message).toContain("not ready")

        const status = yield* pollReady(semantic)
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
    "reports progress while indexing after the lazy spawn",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        yield* semantic.init()
        yield* triggerSpawn(semantic)
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
        yield* triggerSpawn(semantic)
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

  it.live("uses a 180s socket ready timeout for cold daemon starts", () =>
    Effect.sync(() => {
      expect(Protocol.Defaults.socketReadyTimeoutMs).toBe(180_000)
    }),
  )
})

describe("semantic manager exclude env", () => {
  it.live(
    "passes semantic.exclude to the daemon as a JSON array",
    () =>
      Effect.gen(function* () {
        const exclude = ["node_modules", "packages/*/dist"]
        const { env } = yield* recordedDaemon({ exclude })
        expect(env.exclude).toBe(JSON.stringify(exclude))
      }),
    20_000,
  )

  it.live(
    "leaves OPENCODE_SEMANTIC_EXCLUDE unset when semantic.exclude is omitted",
    () =>
      Effect.gen(function* () {
        expect((yield* recordedDaemon({})).env.exclude).toBe("")
      }),
    20_000,
  )

  it.live(
    "leaves OPENCODE_SEMANTIC_EXCLUDE unset when semantic.exclude is an empty list",
    () =>
      Effect.gen(function* () {
        expect((yield* recordedDaemon({ exclude: [] })).env.exclude).toBe("")
      }),
    20_000,
  )
})

describe("semantic manager ide selection", () => {
  // 测试自算 ideKey，规范化规则与 manager 一致：trim、反斜杠转正斜杠、win32 小写，SHA-1 前 6 位。
  const ideKeyOf = (value: string) => {
    const normalized = value.trim().replace(/\\/g, "/")
    return createHash("sha1")
      .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
      .digest("hex")
      .slice(0, 6)
  }

  const suffixedName = (legacyPath: string, value: string) =>
    path.basename(legacyPath).replace(/\.port$/, `-${ideKeyOf(value)}.port`)

  it.live(
    "passes semantic.ide, ide_home and jdk_home and suffixes the locator with the ideKey",
    () =>
      Effect.gen(function* () {
        const ide = "pycharm"
        const { env, argv, dir, socketDir } = yield* recordedDaemon({
          ide,
          ide_home: "D:/tools/PyCharm",
          jdk_home: "D:/tools/jdk",
        })
        expect(env.ide).toBe(ide)
        expect(env.ideHome).toBe("D:/tools/PyCharm")
        expect(env.jdkHome).toBe("D:/tools/jdk")

        const legacy = locatorPathFor(dir, socketDir)
        const expected = locatorPathFor(dir, socketDir, ideKeyOf(ide))
        expect(path.basename(expected.path)).toMatch(/^opencode-semantic-[0-9a-f]{10}-[0-9a-f]{6}\.port$/)
        expect(path.basename(expected.path)).toBe(suffixedName(legacy.path, ide))
        expect(argv.at(-1)).toBe(expected.path)
      }),
    20_000,
  )

  it.live(
    "leaves the ide env unset and keeps the legacy locator name when nothing is configured",
    () =>
      Effect.gen(function* () {
        const { env, argv, dir, socketDir } = yield* recordedDaemon({})
        expect(env.ide).toBe("")
        expect(env.ideHome).toBe("")
        expect(env.jdkHome).toBe("")
        const legacy = locatorPathFor(dir, socketDir)
        expect(path.basename(legacy.path)).toMatch(/^opencode-semantic-[0-9a-f]{10}\.port$/)
        expect(argv.at(-1)).toBe(legacy.path)
      }),
    20_000,
  )

  it.live(
    'treats semantic.ide "auto" as unset',
    () =>
      Effect.gen(function* () {
        const { env, argv, dir, socketDir } = yield* recordedDaemon({ ide: "auto" })
        expect(env.ide).toBe("")
        expect(env.ideHome).toBe("")
        expect(env.jdkHome).toBe("")
        const legacy = locatorPathFor(dir, socketDir)
        expect(path.basename(legacy.path)).toMatch(/^opencode-semantic-[0-9a-f]{10}\.port$/)
        expect(argv.at(-1)).toBe(legacy.path)
      }),
    20_000,
  )

  it.live(
    "falls back to semantic.ide_home for the locator suffix when semantic.ide is unset",
    () =>
      Effect.gen(function* () {
        const ideHome = "D:\\Tools\\WebStorm"
        const { env, argv, dir, socketDir } = yield* recordedDaemon({ ide_home: ideHome })
        expect(env.ide).toBe("")
        expect(env.ideHome).toBe(ideHome)

        const legacy = locatorPathFor(dir, socketDir)
        const expected = locatorPathFor(dir, socketDir, ideKeyOf(ideHome))
        expect(path.basename(expected.path)).toBe(suffixedName(legacy.path, ideHome))
        expect(argv.at(-1)).toBe(expected.path)
      }),
    20_000,
  )
})

describe("semantic manager locator reuse", () => {
  it.live("uses a stable per-directory locator path", () =>
    Effect.sync(() => {
      const dir = path.join(os.tmpdir(), "opencode-semantic-manager-path")
      const socketDir = path.join(os.tmpdir(), "opencode-semantic-manager-path-sockets")
      const first = locatorPathFor(dir, socketDir)
      const name = path.basename(first.path)
      expect(name).toMatch(/^opencode-semantic-[0-9a-f]{10}\.port$/)
      expect(first.path).toBe(path.join(socketDir, name))
      expect(locatorPathFor(dir, socketDir)).toEqual(first)
      expect(path.basename(locatorPathFor(dir).path)).toBe(name)
      expect(locatorPathFor(dir).dir).toBe(os.tmpdir())
      expect(locatorPathFor(path.join(dir, "nested"), socketDir).path).not.toBe(first.path)
      if (process.platform === "win32") {
        expect(locatorPathFor(dir.toUpperCase(), socketDir)).toEqual(first)
        expect(locatorPathFor(dir.replace(/\\/g, "/"), socketDir)).toEqual(first)
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
        const locator = locatorPathFor(dir, socketDir)
        const daemon = yield* spawnFakeDaemon([locator.path])
        yield* waitForLocator(locator.path)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          expect((yield* semantic.status()).status).toBe("idle")
          yield* triggerSpawn(semantic)
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
    "removes a stale locator file and spawns a fresh daemon",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, socket_dir: socketDir, command: command() } },
        })
        const locator = locatorPathFor(dir, socketDir)
        // 陈旧 locator：JSON 合法但指向一个已不再监听的端口（先占用再释放，保证端口无监听）。
        const deadPort = yield* Effect.promise(async () => {
          const probe = net.createServer()
          await new Promise<void>((done) => probe.listen(0, "127.0.0.1", () => done()))
          const port = (probe.address() as net.AddressInfo).port
          await new Promise<void>((done) => probe.close(() => done()))
          return port
        })
        yield* Effect.promise(() =>
          fs.writeFile(locator.path, JSON.stringify({ v: 1, port: deadPort, token: "a".repeat(32), pid: 1 })),
        )
        expect(yield* Effect.promise(() => exists(locator.path))).toBe(true)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
          expect(yield* semantic.readView({ file: "engine.ts", view: "entry" })).toEqual(SAMPLE_RESULT)
        }).pipe(provideInstance(dir))

        // 新守护必须覆盖陈旧 locator（port 可能被复用，用随机 token 判定是新实例）。
        const fresh = yield* Effect.promise(() => readLocator(locator.path))
        expect(fresh).toBeDefined()
        expect(fresh!.token).not.toBe("a".repeat(32))
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "keeps a reused daemon and its locator alive when the instance is disposed",
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
        const locator = locatorPathFor(dir, socketDir)
        const daemon = yield* spawnFakeDaemon([locator.path])
        yield* waitForLocator(locator.path)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
          yield* disposeAllInstancesEffect
        }).pipe(provideInstance(dir))

        // dispose 后守护不收到 shutdown、locator 不删：等一段真实时间再确认进程仍存活且可 ping。
        yield* Effect.sleep("300 millis")
        expect(daemon.exitCode).toBe(null)
        expect(yield* Effect.promise(() => exists(locator.path))).toBe(true)
        expect(yield* Effect.promise(() => exists(marker))).toBe(false)
        const client = yield* Effect.promise(() => connectLocator(locator.path, 500))
        expect(client).toBeDefined()
        const ping = yield* Effect.promise(() => client!.ping())
        expect(ping.indexing).toBe(false)
        client!.close()
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
        const locator = locatorPathFor(dir, socketDir)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
          yield* disposeAllInstancesEffect
        }).pipe(provideInstance(dir))

        yield* pollWithTimeout(
          Effect.promise(async () => ((await canConnect(locator.path)) ? undefined : true)),
          "locator still accepted connections after dispose",
          "10 seconds",
        )
        expect(yield* Effect.promise(() => exists(locator.path))).toBe(false)
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "spawns the daemon with the locator path as the last argv",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const recorded = path.join(socketDir, "argv.json")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: { enabled: true, socket_dir: socketDir, command: command(`--record-argv=${recorded}`) },
          },
        })

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
        }).pipe(provideInstance(dir))

        const positional = JSON.parse(yield* Effect.promise(() => fs.readFile(recorded, "utf8"))) as string[]
        expect(positional).toHaveLength(2)
        expect(positional.at(-2)).toBe(dir)
        expect(positional.at(-1)).toBe(locatorPathFor(dir, socketDir).path)
      }).pipe(withInstanceStores),
    20_000,
  )
})

describe("semantic manager handshake", () => {
  it.live(
    "rejects a wrong token and pre-handshake methods with -32019",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, socket_dir: socketDir, command: command() } },
        })
        const locator = locatorPathFor(dir, socketDir)
        yield* spawnFakeDaemon([locator.path])
        yield* waitForLocator(locator.path)
        const info = yield* Effect.promise(() => readLocator(locator.path))
        expect(info).toBeDefined()

        // 错误 token：Client.connect 在 hello 阶段失败并归一化为 ConnectionError。
        const rejected = yield* Effect.promise(() =>
          Client.connect(
            { host: "127.0.0.1", port: info!.port, token: "0".repeat(32) },
            { connect_timeout_ms: 2_000 },
          ).then(
            () => undefined,
            (error: unknown) => error,
          ),
        )
        expect(rejected).toBeInstanceOf(Protocol.ConnectionError)

        // 未 hello 直接调用方法：帧级 -32019 且连接被关闭。
        const transport = yield* Effect.promise(() =>
          Transport.connect({ host: "127.0.0.1", port: info!.port }, { timeout_ms: 2_000 }),
        )
        const firstFrame = new Promise<Protocol.Message>((resolve) => transport.onMessage(resolve))
        const transportClosed = new Promise<void>((resolve) => transport.onClose(() => resolve()))
        transport.write({ jsonrpc: "2.0", id: 1, method: "ping" })
        const frame = yield* Effect.promise(() => firstFrame)
        expect(frame).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: Protocol.ErrorCode.unauthorized } })
        yield* Effect.promise(() => transportClosed)
        transport.close()

        // 正确 token 握手成功后 ping 正常。
        const client = yield* Effect.promise(() =>
          Client.connect({ host: "127.0.0.1", port: info!.port, token: info!.token }, { connect_timeout_ms: 2_000 }),
        )
        const ping = yield* Effect.promise(() => client.ping())
        expect(ping).toEqual({ indexing: false, progress: 1, phase: "ready" })
        client.close()
      }).pipe(withInstanceStores),
    20_000,
  )
})

describe("semantic manager spawn serialization", () => {
  it.live(
    "serializes daemon cold starts across directories through the global gate",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const markerA = path.join(socketDir, "a.marker")
        const markerB = path.join(socketDir, "b.marker")
        const dirA = yield* tmpdirScoped({
          config: {
            semantic: { enabled: true, socket_dir: socketDir, command: [process.execPath, slowDaemon, markerA] },
          },
        })
        const dirB = yield* tmpdirScoped({
          config: {
            semantic: { enabled: true, socket_dir: socketDir, command: [process.execPath, slowDaemon, markerB] },
          },
        })

        const start = (dir: string) =>
          Effect.gen(function* () {
            const semantic = yield* Semantic.Service
            yield* semantic.init()
            yield* triggerSpawn(semantic)
            yield* pollReady(semantic)
          }).pipe(provideInstance(dir))

        // 两个目录同时请求（各自的首次 readView），但冷启动必须全局串行。
        yield* Effect.all([start(dirA), start(dirB)], { concurrency: "unbounded" })

        const readMarker = (file: string) =>
          Effect.promise(async () => {
            const text = await fs.readFile(file, "utf8")
            return text
              .trim()
              .split("\n")
              .map((line) => {
                const [kind, ts] = line.split(" ")
                return { kind, ts: Number(ts) }
              })
          })
        const a = yield* readMarker(markerA)
        const b = yield* readMarker(markerB)
        expect(a.map((entry) => entry.kind)).toEqual(["start", "end"])
        expect(b.map((entry) => entry.kind)).toEqual(["start", "end"])
        // 单目录区间合法，且两个 [start, end] 区间不允许重叠。
        expect(a[0].ts).toBeLessThan(a[1].ts)
        expect(b[0].ts).toBeLessThan(b[1].ts)
        expect(a[1].ts < b[0].ts || b[1].ts < a[0].ts).toBe(true)
      }).pipe(withInstanceStores),
    30_000,
  )
})

describe("semantic manager failure retry", () => {
  it.live(
    "does not spawn again before the cooldown and retries after it",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "attempts.log")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              command: [
                process.execPath,
                "-e",
                `require("fs").appendFileSync(${JSON.stringify(marker)}, Date.now() + "\\n"); process.exit(3)`,
              ],
            },
          },
        })

        const previous = RetryPolicy.failedCooldownMs
        RetryPolicy.failedCooldownMs = 1_000
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            RetryPolicy.failedCooldownMs = previous
          }),
        )

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          const failed = yield* pollWithTimeout(
            Effect.gen(function* () {
              const current = yield* semantic.status()
              return current.status === "failed" ? current : undefined
            }),
            "semantic engine never reported failure",
            "15 seconds",
          )
          expect(failed.error).toContain("exited with code 3")
          expect(yield* countLines(marker)).toBe(1)

          // 冷却期内：请求只报告 failed，不重新 spawn。
          const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
          expect(error).toBeInstanceOf(Protocol.UnavailableError)
          expect(error.message).toContain("semantic engine failed")
          expect(yield* countLines(marker)).toBe(1)

          // 冷却结束后：下一次请求重置为 idle 并重新拉起（再次失败，attempts 增长）。
          yield* Effect.sleep("1200 millis")
          yield* triggerSpawn(semantic)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              return (yield* countLines(marker)) >= 2 ? true : undefined
            }),
            "semantic engine never retried the spawn after the cooldown",
            "15 seconds",
          )
        }).pipe(provideInstance(dir))
      }).pipe(withInstanceStores),
    30_000,
  )
})
