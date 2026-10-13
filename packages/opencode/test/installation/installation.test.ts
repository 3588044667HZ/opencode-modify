import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function testLayer(
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [[CrossSpawnSpawner.node, spawnerNode]])
}

const UPGRADE_DISABLED_MESSAGE =
  "Official upgrades are disabled in this independently maintained fork. Rebuild from source instead."

describe("installation", () => {
  describe("latest", () => {
    const spawnCalls: string[] = []
    testEffect(
      testLayer((cmd) => {
        spawnCalls.push(cmd)
        return ""
      }),
    ).effect("returns the local version without querying official sources", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.latest()).toBe(InstallationVersion)
        expect(yield* Installation.use.latest("npm")).toBe(InstallationVersion)
        expect(yield* Installation.use.latest("brew")).toBe(InstallationVersion)
        expect(yield* Installation.use.latest("choco")).toBe(InstallationVersion)
        expect(yield* Installation.use.latest("curl")).toBe(InstallationVersion)
        expect(spawnCalls).toEqual([])
      }),
    )

    testEffect(testLayer()).effect("reports info with latest equal to the installed version", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.info()).toEqual({
          version: InstallationVersion,
          latest: InstallationVersion,
        })
      }),
    )
  })

  describe("upgrade", () => {
    const spawnCalls: string[] = []
    testEffect(
      testLayer((cmd) => {
        spawnCalls.push(cmd)
        return ""
      }),
    ).effect("fails with the disabled-upgrade message and performs no work", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe(UPGRADE_DISABLED_MESSAGE)
        expect(error.message).toBe(error.stderr)
        expect(spawnCalls).toEqual([])
      }),
    )

    testEffect(testLayer()).effect("fails for every installation method", () =>
      Effect.gen(function* () {
        for (const method of ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop", "unknown"] as const) {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toBe(UPGRADE_DISABLED_MESSAGE)
        }
      }),
    )
  })

  describe("method", () => {
    testEffect(testLayer((cmd) => (cmd === "npm" ? "opencode-ai@1.0.0" : ""))).effect(
      "keeps local package-manager probing",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.method()).toBe("npm")
        }),
    )
  })
})
