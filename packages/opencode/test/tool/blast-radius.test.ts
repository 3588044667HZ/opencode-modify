import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Semantic } from "@/semantic/manager"
import { SessionID, MessageID } from "../../src/session/schema"
import { BlastRadiusTool } from "../../src/tool/blast-radius"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { SAMPLE_BLAST_RENDER, SAMPLE_BLAST_RESULT } from "../semantic/fixture"

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
  args: Tool.InferParameters<typeof BlastRadiusTool>,
  next: Tool.Context = ctx,
) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const info = yield* BlastRadiusTool
      const tool = yield* info.init()
      yield* waitReady
      return yield* tool.execute(args, next)
    }),
  )

describe("tool.blast_radius", () => {
  it.live(
    "renders the blast radius view and asks for read permission",
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

        const result = yield* run(dir, { symbol: "load" }, next)

        expect(result.output).toBe(SAMPLE_BLAST_RENDER)
        expect(result.title).toBe("load")
        expect(result.metadata).toMatchObject({
          symbol: "load",
          definition: SAMPLE_BLAST_RESULT.definition,
          risk: "low",
        })
        const read = asks.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(asks.find((item) => item.permission === "external_directory")).toBeUndefined()
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
            const info = yield* BlastRadiusTool
            const tool = yield* info.init()
            return yield* tool.execute({ symbol: "load" }, ctx)
          }),
        )

        expect(result.output).toContain("blast_radius unavailable:")
        expect(result.output).toContain("disabled")
        expect(result.metadata).toMatchObject({ unavailable: true })
      }),
    20_000,
  )

  it.live(
    "surfaces symbol errors as readable output",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--blast-radius-error=symbol") } },
        })
        const result = yield* run(dir, { symbol: "missing" })

        expect(result.output).toContain("blast_radius unavailable:")
        expect(result.output).toContain("could not resolve symbol")
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
            const info = yield* BlastRadiusTool
            const tool = yield* info.init()
            return yield* tool.execute({ symbol: "load" }, ctx)
          }),
        )

        expect(result.output).toContain("blast_radius unavailable:")
        expect(result.output).toContain("not ready yet")
        expect(result.output).toContain("42%")
      }),
    20_000,
  )
})
