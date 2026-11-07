# Subagent Reuse and Context Management

Status: Draft for implementation  
Date: 2026-11-07  
Related: `task`, `dispatch`, `SessionCompaction`, `createSubagentSession`

## 1. Problem

Subagents must be reusable: a parent agent can continue an existing subagent with `task_id` and ask follow-up questions. This requires the subagent session to retain task identity and enough working state across context compaction.

Current behavior already provides:

- `task_id` resumes the same subagent session.
- Subagent sessions use the normal `SessionPrompt` loop.
- Overflow triggers `SessionCompaction` automatically.
- `task` returns only the subagent's final text, not its full transcript.
- `dispatch` returns compact team results and keeps full member sessions addressable by `task_id`.

The gap is that generic compaction can summarize away the original task brief or the state needed to interpret a follow-up. A resumed subagent can then behave like a new agent with an unrelated summary.

## 2. Goals

- Preserve a subagent's original task brief for the full lifetime of the session.
- Make compaction aware of subagent identity and task continuity.
- Keep follow-up behavior after compaction: `task_id` resumes the same objective, constraints, and work state.
- Preserve the current result flow: the parent gets a compact final response, not the full child transcript.
- Avoid schema migrations and avoid a new user-facing compact tool.

## 3. Non-goals

- No per-subagent model routing or model tiering.
- No new compact UI, compact command, or model-facing compact tool in this change.
- No cross-session memory beyond the subagent session metadata and its own history.
- No change to `dispatch` aggregation or the parent result format.
- No attempt to detect or filter model-generated pseudo-reasoning text.

## 4. Current behavior to preserve

- `task` reuses an existing session when `task_id` is provided.
- `createSubagentSession` preserves an existing child session's identity and permissions.
- Compaction is automatic when the session exceeds its usable context.
- The parent result still uses the `<task id="...">` envelope.
- Subagents cannot fan out further unless their own permissions allow it.

## 5. Design

### 5.1 Persist a subagent task brief

When a new subagent session is created, store a compact task brief in session metadata:

```ts
type SubagentMetadata = {
  subagent: {
    description: string
    brief: string
    createdAt: number
  }
}
```

`brief` is taken from the initial task prompt, truncated to 8,000 characters. `description` is the short task description. The metadata is written once at child-session creation.

Rules:

- New sessions: write metadata.
- Resumed sessions (`task_id`): keep the existing metadata, do not replace the original brief with the follow-up prompt.
- Legacy sessions without `subagent` metadata: do not write metadata during resume; compaction falls back to the first user text message.
- Transactional metadata changes must not overwrite unrelated session metadata.

### 5.2 Compaction preserves subagent continuity

`SessionCompaction.process` must determine whether the session is a subagent session:

- `session.parentID` is present, or
- `session.metadata.subagent` is present.

For a subagent session, build a protected brief block:

```text
Subagent task brief (preserve across compaction):
Description: ...
Task:
...
This session is reusable and may receive follow-up questions. Preserve the original objective, constraints, acceptance criteria, files changed, tests, open questions, and next steps.
```

Add this block to the compaction prompt context in addition to the conversation. Keep it before the conversation so it is treated as the anchor.

If metadata is missing, derive the fallback brief from the first non-compaction user text message. Limit the fallback to the same 8,000-character budget. If no brief exists, use the normal compaction prompt unchanged.

The existing summary template already has `Objective`, `Work State`, `Next Move`, and `Relevant Files`; it must retain those sections. No new summary format is required.

### 5.3 Follow-up and reuse

- `task_id` remains the only resume mechanism.
- A follow-up prompt appends to the existing session; it must not create a new child session.
- The task brief remains in metadata after compaction, so later follow-ups still include the original objective.
- The parent receives the final result of the follow-up as it does today.

### 5.4 Main-agent management

The parent already receives compact results. This change should not add transcript copying. The parent can:

- use the returned `task_id` for follow-up,
- read the child session when full detail is required,
- rely on the child's compacted summary for continuity.

No new result field is required for the MVP; `task_id` and existing task metadata are sufficient.

## 6. Implementation Plan

### 6.1 Session metadata

Files:

- `packages/opencode/src/tool/subagent.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/tool/dispatch.ts`

Changes:

- Extend `createSubagentSession` with an optional task brief input.
- On new session creation, merge `metadata.subagent` into the create input.
- Preserve existing metadata on resumed sessions.
- Pass `params.prompt` from `task` and the member prompt from `dispatch`.
- Truncate the brief to 8,000 characters; keep the full prompt in normal message history.
- Add a small helper for metadata construction, but do not create a new service.

