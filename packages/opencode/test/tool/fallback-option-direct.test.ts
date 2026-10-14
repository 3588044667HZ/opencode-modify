import { afterEach, describe, expect } from "bun:test"
import { createHash } from "crypto"
import path from "path"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ToolJsonSchema } from "@/tool/json-schema"
import { FallbackOptionDirectTool } from "@/tool/fallback-option-direct"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node, Truncate.node])
const it = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ] as const),
)

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = (agent: string): Tool.Context => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const fixture = path.join(import.meta.dir, "..", "fixtures", "fallback_option_direct", "output.txt")

const modelInput = (agent: Agent.Info) => ({
  providerID: ProviderV2.ID.opencode,
  modelID: ModelV2.ID.make("test"),
  agent,
})

const catalogHash = (tools: Tool.Def[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          id: tool.id,
          description: tool.description,
          parameters: ToolJsonSchema.fromTool(tool),
        })),
      ),
    )
    .digest("hex")

describe("tool.fallback_option_direct", () => {
  it.instance("renders the byte-exact fallback document for the frozen hidden set", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const def = (yield* registry.all()).find((tool) => tool.id === FallbackOptionDirectTool.NAME)
      if (!def) throw new Error("fallback_option_direct is not registered")

      const result = yield* def.execute({}, ctx((yield* agents.defaultInfo()).name))

      expect(result.output).toBe(yield* Effect.promise(() => Bun.file(fixture).text()))
      expect(result.metadata).toMatchObject({ tools: [] })
    }),
  )

  it.instance("exposes the fallback entry point and the direct tools in the model catalog", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = (yield* registry.tools(modelInput(yield* agents.defaultInfo()))).map((tool) => tool.id)

      expect(ids).toContain(FallbackOptionDirectTool.NAME)
      expect(ids).toContain("edit")
      expect(ids).toContain("write")
    }),
  )

  it.effect("includes injected hidden tools dynamically in registration order", () =>
    Effect.gen(function* () {
      const output = FallbackOptionDirectTool.renderFallbackOptionDirect([
        {
          name: "edit",
          description: "Exact string replacement.",
          parameters: ["filePath", "oldString", "newString", "replaceAll"],
        },
        { name: "write", description: "Overwrite a file.", parameters: ["content", "filePath"] },
      ])

      expect(output).toContain(
        [
          "── edit ──",
          "Exact string replacement.",
          "Parameters: filePath, oldString, newString, replaceAll",
          "",
          "── write ──",
          "Overwrite a file.",
          "Parameters: content, filePath",
        ].join("\n"),
      )
      expect(output.startsWith("These tools have always existed; they are hidden from your default view.")).toBe(true)
      expect(output.endsWith("These tools are blunt. Use them only when the new tools cannot handle the task.")).toBe(
        true,
      )
    }),
  )

  it.effect("filters synthetic hidden tools from the model-visible list", () =>
    Effect.gen(function* () {
      const visible: { id: string; hide?: boolean } = { id: FallbackOptionDirectTool.NAME }
      const hidden: { id: string; hide?: boolean } = { id: "synthetic_hidden", hide: true }

      expect(Tool.visibleTools([visible, hidden]).map((tool) => tool.id)).toEqual([FallbackOptionDirectTool.NAME])
      expect(Tool.hiddenTools([visible, hidden]).map((tool) => tool.id)).toEqual(["synthetic_hidden"])
    }),
  )

  it.effect("keeps hidden tools in the execution catalog only", () =>
    Effect.gen(function* () {
      const visible = { id: FallbackOptionDirectTool.NAME, hide: false }
      const hidden = { id: "synthetic_hidden", hide: true }

      const catalog = SessionTools.toolCatalog({ visible: [visible], all: [visible, hidden] })

      expect(catalog.active).toEqual([FallbackOptionDirectTool.NAME])
      expect(catalog.execution.map((tool) => tool.id)).toEqual([FallbackOptionDirectTool.NAME, "synthetic_hidden"])
    }),
  )

  it.instance("executes a hidden tool even though it is not model visible", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const info = yield* Tool.define(
        "synthetic_hidden",
        Effect.succeed({
          hide: true,
          description: "Synthetic hidden tool used by tests.",
          parameters: Schema.Struct({ mark: Schema.String }),
          execute: (args: { mark: string }) =>
            Effect.succeed({ title: "synthetic_hidden", metadata: {}, output: `hidden:${args.mark}` }),
        }),
      )
      const def = yield* Tool.init(info)
      const catalog = SessionTools.toolCatalog({ visible: [], all: [def] })

      expect(catalog.active).toEqual([])
      expect(catalog.execution.map((tool) => tool.id)).toEqual(["synthetic_hidden"])

      const result = yield* def.execute({ mark: "ok" }, ctx((yield* agents.defaultInfo()).name))
      expect(result.output).toBe("hidden:ok")
    }),
  )

  it.effect("excludes hidden tools from provider tool definitions", () =>
    Effect.gen(function* () {
      const tools = {
        fallback_option_direct: {},
        synthetic_hidden: {},
        invalid: {},
      }

      expect(LLMRequestPrep.visibleToolNames(tools, ["fallback_option_direct"])).toEqual(["fallback_option_direct"])
      expect(LLMRequestPrep.visibleToolNames(tools, ["fallback_option_direct", "missing"])).toEqual([
        "fallback_option_direct",
      ])
      expect(LLMRequestPrep.visibleToolNames(tools)).toEqual(["fallback_option_direct", "synthetic_hidden"])
    }),
  )

  it.instance("keeps the model-visible catalog stable across a fallback call (prompt cache)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const input = modelInput(yield* agents.defaultInfo())

      const before = catalogHash(yield* registry.tools(input))
      const fallback = (yield* registry.all()).find((tool) => tool.id === FallbackOptionDirectTool.NAME)
      if (!fallback) throw new Error("fallback_option_direct is not registered")
      yield* fallback.execute({}, ctx(input.agent.name))
      const after = catalogHash(yield* registry.tools(input))

      expect(after).toBe(before)
    }),
  )
})
