import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { renderEditBatch } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"
import { InstanceState } from "@/effect/instance-state"
import { SessionLedger } from "@/session/ledger"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PositiveInt } from "@opencode-ai/schema/schema"
import { FALLBACK_HINT } from "./fallback-option-direct"

const DESCRIPTION = `Apply multiple text changes to a single file atomically through the semantic engine.

Each change replaces an exact oldString with newString; an oldString must match exactly once in the current file content. All changes either apply together or none do, and baseVersion must match the version stamp reported by read_view (the \`v:\` value in its header). On success the result reports the affected lines and the diagnostics delta; on failure it explains the failing change and a hint for fixing it.`

export const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "The absolute or relative path to the file to edit" }),
  changes: Schema.Array(Protocol.EditBatchChange).annotate({
    description:
      "The batch of changes to apply atomically, each with oldString, newString, and an optional description",
  }),
  baseVersion: Schema.String.annotate({
    description: "The version stamp of the file from read_view (used to detect concurrent modifications)",
  }),
  options: Schema.optional(
    Schema.Struct({
      lock_timeout_ms: Schema.optional(PositiveInt).annotate({
        description: "How long to wait for the per-file write lock before failing with LOCK_TIMEOUT (defaults to 30000)",
      }),
    }),
  ).annotate({ description: "Concurrency options: lock_timeout_ms for the per-file write lock" }),
})

type Metadata = {
  file: string
  applied?: boolean
  version?: string
  changes_total?: number
  error_code?: number
  unavailable?: boolean
}

export const EditBatchTool = Tool.define(
  "edit_batch",
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

          yield* assertExternalDirectoryEffect(ctx, filepath)

          yield* ctx.ask({
            permission: "edit",
            patterns: [relative],
            always: ["*"],
            metadata: {
              filepath,
            },
          })

          const outcome = yield* semantic
            .editBatch({
              file: filepath,
              changes: args.changes,
              baseVersion: args.baseVersion,
              ...(args.options === undefined ? {} : { options: args.options }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) =>
                Effect.succeed({
                  ok: false as const,
                  message: Protocol.describeError(error),
                  // 只有锚点冲突类错误同时可能出现在 RPC 错误与结果联合两条路径。
                  fallback: error instanceof Protocol.RpcError && needsFallbackHint(error.code),
                }),
              ),
            )

          if (!outcome.ok) {
            const metadata: Metadata = { file: filepath, unavailable: true }
            return {
              title: relative,
              metadata,
              output: [`edit_batch unavailable: ${outcome.message}`, ...(outcome.fallback ? [FALLBACK_HINT] : [])].join(
                "\n",
              ),
            }
          }

          if (!outcome.result.applied) {
            const metadata: Metadata = {
              file: filepath,
              applied: false,
              changes_total: outcome.result.changes_total,
              error_code: outcome.result.error.code,
            }
            return {
              title: relative,
              metadata,
              output: [
                renderEditBatch(outcome.result),
                ...(needsFallbackHint(outcome.result.error.code) ? [FALLBACK_HINT] : []),
              ].join("\n"),
            }
          }

          // D5：自身编辑落盘后，早先读取被新版本取代。
          yield* ledger.noteEdit({ sessionID: ctx.sessionID, file: filepath, newVersion: outcome.result.new_version })

          const metadata: Metadata = {
            file: filepath,
            applied: true,
            version: outcome.result.new_version,
            changes_total: outcome.result.changes_total,
          }
          return {
            title: relative,
            metadata,
            output: renderEditBatch(outcome.result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// 仅锚点不唯一与变更冲突提示 fallback；保护路径/内容不纯/版本失配应先重试或重新读取。
function needsFallbackHint(code: number): boolean {
  return code === Protocol.EditBatchErrorCode.anchorNotUnique || code === Protocol.EditBatchErrorCode.changeConflict
}
