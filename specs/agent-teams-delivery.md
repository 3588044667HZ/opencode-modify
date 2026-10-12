# Agent Teams 投递可靠性（Phase D）：队列入队、可靠唤醒、取消解耦

> 状态：已实现并验证（2026-10-12，见 Batch 1/2 与 97 项测试）
> 关联：`specs/agent-teams.md`（消息/黑板）、`specs/agent-teams-management.md`（完成唤醒/看门狗）
> 实测事故：成员向父会话发出的求助消息 `delivered` 落库后未进入上下文，直到用户手动再发一条消息才被处理。

## 0. 前置事实（实测取证）

- 事件：2026-10-12T13:40:49.100/.126Z 父会话 `ses_ed494768…` 与成员 `ses_ecfb6fb7…` 相继被 cancel；13:40:49.863Z 成员消息落库（`agent_message.status=delivered`）；父会话直到 13:41:06 用户手输才出现下一次 `loop`，13:40:49.863 没有任何 synthetic user message 落库。
- **运行构建落后**：`D:/opencode-desktop-dev/resources/app.asar`（13:43 构建）不含 `team_update`/`team_watchdog`/`Cannot send a peer message to the session itself`/`delivers a resume prompt`/`Failed to terminate the command process tree` 等标志串 → 实测跑的是 86b3392 之前的旧构建。重新验证前必须先重建桌面端。
- 即便在最新源码中，以下根因依然存在。

## 1. 根因（当前源码）

### R1 `Runner.ensureRunning` 在忙时"等待但不排新工作"
`packages/opencode/src/effect/runner.ts:115-138`：状态为 `Running`/`ShellThenRun` 时返回 `awaitDone(st.run.done)`，**不会启动/排队新的 work**。而 `SessionPrompt.prompt`（`prompt.ts:1058-1077`）是先 `createUserMessage` 再 `loop`→`ensureRunning`（`prompt.ts:1355-1358`）。因此：
- 目标空闲：正常起新 run；
- 目标正在跑（或刚被 cancel、runner 仍处 Running）：消息可能已落库/落会话，但没有任何机制保证它被处理，只能碰运气等当前 `runLoop` 的下一轮迭代读到它；若当前运行恰好收尾，消息就悬置到下一次用户输入。这就是"投递不及时"的直接原因。

### R2 状态先写 `delivered`，与实际注入脱节
`agent-send.ts:127-137` 在调用 `ops.prompt` 之前就把 mailbox 行写成 `delivered`；投递 fiber 被中止/失败时状态仍是 delivered。`agent_inbox` 的 `unread_only` 又未接线（`agent-inbox.ts:9`），无法自检"未注入/已注入"。

### R3 完成/看门狗通知不落库，只走注入
`dispatch.ts` 的 `injectParent`（28cf082）只做 `ops.prompt`，不写 mailbox；且其 fork 的 settle/看门狗一旦所在 run 取消或工具中断，通知就没有第二出口。UI 事件（`Team.MemberEnded`）与父代理投递是两条腿，缺一条。

### R4 取消把"停止等待"和"停止成员"耦合
`dispatch.ts` 的 release 在 `Exit.hasInterrupts` 时 `cancelAll`（成员 run + job）。join 被取消即杀死全部成员，中断在途消息处理且不再有完成出口。

## 2. 设计

### 2.1 Runner 增加"待跑槽"（requestRun）

`src/effect/runner.ts`：

- `State.Running` 增加可选 `pending?: PendingHandle`。
- 新方法 `requestRun(work: Effect<A, E>): Effect<"started" | "queued">`：
  - `Idle`：立即 `startRun`，返回 `"started"`；
  - `Running`：无 pending 则存 `{ id, done, work }`，返回 `"queued"`（已有 pending 则复用，work 语义为"排水一次"，重复请求可折叠）；
  - `Shell`：按 `ShellThenRun` 语义存 pending；
  - `ShellThenRun`：已有 pending 则复用。
- `finishRun`：当前 run 结束后若存在 pending，则启动 pending 并保持 `Running`（不触发 `onIdle`）；否则才 `idle`。
- `cancel`：中断当前 run 并 `Deferred.fail` pending（`Cancelled`）。
- **`ensureRunning` 语义保持不变**（忙时仍等待当前 run），避免影响既有调用方与 agent_send 死锁修复的假设。

`SessionRunState` 增加透传：`requestRun(sessionID, work): Effect<"started" | "queued">`（与 `ensureRunning` 相同取 runner）。

### 2.2 SessionPrompt 增加异步入队路径

`src/session/prompt.ts`：

- 抽出 `admit(input)`：`sessions.get` → `revert.cleanup` → `createUserMessage` → `sessions.touch`（与现 `prompt` 前半段一致）。
- 保留 `prompt`（用户/同步语义）：`admit` + `loop`（`ensureRunning`，等待本轮完成）。
- 新增 `enqueue(input)`：`admit` + `state.requestRun(sessionID, runLoop(sessionID))`，**不等待 run 完成**，返回创建的用户消息。目标空闲时立即起 run，目标忙碌时挂 pending，当前 run 收尾后自动排水。
- 暴露给工具层：`TaskPromptOps`（`tool/task.ts`）增加 `enqueue(input): Effect<void>`，由 `SessionPrompt.ops()`（`prompt.ts:147-153`）实现（`enqueue` + `Effect.catch(Effect.die)` 同现有风格）。

