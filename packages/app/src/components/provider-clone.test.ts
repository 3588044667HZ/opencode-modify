import { describe, expect, test } from "bun:test"
import type { Provider } from "@opencode-ai/sdk/v2/client"
import { cloneProviderConfig, cloneProviderID } from "./provider-clone"

const source: Provider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  key: "sk-source-secret",
  options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-source-secret" },
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: { id: "gpt-5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      name: "GPT-5",
      family: "gpt",
      capabilities: {
        temperature: false,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: { field: "reasoning" },
      },
      cost: { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
      limit: { context: 400000, input: 272000, output: 128000 },
      status: "active",
      options: { reasoningEffort: "medium" },
      headers: { "x-test": "1" },
      release_date: "2025-08-07",
      variants: {
        high: { reasoningEffort: "high" },
        low: { disabled: true, reasoningEffort: "low" },
      },
    },
  },
}

describe("provider clone", () => {
  test("generates a unique provider id", () => {
    expect(cloneProviderID("openai", [])).toBe("openai-2")
    expect(cloneProviderID("openai", ["openai-2", "openai-3"])).toBe("openai-4")
    expect(cloneProviderID("GitHub Copilot", [])).toBe("github-copilot-2")
  })

  test("copies models, thinking variants, and limits", () => {
    const config = cloneProviderConfig(source, "OpenAI Work")
    expect(config.name).toBe("OpenAI Work")
    expect(config.npm).toBe("@ai-sdk/openai")
    const model = config.models?.["gpt-5"]
    expect(model).toBeDefined()
    expect(model?.provider).toEqual({ npm: "@ai-sdk/openai", api: "https://api.openai.com/v1" })
    expect(model?.variants).toEqual({ high: { reasoningEffort: "high" } })
    expect(model?.limit).toEqual({ context: 400000, input: 272000, output: 128000 })
    expect(model?.cost).toEqual({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 })
    expect(model?.modalities).toEqual({
      input: ["text", "image"],
      output: ["text"],
    })
    expect(model?.interleaved).toEqual({ field: "reasoning" })
  })

  test("never copies provider secrets into config", () => {
    const config = cloneProviderConfig(source, "OpenAI Work")
    expect(JSON.stringify(config)).not.toContain("sk-source-secret")
    expect(config.options).toBeUndefined()
  })
})
