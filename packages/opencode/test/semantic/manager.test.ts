import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer } from "effect"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Semantic } from "@/semantic/manager"
import * as Protocol from "@/semantic/protocol"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { SAMPLE_RESULT } from "./fixture"

const fakeDaemon = path.join(import.meta.dir, "fake-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const semanticLayer = () => LayerNode.compile(LayerNode.group([Semantic.node, EventV2Bridge.node]))
const it = testEffect(semanticLayer())

const statusOf = (event: { data: unknown }) => (event.data as { status?: string }).status

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
