import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { Truncate } from "@/tool/truncate"
import { ContextTool } from "../../src/tool/context"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function fake(context: number) {
  return ProviderTest.fake({
    model: ProviderTest.model({
      id: ref.modelID,
      providerID: ref.providerID,
      limit: { context, output: 10_000 },
    }),
  })
}

const testNode = LayerNode.group([
  Agent.node,
  Config.node,
  EventV2Bridge.node,
  Session.node,
  SessionProjector.node,
  Truncate.node,
  Database.node,
  RuntimeFlags.node,
  Provider.node,
])

const it = testEffect(LayerNode.compile(testNode, [[Provider.node, fake(200_000).layer]]))
const itWithoutLimit = testEffect(LayerNode.compile(testNode, [[Provider.node, fake(0).layer]]))

function seedAssistant(input: {
  sessionID: Session.Info["id"]
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    return yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: user.id,
      sessionID: input.sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: input.reasoning ?? 0,
        cache: { read: input.cacheRead ?? 0, write: input.cacheWrite ?? 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
  })
}

function context(sessionID: Session.Info["id"], agent = "build") {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.context", () => {
  it.instance("reports context usage for the current session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* ContextTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({ title: "current" })
      yield* seedAssistant({ sessionID: chat.id, input: 1_000, output: 500 })
      const assistant = yield* seedAssistant({
        sessionID: chat.id,
        input: 100_000,
        output: 20_000,
        reasoning: 5_000,
        cacheRead: 10_000,
        cacheWrite: 2_000,
      })

      const result = yield* def.execute({}, context(chat.id))

      expect(result.output).toContain(`session="${chat.id}"`)
      expect(result.output).toContain(`agent="build"`)
      expect(result.output).toContain(`model="${ref.providerID}/${ref.modelID}"`)
      expect(result.output).toContain(
        `<window limit="200000" used="137000" percent="69" remaining="63000" over="false" />`,
      )
      expect(result.output).toContain(
        `<tokens input="100000" output="20000" reasoning="5000" cache_read="10000" cache_write="2000" />`,
      )
      expect(result.output).toContain(`<source message="${assistant.id}" />`)
      expect(result.metadata).toMatchObject({
        session: chat.id,
        model: `${ref.providerID}/${ref.modelID}`,
        message: assistant.id,
        used: 137_000,
        limit: 200_000,
        percent: 69,
        remaining: 63_000,
        over: false,
      })
      expect(result.metadata.tokens).toEqual({
        input: 100_000,
        output: 20_000,
        reasoning: 5_000,
        cache_read: 10_000,
        cache_write: 2_000,
      })
    }),
  )

  it.instance("reports context usage for a descendant subagent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* ContextTool
      const def = yield* tool.init()
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
      yield* seedAssistant({ sessionID: grandchild.id, input: 40_000, output: 10_000 })

      const result = yield* def.execute({ session_id: grandchild.id }, context(root.id))

      expect(result.output).toContain(`session="${grandchild.id}"`)
      expect(result.output).toContain(
        `<window limit="200000" used="50000" percent="25" remaining="150000" over="false" />`,
      )
      expect(result.metadata).toMatchObject({ session: grandchild.id, used: 50_000, percent: 25 })
    }),
  )

  it.instance("rejects an unrelated session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* ContextTool
      const def = yield* tool.init()
      const root = yield* sessions.create({ title: "root" })
      const sibling = yield* sessions.create({ title: "sibling" })
      yield* seedAssistant({ sessionID: sibling.id, input: 1_000, output: 500 })

      const exit = yield* def.execute({ session_id: sibling.id }, context(root.id)).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("returns unavailable when the session has no assistant tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* ContextTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({ title: "empty" })

      const result = yield* def.execute({}, context(chat.id))

      expect(result.output).toContain(`<context session="${chat.id}"`)
      expect(result.output).toContain(`unavailable="no assistant token usage"`)
      expect(result.metadata).toMatchObject({
        session: chat.id,
        tokens: null,
        limit: null,
        percent: null,
        remaining: null,
        over: false,
        unavailable: "no assistant token usage",
      })
    }),
  )

  itWithoutLimit.instance("returns unavailable when the model context limit is missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* ContextTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({ title: "no-limit" })
      const assistant = yield* seedAssistant({ sessionID: chat.id, input: 1_000, output: 500 })

      const result = yield* def.execute({}, context(chat.id))

      expect(result.output).toContain(`unavailable="model context limit unavailable"`)
      expect(result.output).toContain(`<source message="${assistant.id}" />`)
      expect(result.metadata).toMatchObject({
        session: chat.id,
        message: assistant.id,
        tokens: null,
        limit: null,
        percent: null,
        remaining: null,
        unavailable: "model context limit unavailable",
      })
    }),
  )

  it.instance("does not clamp percent and floors remaining when over the limit", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* ContextTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({ title: "over" })
      yield* seedAssistant({ sessionID: chat.id, input: 220_000, output: 30_000 })

      const result = yield* def.execute({}, context(chat.id))

      expect(result.output).toContain(`<window limit="200000" used="250000" percent="125" remaining="0" over="true" />`)
      expect(result.metadata).toMatchObject({ used: 250_000, limit: 200_000, percent: 125, remaining: 0, over: true })
    }),
  )
})
