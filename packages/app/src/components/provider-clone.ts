import type { Config, Model, Provider } from "@opencode-ai/sdk/v2/client"

type ProviderConfig = NonNullable<Config["provider"]>[string]
type ConfigModel = NonNullable<ProviderConfig["models"]>[string]

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const

export function cloneProviderID(source: string, taken: Iterable<string>) {
  const base =
    source
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider"
  const existing = new Set(taken)
  let index = 2
  while (existing.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}

export function cloneProviderConfig(source: Provider, name: string): ProviderConfig {
  const npm = Object.values(source.models)[0]?.api.npm
  return {
    name,
    ...(npm ? { npm } : {}),
    models: Object.fromEntries(Object.entries(source.models).map(([id, model]) => [id, cloneModel(model)])),
  }
}

// 复制模型元数据（含 variants/思考强度）；不复制 provider options，避免把旧 key 写入配置
function cloneModel(model: Model): ConfigModel {
  const input = MODALITIES.filter((item) => model.capabilities.input[item])
  const output = MODALITIES.filter((item) => model.capabilities.output[item])
  return {
    name: model.name,
    family: model.family || undefined,
    release_date: model.release_date || undefined,
    attachment: model.capabilities.attachment,
    reasoning: model.capabilities.reasoning,
    temperature: model.capabilities.temperature,
    tool_call: model.capabilities.toolcall,
    interleaved: model.capabilities.interleaved || undefined,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cache.read,
      cache_write: model.cost.cache.write,
    },
    limit: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
    modalities: { input: [...input], output: [...output] },
    status: model.status,
    provider: { npm: model.api.npm, ...(model.api.url ? { api: model.api.url } : {}) },
    ...(Object.keys(model.options).length ? { options: model.options } : {}),
    ...(Object.keys(model.headers).length ? { headers: model.headers } : {}),
    ...(model.variants && Object.keys(model.variants).length ? { variants: cloneVariants(model.variants) } : {}),
  }
}

function cloneVariants(variants: NonNullable<Model["variants"]>) {
  return Object.fromEntries(
    Object.entries(variants).flatMap(([id, value]) => {
      const { disabled, ...rest } = value as { disabled?: boolean } & Record<string, unknown>
      if (disabled) return []
      return Object.keys(rest).length ? [[id, rest]] : []
    }),
  )
}
