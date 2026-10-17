import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer, Option } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { PartID } from "./schema"
import type { SessionID } from "./schema"

// D5 会话账本：记录本会话通过语义工具（read_view / edit_batch / edit_transaction）观察到的
// 文件版本。状态只在进程内、按目录实例隔离；version 对账的权威仍是 read_view(known_version)，
// 这里基于 fs mtime 的 staleness 只是廉价提醒，不参与正确性。
// digest 采用既有 SessionReminders/SessionPeers 的尾部注入先例：只在请求装配时把合成 text part
// 追加到最后一条 user 消息上（内存内、不落库），绝不改写 system prompt / tools / 历史消息；
// 账本为空时不追加任何内容。

const MAX_ENTRIES_PER_SESSION = 64
const MAX_SESSIONS = 128
const MAX_DIGEST_LINES = 8
const MAX_DIGEST_BYTES = 1024
const DIGEST_HEADER = "<reconciliation>"
const DIGEST_FOOTER = "</reconciliation>"

export type Role = "read" | "edit"

export interface Entry {
  file: string
  version: string
  /** 登记版本时的 fs mtime（ms）；stat 失败时缺省，缺省不产生 stale 提醒 */
  mtimeAtRead?: number
  role: Role
  /** 本会话第几次请求装配时使用 */
  lastUseTurn: number
  /** 自己的编辑取代了早先读取时的新版本；标记只通知一次 */
  supersededBy?: string
  supersededVersion?: string
  supersededNotified?: boolean
}

interface SessionState {
  entries: Map<string, Entry>
  turn: number
  touchedAt: number
}

interface Store {
  sessions: Map<SessionID, SessionState>
}

