import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { teamDelegationGuidance } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())

afterEach(async () => {
  await disposeAllInstances()
})

describe("session.system.teamDelegationGuidance", () => {
  it.instance("returns undefined when agent teams are disabled", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")

      expect(teamDelegationGuidance({ agent: build, enabled: false })).toBeUndefined()
    }),
  )

  it.instance("returns the delegation guidance for a primary agent when enabled", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")

      const guidance = teamDelegationGuidance({ agent: build, enabled: true })

      expect(guidance).toContain("team_delegation")
      expect(guidance).toContain("dispatch")
      expect(guidance).toContain("budget_tokens")
      expect(guidance).toContain("Default to delegating")
    }),
  )

  it.instance("returns undefined for subagents even when enabled", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const explore = yield* agents.get("explore")

      expect(teamDelegationGuidance({ agent: explore, enabled: true })).toBeUndefined()
    }),
  )

  it.instance(
    "returns undefined when the dispatch permission is denied",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")

        expect(teamDelegationGuidance({ agent: build, enabled: true })).toBeUndefined()
      }),
    {
      config: {
        permission: {
          dispatch: "deny",
        },
      },
    },
  )

  it.instance(
    "omits the coordination line when blackboard and agent_send are denied",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")

        const guidance = teamDelegationGuidance({ agent: build, enabled: true })

        expect(guidance).not.toContain("Coordination:")
      }),
    {
      config: {
        permission: {
          blackboard: "deny",
          agent_send: "deny",
        },
      },
    },
  )
})
