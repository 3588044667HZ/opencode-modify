export * as PackTools from "./tool"

import type { Contribution } from "@opencode-ai/plugin/pack"
import { PackTool } from "@opencode-ai/plugin/pack"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"

export type Call = (packId: string, method: string, params?: unknown) => Effect.Effect<unknown, unknown>

export function fromContributions(contributions: readonly Contribution[], call: Call): Tool.Def[] {
  return contributions.flatMap((contribution) => {
    const tool = fromContribution(contribution, (method, params) => call(contribution.packId, method, params))
    return tool ? [tool] : []
  })
}

function fromContribution(
  contribution: Contribution,
  call: (method: string, params?: unknown) => Effect.Effect<unknown, unknown>,
): Tool.Def | undefined {
  if (!isRecord(contribution.value)) return
  const parsed = PackTool.safeParse(contribution.value)
  if (!parsed.success) return
  const value = parsed.data
  const jsonSchema = isJsonSchemaObject(value.inputSchema) ? (value.inputSchema as JSONSchema7) : undefined
  return {
    id: value.id,
    description: value.description,
    parameters: Schema.Unknown,
    ...(jsonSchema ? { jsonSchema } : {}),
    execute: (args) =>
      call(value.method ?? value.id, args).pipe(
        Effect.map((result) => ({
          title: value.id,
          metadata: { pack: contribution.packId },
          output: output(result),
        })),
        Effect.catch((error: unknown) =>
          Effect.succeed({
            title: value.id,
            metadata: { pack: contribution.packId, error: true },
            output: `Pack tool ${value.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ),
      ),
  }
}

function output(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
