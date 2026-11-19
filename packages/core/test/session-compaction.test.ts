import { expect, test } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import type { EventV2 } from "@opencode-ai/core/event"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { LLM, LLMError, LLMEvent, Message, Model, TransportReason, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { DateTime, Effect, Stream } from "effect"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

const sessionID = SessionSchema.ID.make("ses_compaction_manual")
const model = Model.make({
  id: "compact-test",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 500 } }),
})
const config = [
  new Config.Document({
    type: "document",
    info: new Config.Info({
      compaction: new ConfigCompaction.Info({ keep: new ConfigCompaction.Keep({ tokens: 1 }) }),
    }),
  }),
]
const request = (text: string) => LLM.request({ model, messages: [Message.user(text)] })
const user = (text: string, id = SessionMessage.ID.create()) =>
  SessionMessage.User.make({
    id,
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(1) },
  })
const input = (entries: Array<{ seq: number; message: SessionMessage.Message }>) => ({
  sessionID,
  entries,
  model,
  request: request(entries.map((entry) => (entry.message.type === "user" ? entry.message.text : "")).join("\n")),
})
const promptText = (value: LLMRequest) =>
  value.messages
    .flatMap((message) => message.content)
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")

test("compaction prompt includes explicit focus", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["conversation history"],
    focus: "preserve API decisions",
  })

  expect(prompt).toContain("<focus>\npreserve API decisions\n</focus>")
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("<focus>"))
})

test("manual compaction uses the manual reason and passes focus to the summary prompt", async () => {
  const published: Array<{ type: string; data: { reason?: string; text?: string; recent?: string } }> = []
  const requests: LLMRequest[] = []
  const events = {
    publish: ((definition: { type: string }, data: { reason?: string; text?: string; recent?: string }) => {
      published.push({ type: definition.type, data })
      return Effect.succeed({})
    }) as unknown as EventV2.Interface["publish"],
  } as EventV2.Interface
  const compaction = SessionCompaction.make({
    events,
    llm: {
      stream: (value) => {
        requests.push(value)
        return Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "## Objective\n- Keep the API stable" })])
      },
    },
    config,
  })

  const result = await Effect.runPromise(
    compaction.compactManually(
      input([{ seq: 1, message: user("discussion about the parser") }]),
      "preserve API decisions",
    ),
  )

  expect(result).toBe(true)
  expect(requests).toHaveLength(1)
  expect(promptText(requests[0]!)).toContain("<focus>\npreserve API decisions\n</focus>")
  expect(published.map((event) => event.type)).toEqual([
    "session.next.compaction.started",
    "session.next.compaction.ended",
  ])
  expect(published[0]!.data.reason).toBe("manual")
  expect(published[1]).toMatchObject({
    data: { reason: "manual", text: "## Objective\n- Keep the API stable", recent: "" },
  })
})

test("manual compaction skips empty conversations without publishing events", async () => {
  const published: string[] = []
  const events = {
    publish: ((definition: { type: string }) => {
      published.push(definition.type)
      return Effect.succeed({})
    }) as unknown as EventV2.Interface["publish"],
  } as EventV2.Interface
  const compaction = SessionCompaction.make({
    events,
    llm: { stream: () => Stream.die("summary must not run") },
    config,
  })

  const result = await Effect.runPromise(compaction.compactManually(input([]), "keep decisions"))

  expect(result).toBe(false)
  expect(published).toEqual([])
})

test("manual compaction reports provider failure without publishing an end event", async () => {
  const published: string[] = []
  const events = {
    publish: ((definition: { type: string }) => {
      published.push(definition.type)
      return Effect.succeed({})
    }) as unknown as EventV2.Interface["publish"],
  } as EventV2.Interface
  const compaction = SessionCompaction.make({
    events,
    llm: {
      stream: () =>
        Stream.fail(
          new LLMError({
            module: "test",
            method: "stream",
            reason: new TransportReason({ message: "summary unavailable" }),
          }),
        ),
    },
    config,
  })

  const result = await Effect.runPromise(
    compaction.compactManually(input([{ seq: 1, message: user("discussion about the parser") }]), "keep decisions"),
  )

  expect(result).toBe(false)
  expect(published).toEqual(["session.next.compaction.started"])
})
