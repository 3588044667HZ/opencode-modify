import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Semantic } from "@/semantic/manager"
import { SessionID, MessageID } from "../../src/session/schema"
import { ProjectMapTool } from "../../src/tool/project-map"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { SAMPLE_PROJECT_MAP_DEPENDENCIES_RENDER, SAMPLE_PROJECT_MAP_STRUCTURE_RENDER } from "../semantic/fixture"

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

const run = (dir: string, args: Tool.InferParameters<typeof ProjectMapTool>, next: Tool.Context = ctx) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const info = yield* ProjectMapTool
      const tool = yield* info.init()
      yield* waitReady
      return yield* tool.execute(args, next)
    }),
  )

describe("tool.project_map", () => {
  it.live(
    "renders the structure view and asks for read permission",
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

        const result = yield* run(dir, {}, next)

        expect(result.output).toBe(SAMPLE_PROJECT_MAP_STRUCTURE_RENDER)
        expect(result.title).toBe("structure")
        expect(result.metadata).toMatchObject({ view: "structure" })
        const read = asks.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(asks.find((item) => item.permission === "external_directory")).toBeUndefined()
      }),
    20_000,
  )

  it.live(
    "renders the dependencies view",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, command: command("--project-map=dependencies") } },
        })
        const result = yield* run(dir, { view: "dependencies" })

        expect(result.output).toBe(SAMPLE_PROJECT_MAP_DEPENDENCIES_RENDER)
        expect(result.title).toBe("dependencies")
        expect(result.metadata).toMatchObject({ view: "dependencies" })
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
            const info = yield* ProjectMapTool
            const tool = yield* info.init()
            return yield* tool.execute({}, ctx)
          }),
        )

        expect(result.output).toContain("project_map unavailable:")
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
            yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.catch(() => Effect.void))
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const current = yield* semantic.status()
                return current.status === "indexing" ? current : undefined
              }),
              "semantic engine never reported indexing",
              "15 seconds",
            )
            const info = yield* ProjectMapTool
            const tool = yield* info.init()
            return yield* tool.execute({}, ctx)
          }),
        )

        expect(result.output).toContain("project_map unavailable:")
        expect(result.output).toContain("not ready yet")
        expect(result.output).toContain("42%")
      }),
    20_000,
  )
})
