# Agent Teams 管理面（Phase A）：team 工具、完成唤醒、看门狗

> 状态：已评审，待实现（2026-10-12）
> 关联：`specs/agent-teams.md`（派发/权限/提示词现状）、`specs/agent-teams-backlog.md`

## 1. 背景

实测事故暴露了"能派发、看不见、停不掉"的问题：

- 成员等待人工权限询问 8.5 小时（`per_12bac...`，2026-10-11T15:54:19Z → 2026-10-12T00:31:09Z），期间 lead 无法从工具层感知"成员在等权限"，只能靠 UI 弹窗。
- 另一次成员命令因守护进程继承 PowerShell `*>` 管道而 25.3 分钟无返回，模型自设的 30 分钟 timeout 是唯一兜底。

现状盘点（相对于 Claude Code 的 coordinator/team/task 工具族）：

- 缺：成员清单/实时活动/等待权限状态；按成员停止；看门狗。
- 已有但未接线：`Permission.list()`（`packages/opencode/src/permission/index.ts:15,169`）、`SessionRunState.cancel`（级联取消 dispatch job，`packages/opencode/src/session/run-state.ts:77-86,111-143`）、`Session.children/messages`、`SessionStatus`、`BackgroundJob.get/list`。
- 行为不一致：`dispatch.txt` 第 4 条声称 background 完成会通知，实际只更新 metadata/事件，不注入父会话（`task.ts:263-272` 的 `notify` 是正确样板）。

## 2. 范围

Phase A（本 spec）：

1. `team` 工具：`op: "status" | "stop"`。
2. dispatch background 完成/失败唤醒 lead（紧凑注入）。
3. 成员看门狗：等权限 / 无活动超阈值 → 主动通知（去重）。

不在本 spec（另行排期）：共享任务板（CC TaskCreate/Update/List/Get）、`agent_send` 广播 `to:"*"`、dispatch 成员 timeout 部分返回、运行时命名团队（CC TeamCreate/Delete）、`agent_inbox unread_only` 接线。

## 3. 上下文纪律（验收项）

静态开销：

- `team.txt` 描述 ≤ 1.5 KB；`<team_delegation>`（`packages/opencode/src/session/system.ts:54-75`）只加 ≤1 句。
- 不新增 `AgentSummary` 式的周期摘要 fork（额外模型调用）。

动态开销（工具输出与注入永久进入会话历史）：

- `team status` 无 `session_id`：每成员一行，总输出 ≤ 2 KB；有 `session_id`：附单成员详情，结果文本尾部 ≤ 500 字符，总输出仍 ≤ 2 KB；超出截断并加 `<!-- truncated -->`。
- background 完成注入：单条 ≤ 2 KB，其中结果文本尾部 ≤ 1400 字符；完整结果留在成员会话，需要时用 `task_id` 取。
- 看门狗注入：单条 ≤ 0.5 KB。
- 去重规则：
  - 同一 job 完成（`${sessionID}:${completed_at}`）只注入一次（模块级 `Set<string>`）；
  - 同一权限询问（ask id）只告警一次；
  - 同一停滞区间（以最后活动时间为键）只告警一次，成员出现新活动后重新武装。
- `team status` 定位为按需快照，描述中不得鼓励高频轮询。

## 4. 详细设计

### 4.1 `team` 工具

文件：新增 `packages/opencode/src/tool/team.ts`、`packages/opencode/src/tool/team.txt`；在 `registry.ts` 受 `flags.experimentalAgentTeams` 门控注册（与 dispatch 同源，`registry.ts:110-113,261-264`）。

参数（`Schema.Struct`）：

- `op: Schema.Literals(["status", "stop"])`
- `session_id?: Schema.String`：op=stop 的目标成员；op=status 请求单成员详情
- `all?: Schema.Boolean`：op=stop 时停止调用者全部后代

`status` 语义：

- 作用域：调用者直接子会话（`Session.children(ctx.sessionID)`），最多列出 32 个；超出的只报计数。
- 每成员一行字段：
  - `id`：成员 sessionID
  - `agent`：`Session.Info.agent`
  - `name`：优先 `BackgroundJob.get(sessionID).title`，回退会话标题剥离 ` (@<agent> subagent)` 后缀
  - `state`：有 job 时用 job status（running/completed/error/cancelled）；无 job 时 `SessionStatus.get` busy/retry → `running`，idle → `idle`
  - `activity`：该会话最后一条 part 的类型（`tool:<tool>` / `text` / `reasoning`），无则 `-`
  - `quiet`：距最后 part `time.updated` 的时长（如 `12m`），无消息则 `-`
  - `waiting_permission`：`Permission.list()` 中 `sessionID` 匹配的条数，0 省略
  - `tokens`：会话 token 合计（口径同 `dispatch.ts` 的 `tokenTotal`），0 省略
  - `elapsed`：job `completed_at ?? now` − `started_at`，无 job 省略
- 输出格式（示例）：

