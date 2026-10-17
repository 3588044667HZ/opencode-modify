import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { renderBlastRadius } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"
import { FALLBACK_HINT } from "./fallback-option-direct"

const DESCRIPTION = `Analyze the blast radius of a symbol: its definition, callers, callees, affected files, entry points that reach it, and the tests that reference it.

Use this before changing a symbol to understand what a modification would impact. The semantic engine may still be indexing; in that case the response explains the current progress and you can retry shortly.`

export const Parameters = Schema.Struct({
  symbol: Schema.String.annotate({
    description: "The symbol name to analyze (for example a function, method, or class name)",
  }),
  scope: Schema.optional(Schema.String).annotate({
    description: "Optional scope to limit the search, such as file:engine.ts or module:core",
  }),
})

type Metadata = {
  symbol: string
  scope?: string
  definition?: { file: string; line: number; kind: string }
  risk?: Protocol.BlastRadiusRisk
  unavailable?: boolean
}

export const BlastRadiusTool = Tool.define(
  "blast_radius",
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const title = args.symbol
          const scope = args.scope

          yield* ctx.ask({
            permission: "read",
            patterns: ["*"],
            always: ["*"],
            metadata: { symbol: args.symbol, ...(scope === undefined ? {} : { scope }) },
          })

          const outcome = yield* semantic
            .blastRadius({
              symbol: args.symbol,
              ...(scope === undefined ? {} : { scope }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) =>
                Effect.succeed({
                  ok: false as const,
                  message: Protocol.describeError(error),
                  fallback: error instanceof Protocol.RpcError && error.code === Protocol.ErrorCode.symbolNotFound,
                }),
              ),
            )

          if (!outcome.ok) {
            const metadata: Metadata = {
              symbol: args.symbol,
              ...(scope === undefined ? {} : { scope }),
              unavailable: true,
            }
            return {
              title,
              metadata,
              output: [`blast_radius unavailable: ${outcome.message}`, ...(outcome.fallback ? [FALLBACK_HINT] : [])].join(
                "\n",
              ),
            }
          }

          const metadata: Metadata = {
            symbol: args.symbol,
            ...(scope === undefined ? {} : { scope }),
            definition: outcome.result.definition,
            risk: outcome.result.summary.risk,
          }
          return {
            title,
            metadata,
            output: renderBlastRadius(outcome.result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
