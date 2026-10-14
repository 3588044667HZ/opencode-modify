import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as Tool from "./tool"
import { Semantic } from "@/semantic/manager"
import { renderVerifyTest } from "@/semantic/render"
import { Protocol } from "@/semantic/protocol"
import { BashArity } from "@/permission/arity"
import { ShellID } from "./shell/id"

const DESCRIPTION = `Run a test command through the semantic engine and return a compact, parsed result.

The command is passed to the shell as-is; pick the test runner yourself (for example pytest, npm test, go test ./...). The engine parses common framework output (pytest, jest, go test, cargo test, mocha, vitest) into passed/failed/skipped counts and a list of failures with file, line, and message. When the framework is not recognized, the result falls back to the raw tail of the output.

Unlike the bash tool this is verification only: use it after edit_batch or other edits to close the write-then-verify loop. The semantic engine may still be indexing; in that case the response explains the current progress and you can retry shortly.`

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "The test command to run, for example `pytest` or `npm test`",
  }),
  options: Schema.optional(
    Schema.Struct({
      cwd: Schema.optional(Schema.String).annotate({
        description: "Working directory for the command, defaults to the project root",
      }),
      timeout_ms: Schema.optional(NonNegativeInt).annotate({
        description: "Timeout in milliseconds, defaults to 300000 (5 minutes)",
      }),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
        description: "Extra environment variables for the command",
      }),
    }),
  ).annotate({ description: "Execution options: cwd, timeout_ms, and extra env" }),
})

type Metadata = {
  command: string
  exit_code?: number
  parsed?: boolean
  framework?: string | null
  timeout?: boolean
  unavailable?: boolean
}

export const VerifyTestTool = Tool.define(
  "verify_test",
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const title = args.command
          const cwd = args.options?.cwd

          // 与 shell.ts 的 bash 权限同一模型：命令全文进 patterns，
          // 命令前缀进 always，便于用户一次批准后复用同类命令。
          const tokens = args.command.trim().split(/\s+/).filter((token) => token.length > 0)
          yield* ctx.ask({
            permission: ShellID.ToolID,
            patterns: [args.command],
            always: tokens.length === 0 ? [] : [BashArity.prefix(tokens).join(" ") + " *"],
            metadata: { command: args.command, ...(cwd === undefined ? {} : { cwd }) },
          })

          const outcome = yield* semantic
            .verifyTest({
              command: args.command,
              ...(args.options === undefined ? {} : { options: args.options }),
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, message: Protocol.describeError(error) })),
            )

          if (!outcome.ok) {
            const metadata: Metadata = { command: args.command, unavailable: true }
            return {
              title,
              metadata,
              output: `verify_test unavailable: ${outcome.message}`,
            }
          }

          const result = outcome.result
          const metadata: Metadata = {
            command: result.command,
            exit_code: result.exit_code,
            parsed: result.parsed,
            framework: result.framework,
            ...(result.timeout === undefined ? {} : { timeout: result.timeout }),
          }
          return {
            title,
            metadata,
            output: renderVerifyTest(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