```xml
<team_status members="3" running="1" waiting_permission="1">
ses_a agent=general name="first" state=running activity=tool:bash quiet=1m waiting_permission=1 tokens=1234 elapsed=12m
ses_b agent=explore name="second" state=completed activity=- tokens=567 elapsed=90s
ses_c agent=general name="third" state=idle activity=text quiet=8m
</team_status>
```

- `session_id` 详情块（仅当目标是调用者后代时允许；否则工具失败）：

```xml
<team_member id="ses_a">
<last_text>...尾部 ≤500 字符...</last_text>
<pending_permission id="per_x" permission="external_directory" patterns="[...]" waiting="8m" />
<last_tool name="bash" state="running" />
</team_member>
```

- 只读，不触发 `ctx.ask`。

`stop` 语义：

- 目标校验：沿 `parentID` 向上遍历必须到达 `ctx.sessionID`（复用 `agent-send.ts` 的树内解析思路）；目标不存在或非后代时以 `failed reason="..."` 行返回（工具本身不失败，便于模型继续处理）。
- 单个目标：`SessionRunState.cancel(sessionID)`；随后若 `BackgroundJob.get(sessionID)?.status === "running"` 再补 `BackgroundJob.cancel(sessionID)`（幂等兜底）。
- `all: true`：递归收集全部后代（上限 32），逐个同上；返回部分结果而非整体失败。
- `session_id` 与 `all` 同时给出 → 工具失败；两者都缺 → 工具失败。
- ask：`ctx.ask({ permission: "team", patterns: [sessionID ?? ctx.sessionID], always: ["*"], metadata: { op } })`；`ctx.extra?.bypassAgentCheck` 时跳过。
- 输出：

```xml
<team_stop stopped="2" failed="1">
ses_a stopped
ses_b stopped
ses_c failed reason="not a descendant of this session"
</team_stop>
```

- 被停止成员的 pending 权限询问随 run cancel 被中断，由 `Permission.ask` 的 `ensuring` 清理（`permission/index.ts:101-106`），无需额外处理。
- 停止对 `task` 子代理同样适用（不限于 dispatch 成员）。

### 4.2 dispatch background 完成唤醒

位置：`packages/opencode/src/tool/dispatch.ts` background 分支的 settle 流程尾部（`settle`，`:347-384`）。

- 仅 `mode === "background"` 时注入；join 模式不注入（返回值已含结果）。
- 注入路径照 `task.ts:240-272`：`ops.prompt({ sessionID: ctx.sessionID, agent: 父 agent, variant: parentVariant, parts: [{ type: "text", synthetic: true, text }] }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))`。
- 触发状态：`completed` 与 `error`；`cancelled` 不注入（由 lead 主动取消或预算触发，join/停止路径已知）。
- 文本格式（结果尾部按 1400 字符截断，总量 ≤ 2 KB）：

```xml
<team_update team="alpha" member="ses_a" agent="general" name="first task" state="completed" tokens="1234" elapsed="90s">
<result>...尾部...</result>
</team_update>
```

error 时用 `<error>...</error>` 替代 `<result>`（错误信息尾部同样截断）。

- 去重：模块级 `Set<string>`，键 `${sessionID}:${completed_at}`；`background.wait` 返回的 `info.completed_at` 缺失时不注入（避免竞态重复）。
- **双通道（Phase D）**：通知先落 mailbox（`fromSessionID` = 成员会话，`kind: "note"`，`body` = 注入文本，`status: "queued"`），再 `ops.enqueue` 入队父会话；入队成功标 `delivered`，失败保持 `queued` 待父会话下次运行由 `SessionPeers.apply` 注入。`agent_inbox` 可见，`unread_only` 只列未注入的行。
- **中断解耦（Phase D）**：join/background 的工具中断或 `ctx.abort` 只停止等待与聚合，不再取消成员；成员继续运行，完成时照常落库+注入。显式停止只来自 `team op=stop` 或 `budget_tokens` 命中。
- 更新 `dispatch.txt` 第 4 条：明确 background 完成会向父会话注入 ≤2 KB 摘要并写父会话 inbox；完整结果仍可用 `task_id` 取。

### 4.3 成员看门狗

仅 `mode === "background"` 时启动；`Effect.forkIn(scope, { startImmediately: true })`，每 `intervalMs` 检查一次，全部成员 job 终态后退出（用 `BackgroundJob.get` 判断）。

新增 RuntimeFlags（`packages/opencode/src/effect/runtime-flags.ts`，`positiveInteger` 模式）：