### 2.3 mailbox 状态真实化

`src/session/mailbox.ts`：

- 新增 `mark(id, status)`（`effect` 内 UPDATE）。
- 语义：`queued` = 已落库未进会话；`delivered` = 已作为 synthetic 输入进入目标会话（`enqueue`/`prompt` 成功创建消息，或 `pullQueued` 被 apply 注入）。
- `list.unreadOnly` 保持 = `status='queued'`；工具层接线。

### 2.4 agent_send

`src/tool/agent-send.ts`：

1. 一律先 `record({ status: "queued" })`。
2. `wakeIdle=true`（默认）：fork `ops.enqueue(peer envelope)`；成功后 `mark(id, "delivered")`；失败仅记 warning，保持 `queued`（下一次目标运行由 `SessionPeers.apply` 排水）。
3. `wakeIdle=false`：不投递，保持 `queued`。
4. 返回文案区分 `queued`/`delivered`。

### 2.5 dispatch：完成通知落库 + 取消解耦

`src/tool/dispatch.ts`：

1. **通知双通道**：`notifyCompletion` / 看门狗在注入前先经 `Mailbox.Service` 落库（`fromSessionID` = 成员会话，`toSessionID` = 父会话，`kind: "note"`，`body` = 注入文本，`status: "queued"`），随后 `ops.enqueue(...)` 并把该行 `mark(delivered)`。去重逻辑不变（`${sessionID}:${completed_at}`、ask id、停滞区间）。
2. **取消解耦**：
   - 无论 join/background，成员 settle 监听一律 fork 进长生命周期 scope 继续运行（join 通过 Deferred 等待其完成）。
   - 工具被中断（`Exit.hasInterrupts`）或 `ctx.abort`：**只停止等待与聚合**，不调用 `cancelAll`；成员继续运行，完成时照常落库+注入。成员身上正在处理的 peer 消息不再被 Abort。
   - 显式取消入口保留给 `team op=stop` 与 `budget_tokens` 命中（预算策略不变）。
   - 中断后 `ctx.metadata` 可能失败：监听器对其 `catchCause` 忽略，事件（`Team.MemberEnded`/`Team.Ended`）继续发布。
3. `dispatch.txt` 补充：join/background 被中断时成员默认继续运行，可用 `team op=stop` 显式停止。

### 2.6 agent_inbox

`src/tool/agent-inbox.ts`：`unread_only` 接入 `mailbox.list({ unreadOnly })`；`agent-inbox.txt` 更新（unread = 尚未进入目标会话的消息）。

## 3. 验收

- `Runner.requestRun`：Idle 立即启动；Running 挂起并在当前 run 结束后自动启动；`cancel` 同时失败 pending；`ensureRunning` 旧语义回归测试不变。
- 忙目标投递：目标正在跑时 `agent_send` 返回后，其消息在该 run 结束后被自动处理（不依赖用户输入）。
- `agent_inbox`：`unread_only` 只返回 `queued`；投递成功后同一行变 `delivered`。
- dispatch：工具被中断后成员不被取消；成员完成时父会话收到 mailbox 记录 + synthetic 注入；预算命中仍取消。
- `bun typecheck` 仅允许既有 `provider.ts(1467,65)`；`test/tool/{dispatch,team,agent-send}.test.ts`、`test/session/collaboration.test.ts` 全绿；涉及 Runner 的单测全绿。
- 文档：`specs/agent-teams.md`、`specs/agent-teams-management.md`、相关 `.txt` 同步。

## 4. 实施拆分

| 批次 | 成员 | 文件 | 内容 |
| --- | --- | --- | --- |
| 1 | `delivery-core` | `src/effect/runner.ts`、`src/session/run-state.ts`、`src/session/prompt.ts`、`src/tool/task.ts`（TaskPromptOps 接口）、`src/session/mailbox.ts`（mark）、更新 `test/tool/{dispatch,team,agent-send}.test.ts` 的 `stubOps` 增加 `enqueue`、新增 Runner 单测 | §2.1–2.3 |
| 2 | `agent-send-fix` | `src/tool/agent-send.ts`、`src/tool/agent-inbox.ts`、对应 `.txt`、`test/tool/agent-send.test.ts` | §2.4、§2.6 |
| 2 | `dispatch-detach` | `src/tool/dispatch.ts`、`dispatch.txt`、`test/tool/dispatch.test.ts` | §2.5 |

批次 1 完成后才能启动批次 2（`enqueue`/`mark` 是前置接口）。

约束：不得 commit/push；不得改动工作区无关文件；shell 为 Git Bash，测试从 `packages/opencode` 运行且必须带 `--timeout 30000`。