export interface Interface {
  /** read_view 结果（full/delta/unchanged）：登记或刷新文件版本 */
  readonly noteRead: (input: { sessionID: SessionID; file: string; version: string }) => Effect.Effect<void>
  /** edit_batch / edit_transaction 成功：标记自身编辑取代旧读取 */
  readonly noteEdit: (input: { sessionID: SessionID; file: string; newVersion: string }) => Effect.Effect<void>
  /** 有界 digest 文本；无过期项时返回 undefined */
  readonly digest: (sessionID: SessionID) => Effect.Effect<string | undefined>
  /** 请求装配钩子：仅在有 digest 时尾部追加合成文本，返回原数组 */
  readonly apply: (input: {
    sessionID: SessionID
    messages: SessionV1.WithParts[]
  }) => Effect.Effect<SessionV1.WithParts[]>
  readonly entries: (sessionID: SessionID) => Effect.Effect<ReadonlyMap<string, Entry>>
  /** 会话删除时的清理入口 */
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLedger") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const state = yield* InstanceState.make(
      Effect.fn("SessionLedger.state")(() => Effect.succeed<Store>({ sessions: new Map() })),
    )

    const mtimeOf = (file: string) =>
      fsys.stat(file).pipe(
        Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
        Effect.orElseSucceed(() => undefined),
      )

    const touch = (store: Store, sessionID: SessionID) => {
      const existing = store.sessions.get(sessionID)
      if (existing) {
        existing.touchedAt = Date.now()
        return existing
      }
      const created: SessionState = { entries: new Map(), turn: 0, touchedAt: Date.now() }
      store.sessions.set(sessionID, created)
      if (store.sessions.size > MAX_SESSIONS) {
        let oldest: SessionID | undefined
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [id, item] of store.sessions) {
          if (item.touchedAt < oldestAt) {
            oldest = id
            oldestAt = item.touchedAt
          }
        }
        if (oldest !== undefined && oldest !== sessionID) store.sessions.delete(oldest)
      }
      return created
    }

    const put = (session: SessionState, entry: Entry) => {
      session.entries.set(entry.file, entry)
      if (session.entries.size <= MAX_ENTRIES_PER_SESSION) return
      let oldest: string | undefined
      let oldestTurn = Number.POSITIVE_INFINITY
      for (const [file, item] of session.entries) {
        if (item.lastUseTurn < oldestTurn) {
          oldest = file
          oldestTurn = item.lastUseTurn
        }
      }
      if (oldest !== undefined) session.entries.delete(oldest)
    }

    const noteRead = Effect.fn("SessionLedger.noteRead")(function* (input: {
      sessionID: SessionID
      file: string
      version: string
    }) {
      const store = yield* InstanceState.get(state)
      const session = touch(store, input.sessionID)
      put(session, {
        file: input.file,
        version: input.version,
        mtimeAtRead: yield* mtimeOf(input.file),
        role: "read",
        lastUseTurn: session.turn,
      })
    })

    const noteEdit = Effect.fn("SessionLedger.noteEdit")(function* (input: {
      sessionID: SessionID
      file: string
      newVersion: string
    }) {
      const store = yield* InstanceState.get(state)
      const session = touch(store, input.sessionID)
      const existing = session.entries.get(input.file)
      const superseded =
        existing !== undefined && existing.role === "read" && existing.version !== input.newVersion
          ? { supersededBy: input.newVersion, supersededVersion: existing.version, supersededNotified: false }
          : {}
      put(session, {
        file: input.file,
        version: input.newVersion,
        mtimeAtRead: yield* mtimeOf(input.file),
        role: "edit",
        lastUseTurn: session.turn,
        ...superseded,
      })
    })

    const display = (worktree: string, file: string) => {
      const relative = path.relative(worktree, file)
      const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
      return (inside ? relative : file).split(path.sep).join("/")
    }

    // 版本显示归一化：引擎戳是裸 hex，测试/调用方可能传入已带 v 前缀的字符串，避免 vv3
    const shownVersion = (version: string) => `v${version.replace(/^v:?/, "")}`

    const digest = Effect.fn("SessionLedger.digest")(function* (sessionID: SessionID) {
      const store = yield* InstanceState.get(state)
      const session = store.sessions.get(sessionID)
      if (!session || session.entries.size === 0) return undefined
      const ctx = yield* InstanceState.context
      const candidates: { line: string; entry: Entry }[] = []
      const ordered = [...session.entries.values()].sort(
        (a, b) => b.lastUseTurn - a.lastUseTurn || a.file.localeCompare(b.file),
      )
      for (const entry of ordered) {
        // 已被自身编辑取代的读取只通知一次，不再作为 stale 重复出现
        if (entry.supersededBy !== undefined && entry.supersededNotified !== true) {
          candidates.push({
            entry,
            line: `superseded: ${display(ctx.worktree, entry.file)} (your ${shownVersion(entry.supersededVersion!)} replaced by your edit -> ${shownVersion(entry.supersededBy)})`,
          })
          continue
        }
        if (entry.role !== "read" || entry.mtimeAtRead === undefined) continue
        const current = yield* mtimeOf(entry.file)
        if (current === entry.mtimeAtRead) continue
        candidates.push({
          entry,
          line: `stale: ${display(ctx.worktree, entry.file)} (you read ${shownVersion(entry.version)}; file changed since)`,
        })
      }
      if (candidates.length === 0) return undefined
      const more = Math.max(0, candidates.length - MAX_DIGEST_LINES)
      const listed = candidates.slice(0, MAX_DIGEST_LINES - (more > 0 ? 1 : 0))
      const lines = listed.map((item) => item.line)
      if (more > 0) lines.push(`... (+${more} more)`)
      while (
        lines.length > 0 &&
        Buffer.byteLength([DIGEST_HEADER, ...lines, DIGEST_FOOTER].join("\n")) > MAX_DIGEST_BYTES
      ) {
        lines.pop()
      }
      if (lines.length === 0) return undefined
      const rendered = lines.length > listed.length ? listed : listed.slice(0, lines.length)
      for (const item of rendered) if (item.entry.supersededBy !== undefined) item.entry.supersededNotified = true
      return [DIGEST_HEADER, ...lines, DIGEST_FOOTER].join("\n")
    })

    const apply = Effect.fn("SessionLedger.apply")(function* (input: {
      sessionID: SessionID
      messages: SessionV1.WithParts[]
    }) {
      const store = yield* InstanceState.get(state)
      const session = touch(store, input.sessionID)
      session.turn += 1
      const text = yield* digest(input.sessionID)
      if (text === undefined) return input.messages
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text,
        synthetic: true,
        metadata: { reconciliation: true },
      })
      return input.messages
    })

    const entries = Effect.fn("SessionLedger.entries")(function* (sessionID: SessionID) {
      const store = yield* InstanceState.get(state)
      const session = store.sessions.get(sessionID)
      return new Map(session ? [...session.entries] : [])
    })

    const clear = Effect.fn("SessionLedger.clear")(function* (sessionID: SessionID) {
      const store = yield* InstanceState.get(state)
      store.sessions.delete(sessionID)
    })

    return Service.of({ noteRead, noteEdit, digest, apply, entries, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as SessionLedger from "./ledger"