### 6.2 Compaction

Files:

- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/compaction.ts` imports `buildPrompt`

Changes:

- Fetch the session info during `processCompaction`.
- Build the protected brief block for subagent sessions.
- Pass the brief as an extra context entry to `buildPrompt`.
- Use the first user text as a fallback when metadata is absent.
- Do not alter normal-session compaction prompts.

### 6.3 Tests

Add or extend tests:

- `packages/opencode/test/session/compaction.test.ts`
  - Subagent session compaction prompt includes the task brief and follow-up instruction.
  - Legacy subagent without metadata uses the first user text fallback.
  - Normal session compaction prompt does not include the subagent block.
  - Retention of the current summary sections remains intact.
- `packages/opencode/test/tool/task.test.ts`
  - New child session has `metadata.subagent`.
  - Resuming with `task_id` preserves the original brief and session identity.
  - Follow-up prompt uses the same child session.
- `packages/opencode/test/tool/dispatch.test.ts`
  - Member creation stores the same subagent metadata contract.
- `packages/opencode/test/tool/subagent.test.ts`
  - Unit-test brief truncation and metadata construction if extracted.

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts
bun test test/tool/task.test.ts test/tool/dispatch.test.ts test/tool/subagent.test.ts
bun typecheck
```

## 7. Acceptance Criteria

- New subagent sessions contain a `metadata.subagent` object.
- Existing `task_id` sessions remain the same session and keep the original brief.
- A compacted subagent summary prompt contains the original task brief and a reuse/follow-up instruction.
- A follow-up after compaction still targets the same objective and constraints.
- Normal sessions do not get subagent briefs.
- No session schema migration is required.
- Existing task, dispatch, subagent, and compaction tests pass.
- `bun typecheck` passes in `packages/opencode`.

## 8. Risks and Decisions

- **Metadata size**: the brief is capped at 8,000 characters; the full prompt remains in message history.
- **Legacy sessions**: fallback to the first user text avoids a migration.
- **Metadata conflicts**: merge only the `subagent` key; do not replace other metadata.
- **Compaction model**: the compaction agent may still produce a weak summary; the brief is an anchor, not a guarantee. Tests assert prompt content, not model quality.
- **No heuristic reasoning filtering**: out of scope; this change is only about task continuity.

## 9. Open Questions

- Should the brief include a short list of attached filenames? Recommended: yes, as text; attachments themselves stay in history.
- Should a follow-up explicitly update a `lastRequest` field? Not required for MVP; recent messages carry the follow-up.
- Should `task` expose a `compacted` flag? Not required for MVP.

## 10. Context Window Usage Tool

Add a read-only tool for the parent agent to inspect a subagent's current context-window pressure.

Tool ID: `context`

Parameters:

```ts
{
  session_id?: string // default: current session; descendants only otherwise
}
```

Rules:

- The current session is always allowed.
- A different session is allowed only when it is a descendant of the calling session.
- Read-only; no permission ask is required beyond the normal tool permission rules.
- Do not expose unrelated session data.

Result:

```text
<context session="<id>" agent="<agent>" model="<provider>/<model>">
  <window limit="<tokens>" used="<tokens>" percent="<percent>" remaining="<tokens>" over="<bool>" />
  <tokens input="..." output="..." reasoning="..." cache_read="..." cache_write="..." />
  <source message="<assistant message id>" />
</context>
```

Semantics:

- `used` is the token total of the latest assistant message with tokens, using the same breakdown as the UI: input + output + reasoning + cache.read + cache.write.
- `limit` comes from the provider model's `limit.context`.
- `remaining = max(0, limit - used)`.
- `percent = round(used / limit * 100)`; do not clamp, so over-limit is visible.
- If no assistant tokens or no context limit is available, return a clear `<context unavailable="...">` result instead of throwing.
- Include structured `metadata` with session, model, tokens, limit, percent, and remaining.

Implementation:

- New file `packages/opencode/src/tool/context.ts` and description `context.txt`.
- Register the tool in `packages/opencode/src/tool/registry.ts`.
- Reuse `Session` messages and `Provider.getModel`; do not add a service.
- Tests in `packages/opencode/test/tool/context.test.ts`:
  - current session returns usage;
  - descendant subagent returns usage;
  - unrelated session is rejected;
  - missing limit/tokens returns unavailable;
  - percent/remaining calculations cover over-limit.
