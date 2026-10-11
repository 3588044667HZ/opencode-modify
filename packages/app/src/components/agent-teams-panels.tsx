import { Component, For, Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { createSessionEventRefresh } from "@/components/session-event-refresh"
import { createPanelPoll } from "@/components/panel-poll"
import { formatElapsedTime } from "@/utils/time"

export const BlackboardPanel: Component<{ sessionID: string }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()
  const [entries, { refetch }] = createResource(
    () => props.sessionID,
    (sessionID) => sdk().client.session.blackboard({ sessionID }).then((result) => result.data ?? []),
  )
  // Polling returns freshly parsed objects every tick. Reconcile keyed rows so
  // unchanged entries keep their DOM (and inner scroll position) instead of the
  // whole list being torn down on each refresh.
  const [board, setBoard] = createStore<{ rows: NonNullable<ReturnType<typeof entries>> }>({ rows: [] })
  createEffect(() => {
    if (entries.error) return
    const data = entries()
    if (!data) return
    setBoard("rows", reconcile(data, { key: "key" }))
  })
  createSessionEventRefresh(["session.next.blackboard.changed"], () => void refetch())
  createPanelPoll(() => void refetch())

  return (
    <div class="flex flex-col gap-3">
      <Show
        when={board.rows.length}
        fallback={
          <div class="text-13-regular text-text-weak py-8 text-center">{language.t("dialog.blackboard.empty")}</div>
        }
      >
        <For each={board.rows}>
          {(entry) => (
            <div class="flex flex-col gap-1 rounded-md border border-border-weak-base p-3">
              <div class="flex items-center justify-between gap-2">
                <span class="text-13-medium truncate">{entry.key}</span>
                <span class="text-11-regular text-text-weaker">
                  {language.t("dialog.blackboard.version", { version: entry.version })}
                </span>
              </div>
              <pre class="text-12-regular whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{entry.value}</pre>
              <Show when={entry.authorAgent ?? entry.authorSessionID}>
                <span class="text-11-regular text-text-weaker truncate">{entry.authorAgent ?? entry.authorSessionID}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

export const PeerInboxPanel: Component<{ sessionID: string }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()
  const [messages, { refetch }] = createResource(
    () => props.sessionID,
    (sessionID) => sdk().client.session.inbox({ sessionID }).then((result) => result.data ?? []),
  )
  // Same reconcile-by-key contract as the blackboard: peer messages are keyed
  // by message id so polling does not rebuild the whole list.
  const [inbox, setInbox] = createStore<{ rows: NonNullable<ReturnType<typeof messages>> }>({ rows: [] })
  createEffect(() => {
    if (messages.error) return
    const data = messages()
    if (!data) return
    setInbox("rows", reconcile(data, { key: "id" }))
  })
  createSessionEventRefresh(["session.next.agent.message.sent"], () => void refetch())
  createPanelPoll(() => void refetch())

  return (
    <div class="flex flex-col gap-3">
      <Show
        when={inbox.rows.length}
        fallback={
          <div class="text-13-regular text-text-weak py-8 text-center">{language.t("dialog.peerInbox.empty")}</div>
        }
      >
        <For each={inbox.rows}>
          {(message) => (
            <div class="flex flex-col gap-1 rounded-md border border-border-weak-base p-3">
              <div class="flex items-center justify-between gap-2">
                <span class="text-12-medium truncate">
                  {language.t("dialog.peerInbox.from", { agent: message.fromAgent ?? message.fromSessionID })}
                </span>
                <span class="text-11-regular text-text-weaker">
                  {message.kind} · #{message.hop}
                </span>
              </div>
              <pre class="text-12-regular whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{message.body}</pre>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

type MemberState = "running" | "idle" | "completed" | "error" | "cancelled"
type MemberActivity = { kind: "thinking" | "responding" | "working" | "tool"; tool?: string }
type MemberLive = { state: MemberState; activity?: MemberActivity; note?: string }
type DispatchMember = { state: MemberState; result?: string; tokens?: number; elapsedMs?: number; variant?: string }
type TeamMemberRow = {
  sessionID: string
  title: string
  agent?: string
  state: MemberState
  activity?: MemberActivity
  detail?: string
  tokens?: number
  elapsedMs?: number
  variant?: string
}

const memberStates = ["running", "idle", "completed", "error", "cancelled"] as const

function isMemberState(value: unknown): value is MemberState {
  return typeof value === "string" && (memberStates as readonly string[]).includes(value)
}

function activityFromParts(
  parts: readonly { type: string; tool?: string; state?: { status?: string } }[],
): MemberActivity | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type === "tool") {
      if (part.state?.status === "running" || part.state?.status === "pending")
        return { kind: "tool", tool: part.tool }
      return { kind: "working" }
    }
    if (part.type === "reasoning") return { kind: "thinking" }
    if (part.type === "text") return { kind: "responding" }
  }
  return undefined
}

function activityFromMessages(
  messages: readonly { info: { role: string }; parts: readonly { type: string; tool?: string; state?: { status?: string } }[] }[],
): MemberActivity | undefined {
  // The newest assistant message may exist before any part is persisted, so
  // fall back through recent assistant messages.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.info.role !== "assistant") continue
    const activity = activityFromParts(message.parts)
    if (activity) return activity
  }
  return undefined
}

const stateDot: Record<MemberState, string> = {
  running: "bg-icon-warning-base animate-pulse",
  idle: "bg-icon-weak-base",
  completed: "bg-icon-success-base",
  error: "bg-icon-critical-base",
  cancelled: "bg-icon-weak-base",
}

const stateKeys: Record<MemberState, `agentTeams.state.${MemberState}`> = {
  running: "agentTeams.state.running",
  idle: "agentTeams.state.idle",
  completed: "agentTeams.state.completed",
  error: "agentTeams.state.error",
  cancelled: "agentTeams.state.cancelled",
}

/**
 * Reads the live member states the dispatch tool writes into its own tool-part
 * metadata. This survives panel remounts, unlike in-memory event state. The
 * parent conversation can grow past a single message page, so walk backwards
 * through recent pages until the history ends (bounded to keep payloads small).
 */
const DISPATCH_SCAN_PAGES = 4
const DISPATCH_SCAN_PAGE_SIZE = 20

function collectDispatchStatesInto(
  found: Map<string, DispatchMember>,
  messages: readonly { parts: readonly { type: string; tool?: string; state?: unknown }[] }[],
) {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "dispatch") continue
      if (!part.state || typeof part.state !== "object") continue
      const metadata = (part.state as { metadata?: unknown }).metadata
      if (!metadata || typeof metadata !== "object") continue
      const members = (metadata as { members?: unknown }).members
      if (!Array.isArray(members)) continue
      for (const member of members) {
        if (!member || typeof member !== "object") continue
        const record = member as {
          sessionID?: unknown
          sessionId?: unknown
          state?: unknown
          text?: unknown
          tokens?: unknown
          elapsedMs?: unknown
          variant?: unknown
        }
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : record.sessionId
        if (typeof sessionID !== "string" || !isMemberState(record.state)) continue
        found.set(sessionID, {
          state: record.state,
          result: typeof record.text === "string" && record.text.trim() ? record.text : undefined,
          ...(typeof record.tokens === "number" && Number.isFinite(record.tokens) && record.tokens > 0
            ? { tokens: record.tokens }
            : {}),
          ...(typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0
            ? { elapsedMs: record.elapsedMs }
            : {}),
          ...(typeof record.variant === "string" && record.variant ? { variant: record.variant } : {}),
        })
      }
    }
  }
}

