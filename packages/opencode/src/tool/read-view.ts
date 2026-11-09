import { Effect, Schema } from "effect"
import * as path from "path"
import { readFile } from "node:fs/promises"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { render } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"
import { InstanceState } from "@/effect/instance-state"
import { SessionLedger } from "@/session/ledger"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FALLBACK_HINT } from "./fallback-option-direct"

const DESCRIPTION = `Read a file as a token semantic view produced by the semantic engine.

Unlike the plain read tool, this returns a navigable view of the code space: file header with version and size, position awareness, code lines with inline diagnostics and definition anchors, and read/unread coverage.

Views:
- entry: show a compact symbol outline and the first window, or start at "position" when given
- sequential: read forward from "position"
- continue: continue reading from where the previous view of this file ended
- definition: jump to the definition of "symbol"

Reconciliation: pass "known_version" (a version from an earlier read_view of the same file) to reconcile instead of re-reading. A file that still matches returns a micro result (unchanged); otherwise the engine returns a bounded line delta plus the new version, falling back to a full view only for large changes.

The semantic engine may still be indexing; in that case read_view falls back to a plain text read with a degradation marker, or explains the current progress if the file cannot be read. Full views return at most 80 lines; use sequential/position or continue to read further.`

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
  known_version: Schema.optional(Schema.String).annotate({
    description:
      "Version stamp from an earlier read_view of this file: reconcile against it (unchanged micro result, or a bounded delta plus the new version) instead of re-reading the whole view",
  }),
})

type Metadata = {
  view: Protocol.View
  file: string
  version?: string
  lines?: number
  symbols?: number
  unchanged?: boolean
  unavailable?: boolean
  fallback?: boolean
}

export const ReadViewTool = Tool.define(
  "read_view",
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service
    const ledger = yield* SessionLedger.Service
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

          const previous = (yield* ledger.entries(ctx.sessionID)).get(filepath)
          const previousCursor = previous?.cursor
          const previousCoverage = previous?.coverage ?? []
          const position =
            args.position ??
            (args.view === "continue" && previousCursor !== undefined ? { line: previousCursor + 1 } : undefined)

          const outcome = yield* semantic
            .readView({
              file: filepath,
              view: args.view,
              ...(position === undefined ? {} : { position }),
              ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
              ...(args.known_version === undefined ? {} : { known_version: args.known_version }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) =>
                Effect.succeed({
                  ok: false as const,
                  message: Protocol.describeError(error),
                  fallback:
                    error instanceof Protocol.RpcError &&
                    (error.code === Protocol.ErrorCode.fileNotFound ||
                      error.code === Protocol.ErrorCode.fileTooLarge),
                  notReady:
                    error instanceof Protocol.UnavailableError ||
                    (error instanceof Protocol.RpcError && error.code === Protocol.ErrorCode.indexing),
                }),
              ),
            )

          if (!outcome.ok) {
            if (outcome.notReady) {
              const fallback = yield* Effect.promise(() => plainRead(filepath))
              if (fallback !== undefined) {
                return {
                  title,
                  metadata: { view: args.view, file: filepath, unavailable: true, fallback: true },
                  output: [
                    `read_view unavailable: ${outcome.message}`,
                    "fallback: plain read (semantic engine not ready)",
                    fallback,
                  ].join("\n"),
                }
              }
            }
            const metadata: Metadata = { view: args.view, file: filepath, unavailable: true }
            return {
              title,
              metadata,
              output: [`read_view unavailable: ${outcome.message}`, ...(outcome.fallback ? [FALLBACK_HINT] : [])].join("\n"),
            }
          }

          // D5：三个视图变体都携带 version，登记后 digest 才能及时发现外部变更。
          if (Protocol.isReadViewUnchanged(outcome.result)) {
            yield* ledger.noteRead({ sessionID: ctx.sessionID, file: filepath, version: outcome.result.version })
            return {
              title,
              metadata: { view: args.view, file: filepath, version: outcome.result.version, unchanged: true },
              output: render(outcome.result),
            }
          }

          if (Protocol.isReadViewDelta(outcome.result)) {
            yield* ledger.noteRead({ sessionID: ctx.sessionID, file: filepath, version: outcome.result.version })
            return {
              title,
              metadata: { view: args.view, file: filepath, version: outcome.result.version },
              output: render(outcome.result),
            }
          }

          const read =
            previous?.version === outcome.result.version
              ? mergeCoverage(previousCoverage, outcome.result.coverage.read, outcome.result.size.lines)
              : mergeCoverage([], outcome.result.coverage.read, outcome.result.size.lines)
          const coverage = {
            read,
            unread: complementCoverage(read, outcome.result.size.lines),
          }
          const displayed = { ...outcome.result, coverage }
          const cursor = outcome.result.content.at(-1)?.line
          yield* ledger.noteRead({
            sessionID: ctx.sessionID,
            file: filepath,
            version: outcome.result.version,
            ...(cursor === undefined ? {} : { cursor }),
            coverage: read,
          })

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
            output: [
              render(displayed),
              ...(args.known_version === undefined && args.view !== "continue"
                ? [`hint: pass known_version=${outcome.result.version} to reconcile next read`]
                : []),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// 语义引擎未就绪时的文本回退：保持 read_view 调用不失败，模型至少能继续探索。
async function plainRead(filepath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filepath, "utf8")
    const lines = content.split(/\r?\n/)
    if (lines.length > 1 && lines.at(-1) === "") lines.pop()
    return lines
      .slice(0, 80)
      .map((line, index) => `L${index + 1}  ${line}`)
      .join("\n")
  } catch {
    return undefined
  }
}

function mergeCoverage(
  previous: readonly Protocol.CoverageRange[],
  current: readonly Protocol.CoverageRange[],
  total: number,
): Protocol.CoverageRange[] {
  const ranges = [...previous, ...current]
    .map(([from, to]) => [Math.max(1, from), Math.min(total, to)] as const)
    .filter(([from, to]) => from <= to)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: Array<readonly [number, number]> = []
  for (const [from, to] of ranges) {
    const last = merged.at(-1)
    if (last && from <= last[1] + 1) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], to)]
      continue
    }
    merged.push([from, to])
  }
  return merged
}

function complementCoverage(coverage: readonly Protocol.CoverageRange[], total: number): Protocol.CoverageRange[] {
  if (total <= 0) return []
  const unread: Array<readonly [number, number]> = []
  let next = 1
  for (const [from, to] of coverage) {
    if (next < from) unread.push([next, from - 1])
    next = Math.max(next, to + 1)
  }
  if (next <= total) unread.push([next, total])
  return unread
}
