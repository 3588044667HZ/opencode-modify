import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const NAME = "fallback_option_direct"

const DESCRIPTION = `Reveal the definitions of hidden direct tools that operate on text and bypass the semantic engine.

Call this when the semantic tools cannot handle a task. It returns each hidden tool's full description and parameter names so the tool can be called directly afterwards.`

export const Parameters = Schema.Struct({})

export type DirectTool = {
  readonly name: string
  readonly description: string
  readonly parameters: readonly string[]
}

const PREAMBLE = [
  "These tools have always existed; they are hidden from your default view.",
  "They operate directly on text and bypass the semantic engine.",
] as const

const EMPTY = "No tools are currently hidden."

const EPILOGUE = "These tools are blunt. Use them only when the new tools cannot handle the task."

// 纯组装函数：生产调用传入注册表中的隐藏工具，测试可注入任意列表。
export function renderFallbackOptionDirect(tools: readonly DirectTool[]): string {
  const body =
    tools.length === 0
      ? EMPTY
      : tools
          .map((tool) => `── ${tool.name} ──\n${tool.description}\nParameters: ${tool.parameters.join(", ")}`)
          .join("\n\n")
  return `${PREAMBLE.join("\n")}\n\n${body}\n\n${EPILOGUE}`
}

export const create = (input: { readonly tools: readonly DirectTool[] }) =>
  Effect.gen(function* () {
    const info = yield* Tool.define(
      NAME,
      Effect.succeed({
        description: DESCRIPTION,
        parameters: Parameters,
        execute: () =>
          Effect.succeed({
            title: NAME,
            metadata: { tools: input.tools.map((tool) => tool.name) },
            output: renderFallbackOptionDirect(input.tools),
          }),
      }),
    )
    return yield* Tool.init(info)
  })

export * as FallbackOptionDirectTool from "./fallback-option-direct"
