import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { renderEditTransaction } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PositiveInt } from "@opencode-ai/schema/schema"

const DESCRIPTION = `Apply a set of text changes across multiple files atomically through the semantic engine.

Each file entry carries its own baseVersion (the \`v:\` value from the read_view header) and a batch of oldString/newString changes. All files either commit together or none are written: when any file fails, every file keeps its previous content and version stamp. Use this for cross-file refactors (changing an interface together with its implementations and callers); use edit_batch for single-file changes. On success the result reports the affected lines per file and the diagnostics delta; on failure it explains the failing change and a hint for fixing it.`

export const Parameters = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      file: Schema.String.annotate({ description: "The absolute or relative path to the file to edit" }),
      baseVersion: Schema.String.annotate({
        description: "The version stamp of the file from read_view (used to detect concurrent modifications)",
      }),
      changes: Schema.Array(Protocol.EditBatchChange).annotate({
        description:
          "The batch of changes to apply to this file, each with oldString, newString, and an optional description",
      }),
    }),
  ).annotate({
    description: "The files to edit atomically; each entry carries its own baseVersion and change batch",
  }),
  options: Schema.optional(
    Schema.Struct({
      lock_timeout_ms: Schema.optional(PositiveInt).annotate({
        description: "How long to wait for each per-file write lock before failing with LOCK_TIMEOUT (defaults to 30000)",
      }),
    }),
  ).annotate({ description: "Concurrency options: lock_timeout_ms for the per-file write locks" }),
})

type Metadata = {
  files: string[]
  applied?: boolean
  changes_total?: number
  error_code?: number
  unavailable?: boolean
}

export const EditTransactionTool = Tool.define(
  "edit_transaction",
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const requests = args.changes.map((entry) => {
            let filepath = entry.file
            if (!path.isAbsolute(filepath)) filepath = path.resolve(instance.directory, filepath)
            if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)
            return {
              filepath,
              relative: path.relative(instance.worktree, filepath),
              request: { file: filepath, baseVersion: entry.baseVersion, changes: entry.changes },
            }
          })
          const relatives = requests.map((item) => item.relative)
          const title = relatives.join(", ")

          for (const item of requests) yield* assertExternalDirectoryEffect(ctx, item.filepath)

          yield* ctx.ask({
            permission: "edit",
            patterns: relatives,
            always: ["*"],
            metadata: { filepaths: requests.map((item) => item.filepath) },
          })

          const outcome = yield* semantic
            .editTransaction({
              changes: requests.map((item) => item.request),
              ...(args.options === undefined ? {} : { options: args.options }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, message: Protocol.describeError(error) })),
            )

          if (!outcome.ok) {
            const metadata: Metadata = { files: relatives, unavailable: true }
            return {
              title,
              metadata,
              output: `edit_transaction unavailable: ${outcome.message}`,
            }
          }

          if (!outcome.result.applied) {
            const metadata: Metadata = {
              files: relatives,
              applied: false,
              ...(outcome.result.error.detail?.changes_total === undefined
                ? {}
                : { changes_total: outcome.result.error.detail.changes_total }),
              error_code: outcome.result.error.code,
            }
            return {
              title,
              metadata,
              output: renderEditTransaction(outcome.result),
            }
          }

          const metadata: Metadata = {
            files: relatives,
            applied: true,
            changes_total: outcome.result.changes_total,
          }
          return {
            title,
            metadata,
            output: renderEditTransaction(outcome.result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
