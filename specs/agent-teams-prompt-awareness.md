# Agent Teams 提示词意识（dispatch awareness）

把 "何时组队/怎么组队" 的意识注入 lead（primary agent），但不重写 provider persona。两个落点：动态的 dispatch 工具描述（花名册可见）+ 受 flag 门控的系统提示段落（协调规范）。边界不变：不做服务端多 agent；不改 provider 模板；不改子代理 prompt；不新增 i18n key（提示词是英文文本，不进本地化）。

## 1. 目标

- 模型能直接看到已配置的 `team` 花名册（名字、描述、成员数），不用猜或试错。
- `experimentalAgentTeams` 开启且当前是 primary agent（dispatch 未被 deny）时，系统提示注入一段**默认委派**式协调规范：默认先拆分并 dispatch、例外清单、成本纪律、协作面（blackboard / agent_send）。
- 全部门控在 flag + agent 权限；关闭时零 token 开销。

## 2. 非目标

- 不修改 `packages/opencode/src/session/prompt/*.txt`（9 份 provider 模板）。
- 不修改 `task.txt` / `dispatch.txt` 的既有行为描述（只通过 registry 动态追加花名册）。
- 不给子代理注入 dispatch 意识（默认 deny，工具对它们不可见即可）。
- 不用 i18n，不做 UI。

## 3. 实现契约（冻结）

### 3.1 `packages/opencode/src/tool/registry.ts` — 动态花名册

在 layer 内新增（紧邻 `describeTask`）：

```ts
const describeTeams = Effect.fn("ToolRegistry.describeTeams")(function* () {
  if (!dispatch) return
  const cfg = yield* config.get()
  const teams = Object.entries(cfg.team ?? {}).toSorted(([a], [b]) => a.localeCompare(b))
  if (teams.length === 0)
    return 'No team rosters are configured; pass tasks to form an ad-hoc team for this call.'
  return [
    'Available team rosters (configured in opencode.json under "team"):',
    ...teams.map(([name, team]) => {
      const count = team.members.length
      return `- ${name}: ${team.description ?? "No description"} (${count} ${count === 1 ? "member" : "members"})`
    }),
  ].join("\n")
})
```

`tools()` 的描述拼接增加分支（与 `TaskTool.id` 分支并列）：

```ts
tool.id === DispatchTool.id ? yield* describeTeams() : undefined
```

约束：`dispatch` 变量是 flag 门控的（未开启时为 undefined）；`describeTeams` 首行 `if (!dispatch) return` 保证 flag 关时不产生任何输出。`Config.Service` 已在 registry layer 中可用（`registry.ts:101`）。

### 3.2 `packages/opencode/src/session/system.ts` — 系统提示段落

- `Interface` 增加：`readonly team: (agent: Agent.Info) => Effect.Effect<string | undefined>`。
- 新增纯函数导出（便于单测）：

```ts
export function teamDelegationGuidance(input: { agent: Agent.Info; enabled: boolean }): string | undefined
```

门控：`enabled && input.agent.mode === "primary" && !Permission.disabled(["dispatch"], input.agent.permission).has("dispatch")`，否则返回 `undefined`。

冻结文案（enabled 时输出，含动态协调行）：

```
<team_delegation>
The `dispatch` tool runs several subagents in parallel, each in its own session with only the prompt you give it.
Default to delegating: before starting non-trivial work, check whether it splits into independent streams and dispatch them rather than running everything serially in this session.
Good delegation candidates: broad investigation across multiple areas, multi-file or multi-part changes, and noisy exploration that would flood your context. Keep synthesis, decisions, and verification in the main session.
Use the task tool (or work directly) for a single subagent, strictly serial dependencies, quick lookups, and small edits. When in doubt, prefer a small team over a long serial crawl.
Keep teams small: the default concurrency is 4, respect any `budget_tokens`, and give every member a self-contained prompt that states exactly what to return.
Coordination: put shared intermediate results on the `blackboard`; use `agent_send`/`agent_inbox` only for coordination between sessions.
Use the `team` tool to inspect or stop dispatched members when they stall or wait on a permission.
Members cannot dispatch further by default, and their results are only trustworthy after you verify them.
</team_delegation>
```

协调行单独拼接在 `Members cannot dispatch...` 之前：

- `blackboard` 未 deny → `put shared intermediate results on the \`blackboard\``
- `agent_send` 未 deny → `use \`agent_send\`/\`agent_inbox\` only for coordination between sessions`
- 两条都有 → `Coordination: A; B.`
- 都被 deny → 整行省略

Effect 方法：

```ts
team: Effect.fn("SystemPrompt.team")(function* (agent) {
  return teamDelegationGuidance({ agent, enabled: (yield* RuntimeFlags.Service).experimentalAgentTeams })
})
```

layer 内 `yield* RuntimeFlags.Service`，`node` deps 增加 `RuntimeFlags.node`（`RuntimeFlags` 与 `Permission` 均已在本包可用）。

### 3.3 `packages/opencode/src/session/prompt.ts` — 注入位置

`sys.skills(agent)`、`sys.environment(model)` 等所在的 `Effect.all` 增加 `sys.team(agent)`；`system` 数组在 skills 之后追加（顺序：env → instructions → mcp → skills → team）：

```ts
...(team ? [team] : []),
```

## 4. 测试

`packages/opencode/test/tool/dispatch.test.ts`（已有 `experimentalAgentTeams: true` 的 layer 与 config fixture）：

- “lists configured team rosters in the dispatch description”：config `team.alpha = { description: "Alpha team", members: [general, explore] }`、`team.beta = { members: [general] }`；`registry.tools` 取 dispatch；description 包含 `Available team rosters`、`- alpha: Alpha team (2 members)`、`- beta: No description (1 member)`，且 `alpha` 在 `beta` 之前。
- “notes when no rosters are configured”：无 team config；description 包含 `No team rosters are configured`。

`packages/opencode/test/session/system-guidance.test.ts`（新增；layer 参考 `test/agent/agent.test.ts` 的 `Agent.node + Plugin.node + Provider.node + Auth.node + Config.node + Skill.node + RuntimeFlags.node`）：

- `enabled: false` + build → `undefined`。
- `enabled: true` + build → 文本包含 `team_delegation`、`dispatch`、`budget_tokens`（如果用户 config 未 deny）。
- `enabled: true` + explore（subagent）→ `undefined`。
- config `permission: { dispatch: "deny" }` 时 build → `undefined`。
- config `permission: { blackboard: "deny", agent_send: "deny" }` 时 build（enabled）→ 不含 `Coordination:`。

## 5. 验收命令（packages/opencode）

```
bun typecheck                                # 仅允许既有 provider.ts(1467,65)
bun test test/tool/dispatch.test.ts test/session/system-guidance.test.ts
```

变更文件 oxlint 0 error。

## 6. 风险与备注

- token 成本：仅 flag 开 + primary 时约 +150 词/轮；子代理与 flag 关零成本。
- 措辞为默认委派（原先的纯条件式措辞已按决策改为 delegation-first），用阈值/例外清单与成本纪律约束弱模型的 fan-out 冲动；若出现小任务过度拆队或重复烧 token，优先收紧阈值与预算，而不是回退为纯条件式。
- 花名册列表随 config 变化即时反映（每次 `registry.tools()` 调用读取 config）。
- 后续如果 A/B 发现模型仍不自觉，再考虑在 provider 模板加一句轻量提示（单独评估，不在本 spec 范围）。
