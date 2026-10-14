import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Semantic } from "@/semantic/manager"
import { SessionID, MessageID } from "../../src/session/schema"
import { EditBatchTool, Parameters } from "../../src/tool/edit-batch"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { SAMPLE_EDIT_BATCH_FAILURE_RENDER, SAMPLE_EDIT_BATCH_SUCCESS_RENDER } from "../semantic/fixture"

const fakeDaemon = path.join(import.meta.dir, "..", "semantic", "fake-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const toolLayer = () =>
  LayerNode.compile(LayerNode.group([Semantic.node, Agent.node, Truncate.node, CrossSpawnSpawner.node]))
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
  file: "engine.ts",
  changes: [{ oldString: "return json.load(data)", newString: "return parse(data)" }],
  baseVersion: "a3f9c2",
}

const waitReady = Effect.gen(function* () {
  const semantic = yield* Semantic.Service
  yield* semantic.init()
  yield* pollWithTimeout(
    Effect.gen(function* () {
      const current = yield* semantic.status()
      return current.status === "ready" ? current : undefined
    }),
    "semantic engine never became ready",
    "15 seconds",
  )
})

const run = (dir: string, input: Tool.InferParameters<typeof EditBatchTool>, next: Tool.Context = ctx) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const info = yield* EditBatchTool
      const tool = yield* info.init()
      yield* waitReady
      return yield* tool.execute(input, next)
    }),
  )

describe("tool.edit_batch", () => {
  it.live(
    "renders an applied batch and asks for edit permission on the target file",
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

        expect(result.output).toBe(SAMPLE_EDIT_BATCH_SUCCESS_RENDER)
        expect(result.title).toBe("engine.ts")
        expect(result.metadata).toMatchObject({ applied: true, version: "b7e1d4", changes_total: 3 })
        const edit = asks.find((item) => item.permission === "edit")
        expect(edit).toBeDefined()
        expect(edit!.patterns).toEqual(["engine.ts"])
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
          config: { semantic: { enabled: true, command: command("--edit-batch-error=anchor") } },
        })

        const result = yield* run(dir, args)

        expect(result.output).toBe(SAMPLE_EDIT_BATCH_FAILURE_RENDER)
        expect(result.metadata).toMatchObject({ applied: false, error_code: -32011 })
      }),
    20_000,
  )

  it.live(
    "forwards edit_batch options and renders the lock timeout failure",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--edit-batch-error=lock") } },
        })

        const result = yield* run(dir, { ...args, options: { lock_timeout_ms: 12345 } })

        expect(result.output).toBe(
          [
            "edit_batch FAILED: lock timeout",
            "  engine.ts: lock timeout after 12345ms",
            "  hint: 文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
          ].join("\n"),
        )
        expect(result.metadata).toMatchObject({ applied: false, error_code: -32017 })
      }),
    20_000,
  )

  it.live(
    "renders the default lock timeout when options are omitted",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--edit-batch-error=lock") } },
        })

        const result = yield* run(dir, args)

        expect(result.output.split("\n")[1]).toBe("  engine.ts: lock timeout after 30000ms")
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
            const info = yield* EditBatchTool
            const tool = yield* info.init()
            return yield* tool.execute(args, ctx)
          }),
        )

        expect(result.output).toContain("edit_batch unavailable:")
        expect(result.output).toContain("disabled")
        expect(result.metadata).toMatchObject({ unavailable: true })
      }),
    20_000,
  )

  it.live(
    "reports indexing progress when the daemon is not ready",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--indexing-forever") } },
        })
        const result = yield* provideInstance(dir)(
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
            const info = yield* EditBatchTool
            const tool = yield* info.init()
            return yield* tool.execute(args, ctx)
          }),
        )

        expect(result.output).toContain("edit_batch unavailable:")
        expect(result.output).toContain("not ready yet")
        expect(result.output).toContain("42%")
      }),
    20_000,
  )
})

describe("tool.edit_batch parameters", () => {
  const accepts = (input: unknown) => Option.isSome(Schema.decodeUnknownOption(Parameters)(input))
  const base = { file: "engine.ts", changes: [], baseVersion: "a3f9c2" }

  test("accepts a positive lock_timeout_ms and omitted options", () => {
    expect(accepts(base)).toBe(true)
    expect(accepts({ ...base, options: {} })).toBe(true)
    expect(accepts({ ...base, options: { lock_timeout_ms: 1 } })).toBe(true)
  })

  test("rejects zero, negative, and fractional lock_timeout_ms", () => {
    expect(accepts({ ...base, options: { lock_timeout_ms: 0 } })).toBe(false)
    expect(accepts({ ...base, options: { lock_timeout_ms: -1 } })).toBe(false)
    expect(accepts({ ...base, options: { lock_timeout_ms: 1.5 } })).toBe(false)
  })
})
