import * as Tool from "./tool"
import DESCRIPTION from "./dispatch.txt"
import { BackgroundJob } from "@/background/job"
import { Mailbox } from "@/session/mailbox"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { createSubagentSession, resolveAutonomy, resolveSubagentVariant } from "./subagent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Provider } from "../provider/provider"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DateTime, Deferred, Effect, Fiber, Option, Ref, Schema, Scope, Semaphore } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

const id = "dispatch"
const MAX_MEMBERS = 16
const DEFAULT_CONCURRENCY = 4
const MAX_TEAM_OUTPUT_BYTES = 64 * 1024
const NOTIFICATION_RESULT_CHARS = 1400
const NOTIFICATION_MAX_BYTES = 2 * 1024
const WATCHDOG_MAX_BYTES = 512

// Keyed `${sessionID}:${completed_at}` so a member completion is injected into the
// parent at most once, even when multiple dispatches settle the same running job.
const notifiedCompletions = new Set<string>()

// PermissionV1.Request carries no creation timestamp, so the watchdog records when
// it first saw each pending ask and drops entries once the ask disappears.
const watchdogFirstSeen = new Map<string, number>()
const watchdogNotifiedAsks = new Set<string>()
// Keyed by member session; the value is the activity timestamp of the stall episode
// already notified. Newer activity re-arms the check.
const watchdogNotifiedStalls = new Map<string, number>()

const Member = Schema.Struct({
  agent: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the member's task" }),
  prompt: Schema.String.annotate({ description: "The full task for the member to perform" }),
  name: Schema.optional(Schema.String).annotate({ description: "Display name for aggregation; defaults to description" }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Resume an existing member session instead of creating a fresh one",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description:
      "Thinking intensity for this member's effective model (e.g. low, medium, high, max). Must match one of the model's variants; unknown values fail before any member starts. Omit to inherit the lead's variant when the member shares the lead's model",
  }),
  autonomy: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "External directories (absolute paths) this member may access without prompting. High-risk paths are rejected and require human approval; a path that conflicts with a deny rule is rejected before any member starts",
  }),
})

export const Parameters = Schema.Struct({
  team: Schema.optional(Schema.String).annotate({ description: "Name of a configured team roster to dispatch" }),
  tasks: Schema.optional(Schema.Array(Member)).annotate({
    description: "Members to dispatch in parallel (1..16). When both team and tasks are given, tasks override the roster.",
  }),
  mode: Schema.optional(Schema.Literals(["join", "background"])).annotate({
    description:
      "join (default) waits for every member and returns aggregated results; background returns immediately and notifies the parent as members finish",
  }),
  concurrency: Schema.optional(Schema.Number).annotate({
    description: "Max members running at once (default 4, clamped 1..16)",
  }),
  aggregate: Schema.optional(Schema.Literals(["concat", "none"])).annotate({
    description: "How member results are aggregated in the tool output (default concat)",
  }),
  budget_tokens: Schema.optional(Schema.Number).annotate({
    description:
      "Stop launching/continuing members once combined member token usage exceeds this budget. The final result reports total usage",
  }),
})

type MemberInput = Schema.Schema.Type<typeof Member>
type TeamMemberConfig = {
  agent: string
  role?: string
  description?: string
  prompt?: string
  variant?: string
  autonomy?: readonly string[]
}

type ResolvedMember = {
  agent: string
  description: string
  prompt: string
  name: string
  role?: string
  task_id?: string
  variant?: string
  autonomy?: readonly string[]
}

type MemberRuntime = {
  sessionID: SessionID
  agent: string
  name: string
  state: "running" | "completed" | "error" | "cancelled"
  text: string
  error?: string
  variant?: string
  autonomy?: string[]
  tokens?: number
  elapsedMs?: number
}

