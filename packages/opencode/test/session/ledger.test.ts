import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Semantic } from "@/semantic/manager"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionLedger } from "../../src/session/ledger"
import { EditBatchTool } from "../../src/tool/edit-batch"
import { EditTransactionTool } from "../../src/tool/edit-transaction"
import { ReadViewTool } from "../../src/tool/read-view"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const fakeDaemon = path.join(import.meta.dir, "..", "semantic", "fake-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const toolLayer = () =>
  LayerNode.compile(
    LayerNode.group([Semantic.node, Agent.node, Truncate.node, CrossSpawnSpawner.node, SessionLedger.node]),
  )
const it = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

const sessionID = SessionID.make("ses_ledger")
const ctx = {
  sessionID,
  messageID: MessageID.make("msg_ledger"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const waitReady = Effect.gen(function* () {
  const semantic = yield* Semantic.Service
  yield* semantic.init()
  yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.catch(() => Effect.void))
  yield* pollWithTimeout(
    Effect.gen(function* () {
      const current = yield* semantic.status()
      return current.status === "ready" ? current : undefined
    }),
    "semantic engine never became ready",
    "15 seconds",
  )
})

function userMessage(texts: string[]): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      tools: {},
    } as unknown as SessionV1.User,
    parts: texts.map((text) => ({
      id: PartID.ascending(),
      messageID: id,
      sessionID,
      type: "text" as const,
      text,
    })),
  }
}

