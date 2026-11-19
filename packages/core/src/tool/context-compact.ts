export * as ContextCompactTool from "./context-compact"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionCompactionRequest } from "../session/compaction-request"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "context_compact"

export const description = `Queue a context compaction for this session.

Use this when the conversation has grown long or you want to preserve a focused summary before continuing. Compaction does not run inside this tool call. It is queued and runs at the next safe provider-turn boundary, after the current provider turn and its tool results are recorded. Multiple requests for the same session coalesce into one compaction.

Pass \`focus\` to tell the summarizer what to preserve, such as open decisions, exact file paths, or unresolved errors. Do not write the summary yourself; the fixed summarization prompt owns the final format.`

export const Input = Schema.Struct({
  focus: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Optional guidance for what the summary should emphasize, such as key decisions, relevant files, or open tasks.",
  }),
})

export const Output = Schema.Struct({
  queued: Schema.Boolean,
  reason: Schema.String,
  focus: Schema.String.pipe(Schema.optional),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  output.queued
    ? `Context compaction queued for the next safe provider-turn boundary.${output.focus === undefined ? "" : ` Focus: ${output.focus}`}`
    : output.reason

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const requests = yield* SessionCompactionRequest.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: context_compact" })),
                Effect.andThen(requests.request({ sessionID: context.sessionID, focus: input.focus })),
                Effect.map((request) => ({
                  queued: true,
                  reason: "Queued for the next safe provider-turn boundary",
                  ...(request.focus === undefined ? {} : { focus: request.focus }),
                })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/context-compact",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionCompactionRequest.node],
})