function renderMemberPrompt(input: { role?: string; prompt: string }) {
  return [
    input.role ? `[role: ${input.role}]` : undefined,
    "Shared team blackboard available via the `blackboard` tool; the lead references keys in your task.",
    input.prompt,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export const DispatchTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const mailbox = yield* Mailbox.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const provider = yield* Provider.Service
    const permissions = yield* Permission.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("DispatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const teamName = params.team
      const teamConfig = teamName ? cfg.team?.[teamName] : undefined
      if (teamName && !teamConfig) return yield* Effect.fail(new Error(`Unknown team: ${teamName}`))
      const resolved = resolveMembers(params, teamConfig)
      if (resolved.length === 0) return yield* Effect.fail(new Error("dispatch requires at least one member"))
      if (resolved.length > MAX_MEMBERS)
        return yield* Effect.fail(new Error(`dispatch accepts at most ${MAX_MEMBERS} members`))

      const parent = yield* sessions.get(ctx.sessionID)
      let depth = 0
      let current = parent
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [teamName ?? "*"],
          always: ["*"],
          metadata: { team: teamName, members: resolved.map((member) => member.agent) },
        })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const messageModel = { modelID: msg.info.modelID, providerID: msg.info.providerID }
      const parentVariant = msg.info.variant

      const members: { input: ResolvedMember; info: Agent.Info; session: Session.Info }[] = []
      for (const member of resolved) {
        const info = yield* agent.get(member.agent)
        if (!info) return yield* Effect.fail(new Error(`Unknown agent type: ${member.agent} is not a valid agent type`))
        if (info.mode === "primary")
          return yield* Effect.fail(new Error(`Agent ${member.agent} is a primary agent and cannot be dispatched`))
        if (member.variant) {
          const model = info.model ?? messageModel
          yield* resolveSubagentVariant({
            provider,
            providerID: model.providerID,
            modelID: model.modelID,
            variant: member.variant,
          })
        }
        const autonomy = member.autonomy?.length
          ? yield* resolveAutonomy({
              directories: member.autonomy,
              rulesets: [
                info.permission,
                deriveSubagentSessionPermission({ parentSessionPermission: parent.permission ?? [], subagent: info }),
              ],
            })
          : undefined
        const existing = member.task_id
          ? yield* sessions
              .get(SessionID.make(member.task_id))
              .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
        if (member.task_id && !existing)
          return yield* Effect.fail(new Error(`Unknown task_id: ${member.task_id} is not a known session`))
        const session = yield* createSubagentSession({
          sessions,
          parent,
          subagent: info,
          description: member.description,
          primaryTools: cfg.experimental?.primary_tools,
          existing,
          autonomy,
        })
        members.push({ input: member, info, session })
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("DispatchTool requires promptOps in ctx.extra"))

      const runtime = yield* Ref.make<MemberRuntime[]>(
        members.map((member) => ({
          sessionID: member.session.id,
          agent: member.info.name,
          name: member.input.name,
          state: "running" as const,
          text: "",
          ...(member.input.variant === undefined ? {} : { variant: member.input.variant }),
          ...(member.input.autonomy?.length ? { autonomy: [...member.input.autonomy] } : {}),
        })),
      )
      const spent = yield* Ref.make(0)
      const budgetHit = yield* Ref.make(false)
      const budget = params.budget_tokens

      const teamLabel = teamName ?? "dispatch"
      const aggregate = params.aggregate ?? teamConfig?.aggregate ?? "concat"
      const mode = params.mode ?? "join"
      const concurrency = clamp(params.concurrency ?? teamConfig?.max_parallel ?? DEFAULT_CONCURRENCY, 1, MAX_MEMBERS)
      // Actually cap how many members run at once; without this every member
      // starts immediately and `concurrency` would only bound settle waiting.
      const permits = Semaphore.makeUnsafe(concurrency)

      const writeMetadata = Effect.fn("DispatchTool.writeMetadata")(function* () {
        const states = yield* Ref.get(runtime)
        yield* ctx.metadata({
          title: teamLabel,
          metadata: {
            team: teamName,
            parentSessionId: ctx.sessionID,
            members: states.map((state) => ({
              sessionId: state.sessionID,
              agent: state.agent,
              name: state.name,
              state: state.state,
              ...(state.variant === undefined ? {} : { variant: state.variant }),
              ...(state.autonomy === undefined ? {} : { autonomy: state.autonomy }),
              ...(state.tokens === undefined ? {} : { tokens: state.tokens }),
              ...(state.elapsedMs === undefined ? {} : { elapsedMs: state.elapsedMs }),
            })),
          },
        })
      })

      yield* writeMetadata()
      const startedAt = yield* DateTime.now
      yield* events.publish(SessionEvent.Team.Started, {
        timestamp: startedAt,
        sessionID: ctx.sessionID,
        parentSessionID: ctx.sessionID,
        team: teamLabel,
        members: members.map((member) => ({
          sessionID: member.session.id,
          agent: member.info.name,
          name: member.input.name,
        })),
      })

      const runMember = Effect.fn("DispatchTool.runMember")(function* (index: number) {
        const entry = members[index]!
        const model = entry.info.model ?? messageModel
        const parts = yield* ops.resolvePromptParts(
          renderMemberPrompt({ role: entry.input.role, prompt: entry.input.prompt }),
        )
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: entry.session.id,
          model: { modelID: model.modelID, providerID: model.providerID },
          variant:
            entry.input.variant === "default"
              ? undefined
              : (entry.input.variant ?? (entry.info.model ? undefined : parentVariant)),
          agent: entry.info.name,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Member failed (task_id: ${entry.session.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error")
          return yield* Effect.fail(new Error(`Member failed (task_id: ${entry.session.id}): ${failed.state.error}`))
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const recordMember = (
        index: number,
        state: MemberRuntime["state"],
        text: string,
        error?: string,
        stats?: { tokens?: number; elapsedMs?: number; variant?: string },
      ) =>
        Effect.gen(function* () {
          yield* Ref.update(runtime, (list) =>
            list.map((item, i) =>
              i === index
                ? { ...item, state, text, ...(error === undefined ? {} : { error }), ...(stats ?? {}) }
                : item,
            ),
          )
          // The tool call may already be over (detached members settle later), so
          // streaming metadata updates can fail; the event below must still ship.
          yield* writeMetadata().pipe(Effect.catchCause(() => Effect.void))
          yield* events.publish(SessionEvent.Team.MemberEnded, {
            timestamp: yield* DateTime.now,
            sessionID: members[index]!.session.id,
            parentSessionID: ctx.sessionID,
            agent: members[index]!.info.name,
            state: state === "running" ? "completed" : state,
            ...(error === undefined ? {} : { error }),
          })
        })

      for (const [index, entry] of members.entries()) {
        const run = permits
          .withPermits(1)(runMember(index))
          .pipe(Effect.onInterrupt(() => ops.cancel(entry.session.id)))
        // A resumed member (`task_id`) may still be running; append the new
        // prompt after its current turn instead of dropping it (plain
        // `background.start` returns the running job without running the work).
        if (yield* background.extend({ id: entry.session.id, run })) continue
        yield* background.start({
          id: entry.session.id,
          type: id,
          title: entry.input.description,
          metadata: { parentSessionId: ctx.sessionID, sessionId: entry.session.id },
          run,
        })
      }

      // Completion and watchdog signals use two channels: a durable mailbox row
      // (status queued until the resume prompt is admitted) and an async enqueue
      // into the parent session. The fork lives in the tool scope so it survives
      // the dispatch tool call ending; a failed enqueue leaves the row queued for
      // the next drain.
      const notifyParent = Effect.fn("DispatchTool.notifyParent")(function* (
        text: string,
        member: { sessionID: SessionID; agent: string },
      ) {
        const messageID = MessageID.ascending()
        yield* mailbox.record({
          id: messageID,
          fromSessionID: member.sessionID,
          fromAgent: member.agent,
          toSessionID: ctx.sessionID,
          kind: "note",
          body: text,
          hop: 0,
          status: "queued",
        })
        yield* Effect.gen(function* () {
          const currentParent = yield* sessions.get(ctx.sessionID)
          yield* ops.enqueue({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant: parentVariant,
            parts: [{ type: "text", synthetic: true, text }],
          })
          yield* mailbox.mark(messageID, "delivered")
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("dispatch: failed to enqueue parent notification; mailbox row left queued", {
              error: String(cause),
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const notifyCompletion = Effect.fn("DispatchTool.notifyCompletion")(function* (input: {
        index: number
        state: "completed" | "error"
        completedAt: number | undefined
        text: string
        tokens?: number
        elapsedMs?: number
      }) {
        if (input.completedAt === undefined) return
        const entry = members[input.index]!
        const key = `${entry.session.id}:${input.completedAt}`
        const fresh = yield* Effect.sync(() => {
          if (notifiedCompletions.has(key)) return false
          notifiedCompletions.add(key)
          return true
        })
        if (!fresh) return
        yield* notifyParent(
          renderTeamUpdate({
            team: teamLabel,
            member: entry.session.id,
            agent: entry.info.name,
            name: entry.input.name,
            state: input.state,
            ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
            ...(input.elapsedMs === undefined ? {} : { elapsed: formatElapsed(input.elapsedMs) }),
            text: input.text,
          }),
          { sessionID: entry.session.id, agent: entry.info.name },
        )
      })

      const runWatchdog = Effect.fn("DispatchTool.watchdog")(function* () {
        type WatchMember = { member: (typeof members)[number]; job: BackgroundJob.Info }

        const checkMember = Effect.fn("DispatchTool.watchdogMember")(function* (
          entry: WatchMember,
          pending: readonly PermissionV1.Request[],
          now: number,
        ) {
          const sessionID = entry.member.session.id
          // list() preserves ask insertion order, so the first match is the oldest ask.
          const waiting = pending.find((request) => request.sessionID === sessionID)
          if (waiting) {
            // While a member is blocked on a permission ask, report that state only;
            // a stalled notice would duplicate the same signal.
            if (!watchdogFirstSeen.has(waiting.id)) watchdogFirstSeen.set(waiting.id, now)
            const firstSeen = watchdogFirstSeen.get(waiting.id) ?? now
            if (now - firstSeen <= flags.teamWatchdogPermissionMs) return
            if (watchdogNotifiedAsks.has(waiting.id)) return
            watchdogNotifiedAsks.add(waiting.id)
            yield* notifyParent(
              renderWatchdog({
                member: sessionID,
                agent: entry.member.info.name,
                state: "waiting_permission",
                detail: `ask="${waiting.id}" permission="${waiting.permission}" patterns="${waiting.patterns.join(",")}" waiting="${formatElapsed(now - firstSeen)}"`,
                advice:
                  'Approve or reject the pending permission, or stop the member with the team tool (op: "stop").',
              }),
              { sessionID, agent: entry.member.info.name },
            )
            return
          }

          const messages = yield* sessions
            .messages({ sessionID, limit: 1 })
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (!messages) return
          const message = messages.at(-1)
          const part = message?.parts.at(-1)
          const at = Math.max(
            part ? (partTime(part) ?? 0) : 0,
            message ? (messageTime(message) ?? 0) : 0,
            // A member that has not written any part yet is quiet since its job started.
            entry.job.started_at,
          )
          const notifiedAt = watchdogNotifiedStalls.get(sessionID)
          if (notifiedAt !== undefined && at <= notifiedAt) return
          if (now - at <= flags.teamWatchdogInactiveMs) return
          watchdogNotifiedStalls.set(sessionID, at)
          yield* notifyParent(
            renderWatchdog({
              member: sessionID,
              agent: entry.member.info.name,
              state: "stalled",
              detail: `quiet="${formatElapsed(now - at)}" last_activity="${part ? describePart(part) : "-"}"`,
              advice:
                'Member has produced no activity for a while. Check with team status, then stop it (op: "stop") or send guidance via agent_send.',
            }),
            { sessionID, agent: entry.member.info.name },
          )
        })

        while (true) {
          const running = (
            yield* Effect.forEach(members, (member) =>
              background
                .get(member.session.id)
                .pipe(
                  Effect.catchCause(() => Effect.succeed(undefined)),
                  Effect.map((job): WatchMember | undefined =>
                    job?.status === "running" ? { member, job } : undefined,
                  ),
                ),
            )
          ).filter((entry): entry is WatchMember => entry !== undefined)
          if (running.length === 0) return
          const pending = yield* permissions.list().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          // Prune only on a successful listing; a failed query must not forget
          // first-seen times for asks that are still waiting.
          if (pending) {
            const active = new Set<string>(pending.map((request) => request.id))
            for (const ask of watchdogFirstSeen.keys()) if (!active.has(ask)) watchdogFirstSeen.delete(ask)
          }
          yield* Effect.forEach(running, (entry) => checkMember(entry, pending ?? [], now), { discard: true })
          yield* Effect.sleep(`${flags.teamWatchdogIntervalMs} millis`)
        }
      })

      const cancelAll = Effect.all(
        members.flatMap((entry) => [ops.cancel(entry.session.id), background.cancel(entry.session.id)]),
        { discard: true },
      )

      const publishEnded = Effect.fn("DispatchTool.publishEnded")(function* (states: MemberRuntime[]) {
        const state = states.every((member) => member.state === "completed") ? "completed" : "partial"
        yield* events.publish(SessionEvent.Team.Ended, {
          timestamp: yield* DateTime.now,
          sessionID: ctx.sessionID,
          parentSessionID: ctx.sessionID,
          team: teamLabel,
          state,
        })
        return state
      })

      const renderMember = (member: MemberRuntime) => {
        const body =
          member.state === "completed"
            ? `<task_result>\n${aggregate === "none" ? "(aggregated results omitted)" : member.text}\n</task_result>`
            : member.state === "running"
              ? "<task_result>\n(running)\n</task_result>"
              : `<task_error>\n${member.error ?? "Member failed"}\n</task_error>`
        return [
          `<member id="${member.sessionID}" agent="${member.agent}" name="${member.name}" state="${member.state}">`,
          body,
          "</member>",
        ].join("\n")
      }

      const renderTeam = (states: MemberRuntime[], state: string, tokens: number) => {
        const text = [
          `<team name="${teamLabel}" state="${state}" tokens="${tokens}">`,
          ...states.map(renderMember),
          "</team>",
        ].join("\n")
        return text.length > MAX_TEAM_OUTPUT_BYTES ? text.slice(0, MAX_TEAM_OUTPUT_BYTES) + "\n<!-- truncated -->" : text
      }

      // Detached means the dispatch call stopped waiting (tool interruption or
      // ctx.abort). Members keep running; their late completions still notify the
      // parent because the watchers below read this flag.
      const detached = yield* Ref.make(false)
      const waiters = yield* Effect.forEach(members, () => Deferred.make<void>())

      const settleMember = Effect.fn("DispatchTool.settleMember")(function* (index: number) {
        const entry = members[index]!
        const info = (yield* background.wait({ id: entry.session.id })).info
        const session = yield* sessions
          .get(entry.session.id)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const tokens = tokenTotal(session?.tokens)
        const elapsedMs =
          info && info.completed_at !== undefined ? Math.max(0, info.completed_at - info.started_at) : undefined
        // Report the variant the member actually ran with, read back from its
        // first persisted prompt, falling back to what dispatch forwarded.
        const applied = yield* sessions
          .findMessage(entry.session.id, (m) => m.info.role === "user" && !!m.info.model)
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<SessionV1.WithParts>())))
        const declaredVariant = entry.input.variant === "default" ? undefined : entry.input.variant
        const variant =
          (Option.isSome(applied) && applied.value.info.role === "user" ? applied.value.info.model.variant : undefined) ??
          declaredVariant ??
          (entry.info.model ? undefined : parentVariant)
        const stats = {
          ...(tokens > 0 ? { tokens } : {}),
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
          ...(variant === undefined ? {} : { variant }),
        }
        if (info?.status === "error") {
          yield* recordMember(index, "error", "", info.error ?? "Member failed", stats)
        } else if (info?.status === "cancelled") {
          yield* recordMember(index, "cancelled", "", "Member cancelled", stats)
        } else {
          yield* recordMember(index, "completed", info?.output ?? "", undefined, stats)
        }
        if (info && (info.status === "completed" || info.status === "error")) {
          if (mode === "background" || (yield* Ref.get(detached))) {
            yield* notifyCompletion({
              index,
              state: info.status,
              completedAt: info.completed_at,
              text: info.status === "error" ? (info.error ?? "Member failed") : (info.output ?? ""),
              ...(stats.tokens === undefined ? {} : { tokens: stats.tokens }),
              ...(elapsedMs === undefined ? {} : { elapsedMs }),
            })
          }
        }
        if (tokens <= 0) return
        const total = yield* Ref.updateAndGet(spent, (value) => value + tokens)
        if (budget === undefined || total <= budget) return
        if (yield* Ref.get(budgetHit)) return
        yield* Ref.set(budgetHit, true)
        yield* cancelAll
      })

      // One settle watcher per member regardless of mode, forked into the tool
      // scope so it survives the dispatch call. Join waits on the deferreds via
      // the coordinator; background returns immediately and lets them run.
      yield* Effect.forEach(
        members.map((_, index) => index),
        (index) =>
          settleMember(index).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("dispatch: member watcher failed", { error: String(cause) }),
            ),
            Effect.ensuring(Deferred.succeed(waiters[index]!, undefined)),
            Effect.forkIn(scope, { startImmediately: true }),
          ),
        { discard: true },
      )

      // Publish Team.Ended exactly once per dispatch, after every member watcher
      // settles. Detached runs publish when their members finally stop.
      const ended = yield* Effect.gen(function* () {
        yield* Effect.forEach(waiters, (waiter) => Deferred.await(waiter), { discard: true })
        const states = yield* Ref.get(runtime)
        return yield* publishEnded(states)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("dispatch: team coordinator failed", { error: String(cause) }).pipe(
            Effect.map(() => "partial" as const),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      if (mode === "background") {
        yield* runWatchdog().pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        const states = yield* Ref.get(runtime)
        return {
          title: `${teamLabel} (${members.length} members)`,
          metadata: { team: teamName, parentSessionId: ctx.sessionID, members: states, tokens: 0 },
          output: renderTeam(states, "running", 0),
        }
      }

      // Interrupting the tool or aborting it stops waiting only; members keep
      // running detached. `cancelAll` is reserved for the token budget and for
      // the team tool's explicit stop.
      const waitForDetach = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) {
          resume(Effect.void)
          return
        }
        const onAbort = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", onAbort)
        return Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))
      })

      const outcome = yield* Effect.raceFirst(
        Fiber.join(ended).pipe(Effect.map((state) => ({ settled: true as const, state }))),
        waitForDetach.pipe(Effect.map(() => ({ settled: false as const }))),
      ).pipe(Effect.onInterrupt(() => Ref.set(detached, true)))

      if (!outcome.settled) yield* Ref.set(detached, true)
      const states = yield* Ref.get(runtime)
      const tokens = yield* Ref.get(spent)
      const state = outcome.settled
        ? outcome.state
        : states.every((member) => member.state === "completed")
          ? "completed"
          : "partial"
      return {
        title: `${teamLabel} (${members.length} members)`,
        metadata: { team: teamName, parentSessionId: ctx.sessionID, members: states, tokens },
        output: renderTeam(states, state, tokens),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function resolveMembers(
  params: Schema.Schema.Type<typeof Parameters>,
  team: { members: readonly TeamMemberConfig[] } | undefined,
): ResolvedMember[] {
  if (params.tasks && params.tasks.length > 0) return params.tasks.map(normaliseMember)
  if (team) {
    return team.members.map((member) => {
      const description = member.description ?? member.role ?? member.agent
      return {
        agent: member.agent,
        description,
        prompt: member.prompt ?? member.role ?? `Assist the team as ${member.agent}.`,
        name: description,
        role: member.role,
        ...(member.variant === undefined ? {} : { variant: member.variant }),
        ...(member.autonomy === undefined ? {} : { autonomy: member.autonomy }),
      }
    })
  }
  return []
}

function normaliseMember(task: MemberInput): ResolvedMember {
  return {
    agent: task.agent,
    description: task.description,
    prompt: task.prompt,
    name: task.name ?? task.description,
    ...(task.task_id === undefined ? {} : { task_id: task.task_id }),
    ...(task.variant === undefined ? {} : { variant: task.variant }),
    ...(task.autonomy === undefined ? {} : { autonomy: task.autonomy }),
  }
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

function formatElapsed(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

function clampTail(text: string, maxChars: number, maxBytes: number) {
  const tail = text.length > maxChars ? text.slice(text.length - maxChars) : text
  if (Buffer.byteLength(tail, "utf8") <= maxBytes) return tail
  let slice = tail
  while (slice.length > 0 && Buffer.byteLength(slice, "utf8") > maxBytes) slice = slice.slice(1)
  return slice
}

function renderTeamUpdate(input: {
  team: string
  member: string
  agent: string
  name: string
  state: "completed" | "error"
  tokens?: number
  elapsed?: string
  text: string
}) {
  const tag = input.state === "error" ? "error" : "result"
  const attrs = [
    `team="${input.team}"`,
    `member="${input.member}"`,
    `agent="${input.agent}"`,
    `name="${input.name}"`,
    `state="${input.state}"`,
    ...(input.tokens === undefined ? [] : [`tokens="${input.tokens}"`]),
    ...(input.elapsed === undefined ? [] : [`elapsed="${input.elapsed}"`]),
  ].join(" ")
  const open = `<team_update ${attrs}>`
  const close = `</team_update>`
  const wrapper = `${open}\n<${tag}></${tag}>\n${close}`
  const budget = Math.max(0, NOTIFICATION_MAX_BYTES - Buffer.byteLength(wrapper, "utf8"))
  const body = clampTail(input.text, NOTIFICATION_RESULT_CHARS, budget)
  return `${open}\n<${tag}>${body}</${tag}>\n${close}`
}

function renderWatchdog(input: {
  member: string
  agent: string
  state: "waiting_permission" | "stalled"
  detail: string
  advice: string
}) {
  const text = [
    `<team_watchdog member="${input.member}" agent="${input.agent}" state="${input.state}" ${input.detail}>`,
    input.advice,
    "</team_watchdog>",
  ].join("\n")
  if (Buffer.byteLength(text, "utf8") <= WATCHDOG_MAX_BYTES) return text
  let slice = text
  while (slice.length > 0 && Buffer.byteLength(slice, "utf8") > WATCHDOG_MAX_BYTES) slice = slice.slice(0, -1)
  return slice
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
