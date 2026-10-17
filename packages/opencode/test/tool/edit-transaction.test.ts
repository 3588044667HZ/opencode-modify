import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Semantic } from "@/semantic/manager"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionLedger } from "../../src/session/ledger"
import { EditTransactionTool, Parameters } from "../../src/tool/edit-transaction"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import {
  SAMPLE_EDIT_TRANSACTION_FAILURE_RENDER,
  SAMPLE_EDIT_TRANSACTION_MISMATCH_RENDER,
  SAMPLE_EDIT_TRANSACTION_SUCCESS_RENDER,
} from "../semantic/fixture"

const fakeDaemon = path.join(import.meta.dir, "..", "semantic", "fake-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const toolLayer = () =>
  LayerNode.compile(
    LayerNode.group([Semantic.node, Agent.node, Truncate.node, CrossSpawnSpawner.node, SessionLedger.node]),
  )
const it = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const args = {
  changes: [
    {
      file: "src/core/engine.ts",
      baseVersion: "a3f9c2",
      changes: [{ oldString: "return json.load(data)", newString: "return parse(data)" }],
    },
    {
      file: "src/api/routes.ts",
      baseVersion: "c1d2e3",
      changes: [{ oldString: "router.get", newString: "router.post" }],
    },
  ],
}

const waitReady = Effect.gen(function* () {
  const semantic = yield* Semantic.Service
  yield* semantic.init()
  // 惰性拉起：首个语义请求触发后台 spawn（期间返回 UnavailableError），就绪后正常服务。
  yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.catch(() => Effect.void))
  yield* pollWithTimeout(
    Effect.gen(function* () {
      const current = yield* semantic.status()
      return current.status === "ready" ? current : undefined
    }),
    "semantic engine never became ready",
    "15 seconds",
  )
})

const run = (dir: string, input: Tool.InferParameters<typeof EditTransactionTool>, next: Tool.Context = ctx) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const info = yield* EditTransactionTool
      const tool = yield* info.init()
      yield* waitReady
      return yield* tool.execute(input, next)
    }),
  )

describe("tool.edit_transaction", () => {
  it.live(
    "renders an applied transaction and asks for edit permission on every file",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          git: true,
          config: { semantic: { enabled: true, command: command() } },
        })
        const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const next = {
          ...ctx,
          ask: (request: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
            Effect.sync(() => {
              asks.push(request)
            }),
        }

        const result = yield* run(dir, args, next)

        expect(result.output).toBe(SAMPLE_EDIT_TRANSACTION_SUCCESS_RENDER)
        const engine = path.join("src", "core", "engine.ts")
        const routes = path.join("src", "api", "routes.ts")
        expect(result.title).toBe(`${engine}, ${routes}`)
        expect(result.metadata).toMatchObject({ applied: true, changes_total: 7 })
        const edit = asks.find((item) => item.permission === "edit")
        expect(edit).toBeDefined()
        expect(edit!.patterns).toEqual([engine, routes])
        expect(asks.find((item) => item.permission === "read")).toBeUndefined()
        expect(asks.find((item) => item.permission === "external_directory")).toBeUndefined()
      }),
    20_000,
  )

  it.live(
    "returns the rendered failure text instead of throwing",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--edit-transaction-error=anchor") } },
        })

        const result = yield* run(dir, args)

        expect(result.output).toBe(SAMPLE_EDIT_TRANSACTION_FAILURE_RENDER)
        expect(result.metadata).toMatchObject({ applied: false, error_code: -32011, changes_total: 3 })
      }),
    20_000,
  )

  it.live(
    "surfaces a VERSION_MISMATCH delta reconciliation with the rollback notice",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--edit-transaction-error=mismatch") } },
        })

        const result = yield* run(dir, args)

        expect(result.output).toBe(SAMPLE_EDIT_TRANSACTION_MISMATCH_RENDER)
        expect(result.metadata).toMatchObject({ applied: false, error_code: -32012 })
      }),
    20_000,
  )

  it.live(
    "explains the -32018 journal recovery gate without throwing",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--edit-transaction-error=journal") } },
        })

        const result = yield* run(dir, args)

        expect(result.output).toBe(
          "edit_transaction unavailable: semantic writes are disabled: journal recovery failed (human intervention required)",
        )
        expect(result.metadata).toMatchObject({ unavailable: true })
      }),
    20_000,
  )

  it.live(
    "forwards lock_timeout_ms and renders the lock timeout failure",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--edit-transaction-error=lock") } },
        })

        const result = yield* run(dir, { ...args, options: { lock_timeout_ms: 12345 } })

        expect(result.output).toBe(
          [
            "edit_transaction FAILED: lock timeout in src/core/engine.ts",
            "  lock timeout after 12345ms",
            "  hint: 文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
            "  所有文件均未修改",
          ].join("\n"),
        )
        expect(result.metadata).toMatchObject({ applied: false, error_code: -32017 })
      }),
    20_000,
  )

  it.live(
    "explains when the semantic engine is unavailable instead of throwing",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const result = yield* provideInstance(dir)(
          Effect.gen(function* () {
            const info = yield* EditTransactionTool
            const tool = yield* info.init()
            return yield* tool.execute(args, ctx)
          }),
        )

        expect(result.output).toContain("edit_transaction unavailable:")
        expect(result.output).toContain("disabled")
        expect(result.metadata).toMatchObject({ unavailable: true })
      }),
    20_000,
  )
})

describe("tool.edit_transaction parameters", () => {
  const accepts = (input: unknown) => Option.isSome(Schema.decodeUnknownOption(Parameters)(input))
  const base = {
    changes: [{ file: "engine.ts", baseVersion: "a3f9c2", changes: [] }],
  }

  test("accepts multiple files, descriptions, and a positive lock_timeout_ms", () => {
    expect(accepts(base)).toBe(true)
    expect(accepts({ ...base, options: {} })).toBe(true)
    expect(accepts({ ...base, options: { lock_timeout_ms: 1 } })).toBe(true)
    expect(
      accepts({
        ...base,
        changes: [
          { ...base.changes[0], changes: [{ oldString: "a", newString: "b", description: "why" }] },
          { file: "routes.ts", baseVersion: "c1d2e3", changes: [{ oldString: "c", newString: "d" }] },
        ],
      }),
    ).toBe(true)
  })

  test("rejects zero, negative, and fractional lock_timeout_ms", () => {
    expect(accepts({ ...base, options: { lock_timeout_ms: 0 } })).toBe(false)
    expect(accepts({ ...base, options: { lock_timeout_ms: -1 } })).toBe(false)
    expect(accepts({ ...base, options: { lock_timeout_ms: 1.5 } })).toBe(false)
  })

  test("rejects entries missing file or baseVersion and a missing changes array", () => {
    expect(accepts({ changes: [{ baseVersion: "a3f9c2", changes: [] }] })).toBe(false)
    expect(accepts({ changes: [{ file: "engine.ts", changes: [] }] })).toBe(false)
    expect(accepts({})).toBe(false)
  })
})
