import * as Tool from "./tool"
import DESCRIPTION from "./team.txt"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionID } from "../session/schema"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"

const id = "team"
const MAX_MEMBERS = 32
const MAX_OUTPUT_BYTES = 2048
const MAX_LAST_TEXT = 500
const TRUNCATED = "\n<!-- truncated -->"

export const Parameters = Schema.Struct({
  op: Schema.Literals(["status", "stop"]).annotate({
    description: '"status" lists members; "stop" cancels members',
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "op=stop: the member session to stop. op=status: the descendant to add a detail block for",
  }),
  all: Schema.optional(Schema.Boolean).annotate({
    description: "op=stop: stop every descendant of this session",
  }),
})

export const TeamTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const permissions = yield* Permission.Service
    const background = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service

    const getSession = (sessionID: SessionID) =>
      sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    // 沿 parentID 上溯判断 target 是否为 root 的后代（root 自身不算后代）
    const isDescendant = (target: string, root: SessionID) =>
      Effect.gen(function* () {
        let cursor = yield* getSession(SessionID.make(target))
        while (cursor?.parentID) {
          if (cursor.parentID === root) return true
          cursor = yield* getSession(cursor.parentID)
        }
        return false
      })

    // 广度优先收集全部后代，受 MAX_MEMBERS 上限约束
    const collectDescendants = (root: SessionID) =>
      Effect.gen(function* () {
        const out: Session.Info[] = []
        let frontier = yield* sessions.children(root)
        while (frontier.length > 0 && out.length < MAX_MEMBERS) {
          const next: Session.Info[] = []
          for (const child of frontier) {
            if (out.length >= MAX_MEMBERS) break
            out.push(child)
            next.push(...(yield* sessions.children(child.id)))
          }
          frontier = next
        }
        return out
      })

    const lastActivity = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const messages = yield* sessions
          .messages({ sessionID, limit: 1 })
          .pipe(Effect.catchCause(() => Effect.succeed([] as SessionV1.WithParts[])))
        const message = messages.at(-1)
        if (!message) return { part: undefined, at: undefined }
        const part = message.parts.at(-1)
        const at = part ? (partTime(part) ?? messageTime(message)) : undefined
        return { part, at }
      })

    const renderMemberLine = (child: Session.Info, pending: readonly PermissionV1.Request[], now: number) =>
      Effect.gen(function* () {
        const job = yield* background.get(child.id)
        const state = job
          ? job.status
          : yield* status.get(child.id).pipe(Effect.map((item) => (item.type === "idle" ? "idle" : "running")))
        const waitingPermission = pending.filter((request) => request.sessionID === child.id).length
        const tokens = tokenTotal(child.tokens)
        const { part, at } = yield* lastActivity(child.id)
        const elapsed =
          job && job.started_at !== undefined ? duration((job.completed_at ?? now) - job.started_at) : undefined
        const attrs = [
          child.id,
          `agent=${child.agent ?? "-"}`,
          `name="${quote(job?.title ?? stripSubagentSuffix(child.title))}"`,
          `state=${state}`,
          `activity=${part ? describePart(part) : "-"}`,
          `quiet=${at === undefined ? "-" : duration(now - at)}`,
          ...(waitingPermission > 0 ? [`waiting_permission=${waitingPermission}`] : []),
          ...(tokens > 0 ? [`tokens=${tokens}`] : []),
          ...(elapsed === undefined ? [] : [`elapsed=${elapsed}`]),
        ]
        return { text: attrs.join(" "), state, waitingPermission }
      })

    const renderMemberDetail = (member: Session.Info, pending: readonly PermissionV1.Request[]) =>
      Effect.gen(function* () {
        const messages = yield* sessions
          .messages({ sessionID: member.id, limit: 20 })
          .pipe(Effect.catchCause(() => Effect.succeed([] as SessionV1.WithParts[])))
        const parts = messages.flatMap((item) => item.parts)
        const lastText = parts.findLast((part): part is SessionV1.TextPart => part.type === "text")
        const lastTool = parts.findLast((part): part is SessionV1.ToolPart => part.type === "tool")
        return [
          `<team_member id="${member.id}">`,
          ...(lastText ? [`<last_text>${truncateTail(lastText.text, MAX_LAST_TEXT)}</last_text>`] : []),
          ...pending
            .filter((request) => request.sessionID === member.id)
            .map(
              (request) =>
                `<pending_permission id="${request.id}" permission="${request.permission}" patterns="${request.patterns.join(",")}" />`,
            ),
          ...(lastTool ? [`<last_tool name="${lastTool.tool}" state="${lastTool.state.status}" />`] : []),
          `</team_member>`,
        ]
      })

    const statusOp = Effect.fn("TeamTool.status")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      let detail: Session.Info | undefined
      if (params.session_id !== undefined) {
        if (!(yield* isDescendant(params.session_id, ctx.sessionID)))
          return yield* Effect.fail(new Error("team status session_id must be a descendant of this session"))
        detail = yield* getSession(SessionID.make(params.session_id))
        if (!detail) return yield* Effect.fail(new Error(`Unknown session: ${params.session_id}`))
      }

      const children = yield* sessions.children(ctx.sessionID)
      const listed = children.slice(0, MAX_MEMBERS)
      const omitted = children.length - listed.length
      const pending = yield* permissions.list()
      const now = Date.now()
      const lines = yield* Effect.forEach(listed, (child) => renderMemberLine(child, pending, now))
      const running = lines.filter((line) => line.state === "running").length
      const waitingPermission = lines.filter((line) => line.waitingPermission > 0).length
      const output = cap(
        [
          `<team_status members="${children.length}" running="${running}" waiting_permission="${waitingPermission}"${omitted > 0 ? ` omitted="${omitted}"` : ""}>`,
          ...lines.map((line) => line.text),
          ...(detail ? yield* renderMemberDetail(detail, pending) : []),
          "</team_status>",
        ].join("\n"),
        MAX_OUTPUT_BYTES,
      )
      return {
        title: `team status (${children.length} members)`,
        metadata: { members: children.length, listed: listed.length, running, waitingPermission },
        output,
      }
    })

    const stopOne = (sessionID: SessionID) =>
      Effect.gen(function* () {
        yield* runState.cancel(sessionID)
        const job = yield* background.get(sessionID)
        if (job?.status === "running") yield* background.cancel(sessionID)
        return { id: sessionID, ok: true as const }
      }).pipe(Effect.catchCause(() => Effect.succeed({ id: sessionID, ok: false as const, reason: "stop failed" })))

    const stopOp = Effect.fn("TeamTool.stop")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const hasSession = params.session_id !== undefined
      const hasAll = params.all === true
      if (hasSession && hasAll)
        return yield* Effect.fail(new Error("team stop accepts either session_id or all, not both"))
      if (!hasSession && !hasAll) return yield* Effect.fail(new Error("team stop requires session_id or all"))

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: "team",
          patterns: [params.session_id ?? ctx.sessionID],
          always: ["*"],
          metadata: { op: params.op },
        })
      }

      if (hasAll) {
        const descendants = yield* collectDescendants(ctx.sessionID)
        const results = yield* Effect.forEach(descendants, (member) => stopOne(member.id), {
          concurrency: "unbounded",
        })
        return renderStop(results)
      }

      const target = SessionID.make(params.session_id!)
      const descendant = yield* isDescendant(params.session_id!, ctx.sessionID)
      if (!descendant) return renderStop([{ id: target, ok: false, reason: "not a descendant of this session" }])
      return renderStop([yield* stopOne(target)])
    })

    const run = Effect.fn("TeamTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.op === "status") return yield* statusOp(params, ctx)
      return yield* stopOp(params, ctx)
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.orDie,
          Effect.map((result): Tool.ExecuteResult => result),
        ),
    }
  }),
)

