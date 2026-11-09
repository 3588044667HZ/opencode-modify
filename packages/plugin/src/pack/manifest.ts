import { z } from "zod"

const id = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, "Pack ids may contain letters, digits, dot, underscore, and dash")
export const PackTool = z.object({
  id,
  description: z.string().min(1),
  method: z.string().min(1).optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
})

export const PackAgent = z
  .object({
    id,
    description: z.string().optional(),
    mode: z.enum(["primary", "subagent", "all"]).optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
  })
  .passthrough()

export const PackPrompt = z.object({
  id,
  slot: z.string().optional(),
  priority: z.number().int().optional(),
  content: z.string().min(1),
})

export const PackRpc = z.object({
  id,
  method: z.string().min(1),
})

export const PackUi = z.object({
  id,
  slot: z.string().min(1),
  entry: z.string().min(1),
})

export const PackContributions = z.object({
  tools: z.array(PackTool).optional(),
  agents: z.array(PackAgent).optional(),
  prompts: z.array(PackPrompt).optional(),
  rpc: z.array(PackRpc).optional(),
  ui: z.array(PackUi).optional(),
})

export const PackManifest = z.object({
  id,
  version: z.string().min(1),
  api: z.number().int().positive().optional(),
  entry: z.string().min(1).optional(),
  command: z.array(z.string().min(1)).min(1).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  contributes: PackContributions.optional(),
})

export type PackManifest = z.infer<typeof PackManifest>

export function parsePackManifest(value: unknown): PackManifest {
  const manifest = PackManifest.parse(value)
  if (
    !manifest.entry &&
    !manifest.command &&
    ((manifest.contributes?.tools?.length ?? 0) > 0 || (manifest.contributes?.rpc?.length ?? 0) > 0)
  ) {
    throw new Error("Pack tools/rpc contributions require an entry or command")
  }
  const ids = new Set<string>()
  const duplicate = (value: string) => {
    if (ids.has(value)) return true
    ids.add(value)
    return false
  }
  for (const item of manifest.contributes?.tools ?? []) {
    if (duplicate(`tool:${item.id}`)) throw new Error(`Duplicate tool contribution: ${item.id}`)
  }
  for (const item of manifest.contributes?.agents ?? []) {
    if (duplicate(`agent:${item.id}`)) throw new Error(`Duplicate agent contribution: ${item.id}`)
  }
  for (const item of manifest.contributes?.prompts ?? []) {
    if (duplicate(`prompt:${item.id}`)) throw new Error(`Duplicate prompt contribution: ${item.id}`)
  }
  for (const item of manifest.contributes?.rpc ?? []) {
    if (duplicate(`rpc:${item.id}`)) throw new Error(`Duplicate RPC contribution: ${item.id}`)
  }
  for (const item of manifest.contributes?.ui ?? []) {
    if (duplicate(`ui:${item.id}`)) throw new Error(`Duplicate UI contribution: ${item.id}`)
  }
  return manifest
}
