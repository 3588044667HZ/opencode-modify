import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Semantic } from "@/semantic/manager"
import { SessionID, MessageID } from "../../src/session/schema"
import { VerifyTestTool } from "../../src/tool/verify-test"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import {
  SAMPLE_VERIFY_FAILURE_RENDER,
  SAMPLE_VERIFY_SUCCESS_RENDER,
  SAMPLE_VERIFY_UNRECOGNIZED_RENDER,
} from "../semantic/fixture"

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

const run = (
  dir: string,
  args: Tool.InferParameters<typeof VerifyTestTool>,
  next: Tool.Context = ctx,
) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const info = yield* VerifyTestTool
      const tool = yield* info.init()
      yield* waitReady
      return yield* tool.execute(args, next)
    }),
  )

describe("tool.verify_test", () => {
  it.live(
    "renders a passing run and asks for bash permission on the command",
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

        const result = yield* run(dir, { command: "pytest" }, next)

        expect(result.output).toBe(SAMPLE_VERIFY_SUCCESS_RENDER)
        expect(result.title).toBe("pytest")
        expect(result.metadata).toMatchObject({ command: "pytest", exit_code: 0, parsed: true, framework: "pytest" })
        const bash = asks.find((item) => item.permission === "bash")
        expect(bash).toBeDefined()
        expect(bash!.patterns).toEqual(["pytest"])
        expect(bash!.always).toEqual(["pytest *"])
        expect(asks.find((item) => item.permission === "read")).toBeUndefined()
        expect(asks.find((item) => item.permission === "external_directory")).toBeUndefined()
      }),
    20_000,
  )

  it.live(
    "forwards options and renders failures",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--verify-test=failure") } },
        })
        const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const next = {
          ...ctx,
          ask: (request: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
            Effect.sync(() => {
              asks.push(request)
            }),
        }

        const result = yield* run(
          dir,
          { command: "npm test", options: { cwd: "src", timeout_ms: 60_000, env: { CI: "1" } } },
          next,
        )

        expect(result.output).toBe(SAMPLE_VERIFY_FAILURE_RENDER)
        expect(result.metadata).toMatchObject({ exit_code: 1, parsed: true })
        const bash = asks.find((item) => item.permission === "bash")
        expect(bash!.patterns).toEqual(["npm test"])
        expect(bash!.always).toEqual(["npm test *"])
        expect(bash!.metadata).toMatchObject({ command: "npm test", cwd: "src" })
      }),
    20_000,
  )

  it.live(
    "falls back to raw output when the framework is unrecognized",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--verify-test=unrecognized") } },
        })
        const result = yield* run(dir, { command: "./custom-test.sh" })

        expect(result.output).toBe(SAMPLE_VERIFY_UNRECOGNIZED_RENDER)
        expect(result.metadata).toMatchObject({ command: "./custom-test.sh", exit_code: 1, parsed: false, framework: null })
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
            const info = yield* VerifyTestTool
            const tool = yield* info.init()
            return yield* tool.execute({ command: "pytest" }, ctx)
          }),
        )

        expect(result.output).toContain("verify_test unavailable:")
        expect(result.output).toContain("disabled")
        expect(result.metadata).toMatchObject({ unavailable: true })
      }),
    20_000,
  )

  it.live(
    "surfaces a denied permission instead of running the command",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const exit = yield* provideInstance(dir)(
          Effect.gen(function* () {
            const info = yield* VerifyTestTool
            const tool = yield* info.init()
            return yield* Effect.exit(
              tool.execute(
                { command: "pytest" },
                // ask 失败在工具边界会被 orDie 转成 defect，与真实拒绝路径一致。
                { ...ctx, ask: () => Effect.die(new PermissionV1.RejectedError()) },
              ),
            )
          }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(PermissionV1.RejectedError)
        expect((error as Error).message).toBe("The user rejected permission to use this specific tool call.")
      }),
    20_000,
  )
})