export const TeamPanel: Component<{ sessionID: string; onOpen?: (sessionID: string) => void }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()
  const [children, { refetch }] = createResource(
    () => props.sessionID,
    (sessionID) => sdk().client.session.children({ sessionID }).then((result) => result.data ?? []),
  )
  // Directory-wide status map is the fallback for members the panel has not
  // seen any team events for (plain task subagents, remounted panels).
  const [statuses, { refetch: refetchStatuses }] = createResource(() =>
    sdk()
      .client.session.status()
      .then((result) => result.data ?? {}),
  )
  const [dispatched, { refetch: refetchDispatched }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const found = new Map<string, DispatchMember>()
      const client = sdk().client
      let before: string | undefined
      for (let page = 0; page < DISPATCH_SCAN_PAGES; page++) {
        const result = await client.session.messages({
          sessionID,
          limit: DISPATCH_SCAN_PAGE_SIZE,
          ...(before ? { before } : {}),
        })
        collectDispatchStatesInto(found, result.data ?? [])
        const next = result.response?.headers.get("x-next-cursor") ?? undefined
        if (!next || next === before) break
        before = next
      }
      return found
    },
  )
  const [live, setLive] = createStore<Record<string, MemberLive>>({})
  const [activity, setActivity] = createStore<Record<string, MemberActivity>>({})
  let activityPending = false

  // Live events are unreliable across protocol generations, so running members
  // are polled for their latest message part to show what they are doing now.
  const refreshActivity = async () => {
    if (activityPending) return
    activityPending = true
    try {
      const running = (children() ?? []).filter((child) => {
        const status = statuses()?.[child.id]
        return status?.type === "busy" || status?.type === "retry"
      })
      await Promise.all(
        running.map(async (child) => {
          const result = await sdk().client.session.messages({ sessionID: child.id, limit: 3 })
          const next = activityFromMessages(result.data ?? [])
          if (next) setActivity(child.id, next)
        }),
      )
    } catch {
      // Polling is best-effort; the next tick retries.
    } finally {
      activityPending = false
    }
  }

  createSessionEventRefresh(
    ["session.next.team.started", "session.next.team.member.ended", "session.next.team.ended"],
    () => {
      void refetch()
      void refetchStatuses()
      void refetchDispatched()
    },
  )

  let polls = 0
  createPanelPoll(() => {
    polls += 1
    void refetch()
    void refetchStatuses()
    if (polls % 2 === 0) void refetchDispatched()
    void refreshActivity()
  })

  const stop = sdk().event.listen((event) => {
    const record = event as unknown as { type?: string; properties?: Record<string, unknown> }
    const data = record.properties
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
    if (!record.type || !sessionID) return
    if (!(children() ?? []).some((child) => child.id === sessionID)) return
    switch (record.type) {
      case "session.next.team.member.ended": {
        const state = data?.state
        if (!isMemberState(state)) return
        setLive(sessionID, {
          state,
          activity: undefined,
          note: typeof data?.error === "string" ? data.error : undefined,
        })
        return
      }
      case "session.next.step.started":
      case "session.next.reasoning.started":
        setLive(sessionID, { state: "running", activity: { kind: "thinking" }, note: undefined })
        return
      case "session.next.text.started":
        setLive(sessionID, { state: "running", activity: { kind: "responding" }, note: undefined })
        return
      case "session.next.tool.called": {
        const tool = typeof data?.tool === "string" ? data.tool : undefined
        setLive(sessionID, { state: "running", activity: { kind: "tool", tool }, note: undefined })
        return
      }
    }
  })
  onCleanup(stop)

  const members = createMemo<TeamMemberRow[]>(() => {
    const dispatchStates = dispatched()
    const statusMap = statuses() ?? {}
    return (children() ?? []).map((child) => {
      const current = live[child.id]
      const dispatchedMember = dispatchStates?.get(child.id)
      const fromStatus = statusMap[child.id]
      // Session status is the live source of running-ness; dispatch metadata
      // contributes durable terminal states and completed result summaries.
      // A dispatch part left at "running" after the member ended (background
      // mode before the settle write fix) must not pin the row to Running.
      const state: MemberState =
        current?.state ??
        (fromStatus?.type === "busy" || fromStatus?.type === "retry"
          ? "running"
          : dispatchedMember?.state && dispatchedMember.state !== "running"
            ? dispatchedMember.state
            : "idle")
      const activityEntry = state === "running" ? (current?.activity ?? activity[child.id]) : undefined
      const detail = current?.note ?? dispatchedMember?.result
      return {
        sessionID: child.id,
        title: child.title,
        ...(child.agent === undefined ? {} : { agent: child.agent }),
        state,
        ...(activityEntry === undefined ? {} : { activity: activityEntry }),
        ...(detail === undefined ? {} : { detail }),
        ...(dispatchedMember?.tokens === undefined ? {} : { tokens: dispatchedMember.tokens }),
        ...(dispatchedMember?.elapsedMs === undefined ? {} : { elapsedMs: dispatchedMember.elapsedMs }),
        ...(dispatchedMember?.variant === undefined ? {} : { variant: dispatchedMember.variant }),
      }
    })
  })

  // Rows are rebuilt from polled resources; reconcile keyed by session keeps the
  // DOM of unchanged members stable instead of rebuilding the list every tick.
  const [team, setTeam] = createStore<{ rows: TeamMemberRow[] }>({ rows: [] })
  createEffect(() => {
    setTeam("rows", reconcile(members(), { key: "sessionID" }))
  })

  const activityText = (activity: MemberActivity) => {
    if (activity.kind === "tool")
      return activity.tool
        ? language.t("agentTeams.activity.tool", { tool: activity.tool })
        : language.t("agentTeams.activity.working")
    if (activity.kind === "working") return language.t("agentTeams.activity.working")
    return language.t(
      activity.kind === "thinking" ? "agentTeams.activity.thinking" : "agentTeams.activity.responding",
    )
  }

  const formatTokens = (tokens: number) =>
    new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }).format(tokens)

  const memberMeta = (member: TeamMemberRow) => {
    const parts = [
      member.variant,
      member.tokens === undefined
        ? undefined
        : `${language.t("context.usage.tokens")} ${formatTokens(member.tokens)}`,
      member.elapsedMs === undefined ? undefined : formatElapsedTime(member.elapsedMs),
    ].filter((part): part is string => Boolean(part))
    return parts.length ? parts.join(" · ") : undefined
  }

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={team.rows.length}
        fallback={<div class="text-13-regular text-text-weak py-8 text-center">{language.t("dialog.team.empty")}</div>}
      >
        <For each={team.rows}>
          {(member) => (
            <button
              type="button"
              class="flex flex-col gap-1.5 rounded-md border border-border-weak-base px-3 py-2 text-left transition-colors"
              classList={{ "hover:bg-surface-raised-base-hover": !!props.onOpen }}
              disabled={!props.onOpen}
              title={props.onOpen ? language.t("agentTeams.open") : undefined}
              onClick={() => props.onOpen?.(member.sessionID)}
            >
              <div class="flex items-center justify-between gap-2 w-full">
                <span class="text-13-regular truncate">{member.title}</span>
                <Show when={member.agent}>
                  <span class="text-11-regular text-text-weaker shrink-0">{member.agent}</span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5 text-11-regular min-w-0">
                <span class={`size-1.5 rounded-full shrink-0 ${stateDot[member.state]}`} />
                <span class="text-text-weak shrink-0">{language.t(stateKeys[member.state])}</span>
                <Show when={member.activity ?? member.detail}>
                  <span class="text-text-weaker truncate">
                    · {member.activity ? activityText(member.activity) : member.detail}
                  </span>
                </Show>
                <Show when={memberMeta(member)}>
                  {(meta) => <span class="ml-auto shrink-0 text-text-weaker tabular-nums">{meta()}</span>}
                </Show>
              </div>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}
