import { Config } from "@/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Glob } from "@opencode-ai/core/util/glob"
import { InstanceState } from "@/effect/instance-state"
import { parsePackManifest } from "@opencode-ai/plugin/pack"
import { PackHost } from "@opencode-ai/plugin/pack/host"
import { ProcessPackRuntime } from "@opencode-ai/plugin/pack/runtime"
import { MemoryPackStore, type InstalledPack } from "@opencode-ai/plugin/pack"
import type { Contribution, ContributionKind } from "@opencode-ai/plugin/pack"
import { Context, Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface Interface {
  readonly prompts: () => Effect.Effect<string[]>
  readonly contributions: (kind?: ContributionKind) => Effect.Effect<readonly Contribution[]>
  readonly call: (packId: string, method: string, params?: unknown) => Effect.Effect<unknown, unknown>
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Pack") {}

type Discovered = {
  packs: InstalledPack[]
  errors: Array<{ path: string; error: unknown }>
}

async function discover(directories: string[]): Promise<Discovered> {
  const packs = new Map<string, InstalledPack>()
  const errors: Discovered["errors"] = []
  for (const directory of directories) {
    const files = await Glob.scan("packs/*/pack.json", {
      cwd: directory,
      absolute: true,
      dot: true,
      include: "file",
    }).catch(() => [])
    for (const file of files) {
      try {
        const manifest = parsePackManifest(JSON.parse(await readFile(file, "utf8")))
        packs.set(manifest.id, {
          manifest,
          source: "file",
          target: dirname(file),
          installedAt: Date.now(),
        })
      } catch (error) {
        errors.push({ path: file, error })
      }
    }
  }
  return { packs: [...packs.values()], errors }
}

function scope(ctx: { directory: string; project: { id: string } }) {
  return ctx.project.id === "global" ? `dir:${ctx.directory}` : `project:${ctx.project.id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function promptText(contribution: Contribution): { priority: number; text: string } | undefined {
  if (!isRecord(contribution.value)) return undefined
  const content = contribution.value.content
  if (typeof content !== "string" || !content) return undefined
  const priority = typeof contribution.value.priority === "number" ? contribution.value.priority : 0
  return {
    priority,
    text: `<pack_instructions pack="${contribution.packId}">
${content}
</pack_instructions>`,
  }
}

function prompts(host: PackHost) {
  return host
    .contributions("prompt")
    .flatMap((item) => {
      const prompt = promptText(item)
      return prompt ? [prompt] : []
    })
    .sort((left, right) => right.priority - left.priority)
    .map((item) => item.text)
}

async function mount(ctx: { directory: string; project: { id: string } }, directories: string[]) {
  const discovered = await discover(directories)
  const host = new PackHost({
    store: new MemoryPackStore(),
    runtime: new ProcessPackRuntime(),
    scope: scope(ctx),
    project: { id: ctx.project.id, directory: ctx.directory },
  })
  for (const pack of discovered.packs) {
    await host.install(pack)
    await host.enable(pack.manifest.id).catch(() => undefined)
  }
  await host.mount()
  return { host, errors: discovered.errors }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        const directories = yield* config.directories()
        const result = yield* Effect.promise(() => mount(ctx, directories))
        for (const error of result.errors) {
          yield* Effect.logWarning("pack manifest skipped", { path: error.path, error })
        }
        for (const status of yield* Effect.promise(() => result.host.list())) {
          if (status.error) yield* Effect.logWarning("pack failed to mount", { pack: status.pack.manifest.id, error: status.error })
        }
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise(() => result.host.unmount()).pipe(Effect.ignore),
        )
        return result.host
      }),
    )

    return Service.of({
      prompts: () => InstanceState.useEffect(state, (host) => Effect.sync(() => prompts(host))),
      contributions: (kind) =>
        InstanceState.useEffect(state, (host) => Effect.sync(() => host.contributions(kind))),
      call: (packId, method, params) =>
        InstanceState.useEffect(state, (host) =>
          Effect.tryPromise({
            try: () => host.call(packId, method, params),
            catch: (error) => error,
          }),
        ),
      reload: () => InstanceState.useEffect(state, (host) => Effect.tryPromise(() => host.reload()).pipe(Effect.ignore)),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node],
})
