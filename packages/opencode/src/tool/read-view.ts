import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { render } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"

const DESCRIPTION = `Read a file as a token semantic view produced by the semantic engine.

Unlike the plain read tool, this returns a navigable view of the code space: file header with version and size, position awareness, code lines with inline diagnostics and definition anchors, and read/unread coverage.

Views:
- entry: enter the view at the first symbol, or at "position" when given
- sequential: read forward from "position"
- continue: continue reading from where the previous view of this file ended
- definition: jump to the definition of "symbol"

The semantic engine may still be indexing; in that case the response explains the current progress and you can retry shortly.`

export const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "The absolute or relative path to the file to read" }),
  view: Schema.Literals(Protocol.Views).annotate({
    description: "The semantic view to render: entry, sequential, continue, or definition",
  }),
  position: Schema.optional(
    Schema.Struct({
      line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "The line number (1-based, as shown in editors)",
      }),
    }),
  ).annotate({ description: "Position to anchor the view at (entry and sequential views)" }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to resolve (definition view)",
  }),
})

type Metadata = {
  view: Protocol.View
  file: string
  version?: string
  lines?: number
  symbols?: number
  unavailable?: boolean
}

export const ReadViewTool = Tool.define(
  "read_view",
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          let filepath = args.file
          if (!path.isAbsolute(filepath)) filepath = path.resolve(instance.directory, filepath)
          if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)
          const relative = path.relative(instance.worktree, filepath)
          const title = relative

          yield* assertExternalDirectoryEffect(ctx, filepath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
          })

          yield* ctx.ask({
            permission: "read",
            patterns: [relative],
            always: ["*"],
            metadata: {},
          })

          const outcome = yield* semantic
            .readView({
              file: filepath,
              view: args.view,
              ...(args.position === undefined ? {} : { position: args.position }),
              ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, message: Protocol.describeError(error) })),
            )

          if (!outcome.ok) {
            const metadata: Metadata = { view: args.view, file: filepath, unavailable: true }
            return {
              title,
              metadata,
              output: `read_view unavailable: ${outcome.message}`,
            }
          }

          const metadata: Metadata = {
            view: args.view,
            file: filepath,
            version: outcome.result.version,
            lines: outcome.result.size.lines,
            symbols: outcome.result.size.symbols,
          }
          return {
            title,
            metadata,
            output: render(outcome.result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