function assistantMessage(text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      time: { created: Date.now() },
      agent: "build",
      modelID: "test",
      providerID: "test",
      mode: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as SessionV1.Assistant,
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function tailText(messages: SessionV1.WithParts[]): string | undefined {
  const user = messages.findLast((msg) => msg.info.role === "user")
  const part = user?.parts.at(-1)
  if (!part || part.type !== "text") return undefined
  return part.text
}

const writeFile = (file: string, content: string) => Effect.promise(() => fs.writeFile(file, content))
const touchFile = (file: string) =>
  Effect.promise(() => fs.utimes(file, new Date(), new Date(Date.now() + 60_000)))
const makeStale = (dir: string, file: string, version = "v3") =>
  Effect.gen(function* () {
    const ledger = yield* SessionLedger.Service
    yield* ledger.noteRead({ sessionID, file, version })
    yield* touchFile(file)
    return ledger
  })

describe("session.ledger", () => {
  it.live(
    "records read_view versions and marks an own edit as supersede",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { semantic: { enabled: true, command: command() } } })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            yield* waitReady
            const readInfo = yield* ReadViewTool
            const read = yield* readInfo.init()
            yield* read.execute({ file: "engine.ts", view: "entry" }, ctx)

            const ledger = yield* SessionLedger.Service
            const file = path.join(dir, "engine.ts")
            const afterRead = (yield* ledger.entries(sessionID)).get(file)
            expect(afterRead).toMatchObject({ version: "a3f9c2", role: "read" })
            // 假引擎不会真的建文件，stat 失败时 mtime 缺省，不产生 stale 提醒。
            expect(afterRead?.mtimeAtRead).toBeUndefined()

            const editInfo = yield* EditBatchTool
            const edit = yield* editInfo.init()
            yield* edit.execute(
              {
                file: "engine.ts",
                changes: [{ oldString: "return json.load(data)", newString: "return parse(data)" }],
                baseVersion: "a3f9c2",
              },
              ctx,
            )

            const afterEdit = (yield* ledger.entries(sessionID)).get(file)
            expect(afterEdit).toMatchObject({
              version: "b7e1d4",
              role: "edit",
              supersededBy: "b7e1d4",
              supersededVersion: "a3f9c2",
            })
          }),
        )
      }),
    20_000,
  )

  it.live(
    "records every applied edit_transaction file by request path",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { semantic: { enabled: true, command: command() } } })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            yield* waitReady
            const info = yield* EditTransactionTool
            const tool = yield* info.init()
            yield* tool.execute(
              {
                changes: [
                  {
                    file: "src/core/engine.ts",
                    baseVersion: "a3f9c2",
                    changes: [{ oldString: "return json.load(data)", newString: "return parse(data)" }],
                  },
                  {
                    file: "src/api/routes.ts",
                    baseVersion: "c1d2e3",
                    changes: [{ oldString: "router.get", newString: "router.post" }],
                  },
                ],
              },
              ctx,
            )

            const ledger = yield* SessionLedger.Service
            const entries = yield* ledger.entries(sessionID)
            expect(entries.get(path.join(dir, "src", "core", "engine.ts"))?.version).toBe("b7e1d4")
            expect(entries.get(path.join(dir, "src", "api", "routes.ts"))?.version).toBe("f4a5b6")
            // 引擎结果里未请求的文件不进入账本。
            expect(entries.size).toBe(2)
          }),
        )
      }),
    20_000,
  )

  it.live(
    "appends a bounded tail digest only after the file changed",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const file = path.join(dir, "src", "a.ts")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* writeFile(file, "export const a = 1\n")
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const ledger = yield* SessionLedger.Service
            const messages = [userMessage(["hello"])]
            yield* ledger.noteRead({ sessionID, file, version: "v3" })

            const unchanged = yield* ledger.apply({ sessionID, messages })
            expect(unchanged).toBe(messages)
            expect(messages[0].parts).toHaveLength(1)

            yield* touchFile(file)
            yield* ledger.apply({ sessionID, messages })
            expect(messages[0].parts).toHaveLength(2)
            const part = messages[0].parts.at(-1)
            expect(part?.type).toBe("text")
            if (part?.type !== "text") throw new Error("digest part missing")
            expect(part.synthetic).toBe(true)
            expect(part.text).toBe(
              ["<reconciliation>", "stale: src/a.ts (you read v3; file changed since)", "</reconciliation>"].join("\n"),
            )
          }),
        )
      }),
    20_000,
  )

  it.live(
    "caps the digest by lines and bytes",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const files = Array.from({ length: 12 }, (_, index) =>
          path.join(dir, "src", `stale-${String(index).padStart(2, "0")}-${"a".repeat(120)}.ts`),
        )
        yield* Effect.promise(() => fs.mkdir(path.join(dir, "src"), { recursive: true }))
        yield* Effect.forEach(files, (file) => writeFile(file, "export const x = 1\n"), { discard: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const ledger = yield* SessionLedger.Service
            for (const file of files) yield* ledger.noteRead({ sessionID, file, version: "v1" })
            yield* Effect.forEach(files, touchFile, { discard: true })

            const messages = [userMessage(["go"])]
            yield* ledger.apply({ sessionID, messages })
            const text = tailText(messages)
            expect(text).toBeDefined()
            expect(Buffer.byteLength(text ?? "")).toBeLessThanOrEqual(1024)
            expect((text ?? "").split("\n").length).toBeLessThanOrEqual(10)
            expect(text).toContain("stale: src/stale-00")
          }),
        )
      }),
    20_000,
  )

  it.live(
    "notifies supersede once and never digests superseded files as stale",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const file = path.join(dir, "src", "b.ts")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* writeFile(file, "export const b = 1\n")
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const ledger = yield* SessionLedger.Service
            const messages = [userMessage(["go"])]
            yield* ledger.noteRead({ sessionID, file, version: "v2" })
            yield* ledger.noteEdit({ sessionID, file, newVersion: "v5" })

            yield* ledger.apply({ sessionID, messages })
            expect(tailText(messages)).toBe(
              [
                "<reconciliation>",
                "superseded: src/b.ts (your v2 replaced by your edit -> v5)",
                "</reconciliation>",
              ].join("\n"),
            )
            expect(messages[0].parts).toHaveLength(2)

            // 标记只出现一次；之后即使外部再改 mtime 也不再作为 stale 出现。
            yield* ledger.apply({ sessionID, messages })
            yield* touchFile(file)
            yield* ledger.apply({ sessionID, messages })
            expect(messages[0].parts).toHaveLength(2)
          }),
        )
      }),
    20_000,
  )

  it.live(
    "never rewrites the pre-digest messages (cache-prefix invariant)",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const file = path.join(dir, "src", "c.ts")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* writeFile(file, "export const c = 1\n")
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const ledger = yield* makeStale(dir, file)
            const messages = [userMessage(["first"]), assistantMessage("ack"), userMessage(["second", "more"])]
            const before = structuredClone(messages)

            yield* ledger.apply({ sessionID, messages })

            expect(Bun.hash(JSON.stringify(messages.slice(0, -1)))).toBe(
              Bun.hash(JSON.stringify(before.slice(0, -1))),
            )
            expect(messages.slice(0, -1)).toEqual(before.slice(0, -1))
            const beforeLast = before.at(-1)
            if (!beforeLast || beforeLast.info.role !== "user") throw new Error("fixture missing last user")
            expect(messages.at(-1)?.parts.slice(0, beforeLast.parts.length)).toEqual(beforeLast.parts)
            expect(messages.at(-1)?.parts.length).toBe(beforeLast.parts.length + 1)
            expect(tailText(messages)).toContain("stale: src/c.ts")
          }),
        )
      }),
    20_000,
  )

  it.live(
    "empty ledger leaves the request byte-identical",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const ledger = yield* SessionLedger.Service
            const messages = [userMessage(["only"]), assistantMessage("ack"), userMessage(["now"])]
            const before = JSON.stringify(messages)

            const result = yield* ledger.apply({ sessionID, messages })

            expect(result).toBe(messages)
            expect(JSON.stringify(messages)).toBe(before)
            expect(messages.at(-1)?.parts).toHaveLength(1)
            expect(tailText(messages)).toBe("now")
          }),
        )
      }),
    20_000,
  )
})
