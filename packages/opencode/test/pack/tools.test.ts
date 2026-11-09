import { describe, expect, test } from "bun:test"
import type { Contribution } from "@opencode-ai/plugin/pack"
import { Effect } from "effect"
import { PackTools } from "@/pack/tool"
import { MessageID, SessionID } from "@/session/schema"

const context: Parameters<ReturnType<typeof PackTools.fromContributions>[number]["execute"]>[1] = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const contribution: Contribution = {
  packId: "review",
  scope: "project:test",
  kind: "tool",
  id: "review.diff",
  value: {
    id: "review.diff",
    description: "Review a diff",
    method: "review.diff",
    inputSchema: { type: "object", properties: { patch: { type: "string" } } },
  },
}

describe("pack tools", () => {
  test("maps a tool contribution to a callable tool", async () => {
    const calls: Array<{ packId: string; method: string; params: unknown }> = []
    const tools = PackTools.fromContributions([contribution], (packId, method, params) => {
      calls.push({ packId, method, params })
      return Effect.succeed({ ok: true })
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe("review.diff")
    expect(tools[0]?.description).toBe("Review a diff")
    expect(tools[0]?.jsonSchema).toEqual({ type: "object", properties: { patch: { type: "string" } } })

    const result = await Effect.runPromise(tools[0]!.execute({ patch: "diff" }, context))
    expect(result.output).toBe('{"ok":true}')
    expect(calls).toEqual([{ packId: "review", method: "review.diff", params: { patch: "diff" } }])
  })

  test("uses the tool id as the method and reports call failures", async () => {
    const tools = PackTools.fromContributions(
      [{ ...contribution, value: { id: "review.status", description: "Status" } }],
      (_packId, method) => {
        expect(method).toBe("review.status")
        return Effect.fail(new Error("offline"))
      },
    )

    const result = await Effect.runPromise(tools[0]!.execute({}, context))
    expect(result.output).toContain("Pack tool review.status failed: offline")
  })

  test("ignores malformed contributions and non-tool values", () => {
    expect(
      PackTools.fromContributions(
        [
          { ...contribution, value: null },
          { ...contribution, value: { id: "missing-description" } },
        ],
        () => Effect.succeed(undefined),
      ),
    ).toEqual([])
  })
})