| flag | 环境变量 | 默认 |
| --- | --- | --- |
| `teamWatchdogIntervalMs` | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_INTERVAL_MS` | 60000 |
| `teamWatchdogPermissionMs` | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_PERMISSION_MS` | 300000 |
| `teamWatchdogInactiveMs` | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_INACTIVE_MS` | 600000 |

检查项（对每个仍 running 的成员）：

1. **等待权限**：`Permission.list()` 中该成员最早的 ask；`PermissionV1.Request` 没有创建时间戳，看门狗用模块级 `Map<askID, firstSeenAt>` 记录首次发现时间，ask 消失时清理条目；`now - firstSeenAt > teamWatchdogPermissionMs` 且该 ask id 未告警过 → 注入：

```xml
<team_watchdog member="ses_a" agent="general" state="waiting_permission" ask="per_x" permission="external_directory" patterns="[...]" waiting="6m">
Approve or reject the pending permission, or stop the member with the team tool (op: "stop").
</team_watchdog>
```

2. **无活动**：`Session.messages({ sessionID, limit: 1 })` 取最后消息的最后一个 part `time.updated`（回退 message `time.updated`/`time.created`）；`now - last > teamWatchdogInactiveMs` 且本停滞区间未告警 → 注入：

```xml
<team_watchdog member="ses_a" agent="general" state="stalled" quiet="12m" last_activity="tool:bash">
Member has produced no activity for a while. Check with team status, then stop it (op: "stop") or send guidance via agent_send.
</team_watchdog>
```

- 去重：ask id 集合 + 每成员 `lastNotifiedActivityAt`；成员出现新 part 后重置停滞告警。
- 注入路径同 4.2；单条 ≤ 0.5 KB。
- 看门狗自身不得阻止 dispatch 工具返回或成员完成：任何查询失败（session 已删除等）跳过本轮。

## 5. 数据源

| 需求 | 现成能力 |
| --- | --- |
| 成员清单 | `Session.children(parentID)`（`session/session.ts:449`） |
| 最新活动 | `Session.messages({ sessionID, limit })`（`session/session.ts:448`） |
| 运行状态 | `SessionStatus.get/list`（`session/status.ts:14-16`） |
| 等待权限 | `Permission.list()` 过滤 `sessionID`（`permission/index.ts:169-172`） |
| job 状态/时长 | `BackgroundJob.get/list`（`core/src/background-job.ts:196-200`） |
| 取消 | `SessionRunState.cancel`（`session/run-state.ts:77-86`）+ `BackgroundJob.cancel` |

## 6. 实施拆分（文件所有权，避免并发冲突）

| 批次 | 成员 | 文件 | 内容 |
| --- | --- | --- | --- |
| 1 | A `team-tool` | 新增 `src/tool/team.ts`、`src/tool/team.txt`；改 `src/tool/registry.ts`；改 `src/session/system.ts`（≤1 句） | 4.1 + `<team_delegation>` 提及 team 工具 |
| 1 | B `dispatch-wake` | 改 `src/tool/dispatch.ts`、`src/tool/dispatch.txt` | 4.2 |
| 2 | C `watchdog` | 改 `src/tool/dispatch.ts`、`src/effect/runtime-flags.ts`；可新增 `test/tool/team-watch.test.ts` | 4.3（依赖 A/B 落地） |

测试文件所有权：A → `test/tool/team.test.ts`；B → `test/tool/dispatch.test.ts`（增测）；C → 新增或并入 dispatch 测试。

约束：实现者不得改动工作区中 `packages/opencode/src/tool/shell.ts` 的未提交修改；不得执行 `git commit`/`git push`。

## 7. 测试要求

A（`test/tool/team.test.ts`，`testEffect(layer({ experimentalAgentTeams: true }))` 模式参照 `dispatch.test.ts`）：

- status 列出 dispatch 成员，格式含 state/activity/quiet/waiting_permission 字段；
- 成员等权限时 `waiting_permission` 计数出现（用 `Permission.Service.ask` fork 一个不 resolve 的询问构造）；
- stop 单个成员：用 Deferred 卡住成员 prompt，stop 后成员 job 变 cancelled；
- stop 非后代 session 失败；
- 输出总量超限截断。

B（`test/tool/dispatch.test.ts` 增测）：

- background 模式成员完成后，父会话收到一条 synthetic 注入（捕获 `ops.prompt` 的 `sessionID` 为父、`parts[0].synthetic === true`），内容含 `<team_update`、state 与结果尾部；
- 结果文本超长时注入 ≤2 KB；
- join 模式不注入；
- 同一 job 完成重复 settle（第二次 dispatch extend 场景）只注入一次。

C：

- flags 缩短为 100ms 级：等权限超阈值 → 注入 `<team_watchdog ... state="waiting_permission"`，且同一 ask 只注入一次；
- 无活动超阈值 → `state="stalled"`；成员恢复活动后再次停滞可再次告警；
- 全部成员完成后看门狗 fiber 退出（无泄漏；用 scope 结束断言或等待 dispatch 工具 run 完成）。

## 8. 验收

- `packages/opencode` 下 `bun typecheck` 只允许既有错误 `src/provider/provider.ts(1467,65)`。
- `bun test --timeout 30000 test/tool/team.test.ts test/tool/dispatch.test.ts` 全绿（含既有用例）。
- 第 3 节所有 cap 均有测试或常量断言。
- `specs/agent-teams.md` 工具清单补充 `team` 工具与 background 唤醒语义。
- 不提交；由 lead 审核后统一提交并按既有模式推送。