function renderStop(results: readonly { id: string; ok: boolean; reason?: string }[]) {
  const stopped = results.filter((result) => result.ok).length
  const failed = results.length - stopped
  return {
    title: `team stop (${stopped} stopped)`,
    metadata: { stopped, failed },
    output: [
      `<team_stop stopped="${stopped}" failed="${failed}">`,
      ...results.map((result) =>
        result.ok ? `${result.id} stopped` : `${result.id} failed reason="${result.reason ?? "unknown"}"`,
      ),
      "</team_stop>",
    ].join("\n"),
  }
}

function describePart(part: SessionV1.Part): string {
  if (part.type === "tool") return `tool:${part.tool}`
  if (part.type === "text") return "text"
  if (part.type === "reasoning") return "reasoning"
  return part.type
}

function partTime(part: SessionV1.Part): number | undefined {
  if (part.type === "text" || part.type === "reasoning") return part.time?.end ?? part.time?.start
  if (part.type === "tool") {
    if (part.state.status === "running") return part.state.time.start
    if (part.state.status === "completed" || part.state.status === "error") return part.state.time.end
    return undefined
  }
  if (part.type === "retry") return part.time.created
  return undefined
}

function messageTime(message: SessionV1.WithParts): number | undefined {
  const info = message.info
  if (info.role === "assistant") return info.time.completed ?? info.time.created
  return info.time.created
}

function tokenTotal(tokens: Session.Info["tokens"]) {
  if (!tokens) return 0
  const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  return (
    finite(tokens.input) +
    finite(tokens.output) +
    finite(tokens.reasoning) +
    finite(tokens.cache?.read) +
    finite(tokens.cache?.write)
  )
}

function duration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 60_000) return `${Math.round(value / 1000)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  return `${Math.round(value / 3_600_000)}h`
}

function stripSubagentSuffix(title: string): string {
  return title.replace(/\s*\(@[^)]* subagent\)$/, "")
}

function quote(value: string): string {
  return value.replace(/["\r\n]+/g, " ").trim()
}

function truncateTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max)
}

function cap(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const budget = maxBytes - Buffer.byteLength(TRUNCATED, "utf8")
  let slice = text.slice(0, budget)
  while (Buffer.byteLength(slice, "utf8") > budget) slice = slice.slice(0, -1)
  return slice + TRUNCATED
}
