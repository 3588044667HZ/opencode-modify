import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { renderProjectMap } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"

const DESCRIPTION = `Show the project-level map produced by the semantic engine.

Views:
- structure (default): module layout with entry points and root files
- dependencies: aggregated module dependencies and cycles
- hot: the most read and edited files and modules

Use this instead of recursive directory listings when you need the project's shape. The semantic engine may still be indexing, or the map may still be building; in that case the response explains the current progress and you can retry shortly.`

export const Parameters = Schema.Struct({
  view: Schema.optional(Schema.Literals(Protocol.ProjectMapViews)).annotate({
    description: "The map view to render: structure (default), dependencies, or hot",
  }),
  scope: Schema.optional(Schema.String).annotate({
    description: "Optional scope to limit the map, such as module:core",
  }),
})

type Metadata = {
  view: Protocol.ProjectMapView
  scope?: string
  building?: boolean
  unavailable?: boolean
}

export const ProjectMapTool = Tool.define(
  "project_map",
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const view = args.view ?? "structure"
          const scope = args.scope
          const title = view

          yield* ctx.ask({
            permission: "read",
            patterns: ["*"],
            always: ["*"],
            metadata: { view, ...(scope === undefined ? {} : { scope }) },
          })

          const outcome = yield* semantic
            .projectMap({
              ...(args.view === undefined ? {} : { view: args.view }),
              ...(scope === undefined ? {} : { scope }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, message: Protocol.describeError(error) })),
            )

          if (!outcome.ok) {
            const metadata: Metadata = { view, ...(scope === undefined ? {} : { scope }), unavailable: true }
            return {
              title,
              metadata,
              output: `project_map unavailable: ${outcome.message}`,
            }
          }

          const metadata: Metadata = {
            view,
            ...(scope === undefined ? {} : { scope }),
            ...(outcome.result.building === true ? { building: true } : {}),
          }
          return {
            title,
            metadata,
            output: renderProjectMap(outcome.result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
