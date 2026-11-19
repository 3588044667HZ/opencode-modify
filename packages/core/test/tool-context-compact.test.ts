import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionCompactionRequest } from "@opencode-ai/core/session/compaction-request"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ContextCompactTool } from "@opencode-ai/core/tool/context-compact"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionSchema.ID.make("ses_context_compact_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionCompactionRequest.node,
      ContextCompactTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
})

const call = (input: { focus?: string }, id = "call-context-compact") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: ContextCompactTool.name, input },
})

describe("ContextCompactTool", () => {
  it.effect("registers, queues focus, and explains the safe boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const requests = yield* SessionCompactionRequest.Service

      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === ContextCompactTool.name)
      expect(definition?.description).toContain("next safe provider-turn boundary")
      expect(JSON.stringify(definition?.inputSchema)).toContain("focus")

      expect(yield* settleTool(registry, call({ focus: "  keep API decisions  " }))).toEqual({
        result: {
          type: "text",
          value: "Context compaction queued for the next safe provider-turn boundary. Focus: keep API decisions",
        },
        output: {
          structured: {
            queued: true,
            reason: "Queued for the next safe provider-turn boundary",
            focus: "keep API decisions",
          },
          content: [
            {
              type: "text",
              text: "Context compaction queued for the next safe provider-turn boundary. Focus: keep API decisions",
            },
          ],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "context_compact", resources: ["*"] }])
      expect(yield* requests.take(sessionID)).toEqual({ focus: "keep API decisions" })
      expect(yield* requests.take(sessionID)).toBeUndefined()
    }),
  )

  it.effect("coalesces repeated requests and keeps the latest non-empty focus", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const requests = yield* SessionCompactionRequest.Service

      yield* executeTool(registry, call({ focus: "first focus" }, "call-first"))
      yield* executeTool(registry, call({ focus: "second focus" }, "call-second"))
      expect(yield* requests.take(sessionID)).toEqual({ focus: "second focus" })

      yield* executeTool(registry, call({ focus: "retained focus" }, "call-retained"))
      yield* executeTool(registry, call({}, "call-empty"))
      expect(yield* requests.take(sessionID)).toEqual({ focus: "retained focus" })
    }),
  )

  it.effect("reports permission denial without queueing", () =>
    Effect.gen(function* () {
      yield* setup
      deny = true
      const registry = yield* ToolRegistry.Service
      const requests = yield* SessionCompactionRequest.Service

      expect(yield* executeTool(registry, call({ focus: "blocked" }))).toEqual({
        type: "error",
        value: "Permission denied: context_compact",
      })
      expect(yield* requests.take(sessionID)).toBeUndefined()
    }),
  )
})
