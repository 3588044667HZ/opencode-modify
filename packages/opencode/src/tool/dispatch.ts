import * as Tool from "./tool"
import DESCRIPTION from "./dispatch.txt"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { createSubagentSession, resolveAutonomy, resolveSubagentVariant } from "./subagent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Provider } from "../provider/provider"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { DateTime, Effect, Exit, Option, Ref, Schema, Scope, Semaphore } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const id = "dispatch"
const MAX_MEMBERS = 16
const DEFAULT_CONCURRENCY = 4
const MAX_TEAM_OUTPUT_BYTES = 64 * 1024

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
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const provider = yield* Provider.Service

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
          yield* writeMetadata()
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

      const settle = Effect.fn("DispatchTool.settleMember")(function* (index: number) {
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
        if (tokens <= 0) return
        const total = yield* Ref.updateAndGet(spent, (value) => value + tokens)
        if (budget === undefined || total <= budget) return
        if (yield* Ref.get(budgetHit)) return
        yield* Ref.set(budgetHit, true)
        yield* cancelAll
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

      if (mode === "background") {
        yield* Effect.forEach(members.map((_, index) => index), (index) => settle(index), { concurrency }).pipe(
          Effect.andThen(Ref.get(runtime).pipe(Effect.flatMap((states) => publishEnded(states)))),
          Effect.ignore,
          Effect.forkIn(scope, { startImmediately: true }),
        )
        const states = yield* Ref.get(runtime)
        return {
          title: `${teamLabel} (${members.length} members)`,
          metadata: { team: teamName, parentSessionId: ctx.sessionID, members: states },
          output: renderTeam(states, "running", 0),
        }
      }

      const runCancel = yield* EffectBridge.make()

      const onAbort = () => runCancel.fork(cancelAll)

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => ctx.abort.addEventListener("abort", onAbort)),
        () =>
          Effect.gen(function* () {
            yield* Effect.forEach(members.map((_, index) => index), (index) => settle(index), {
              concurrency,
              discard: true,
            })
            const states = yield* Ref.get(runtime)
            const tokens = yield* Ref.get(spent)
            const state = yield* publishEnded(states)
            return {
              title: `${teamLabel} (${members.length} members)`,
              metadata: { team: teamName, parentSessionId: ctx.sessionID, members: states, tokens },
              output: renderTeam(states, state, tokens),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancelAll
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
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
