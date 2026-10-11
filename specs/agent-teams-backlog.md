# Agent Teams 打磨清单（备忘）

用途：backlog/checklist，不是 spec。完成后勾选；每条只记**目标 / 现状 / 验收标志 / 依赖**。
边界（长期有效）：不新增服务端多 agent 能力（无集群调度、无跨进程/跨机器所有权、无服务端唤醒）；打包只在里程碑执行；新增 i18n key 必须同批处理 62 语言（`bun run translate:app`）或先用零新增 key 的方案；无关改动（auth 多 key、provider-clone、bun.lock 等）不碰。

## 已完成（保留勾选，供回顾）

- [x] 成员行增强：per-member tokens、耗时、命中 variant 写入 dispatch metadata 并在面板展示
- [x] 面板防闪：blackboard/inbox/team 按 key `reconcile`，轮询不再整列表重建
- [x] 思考强度：`variant` 参数（dispatch/task/花名册）+ 未知值前置校验 + `"default"` 哨兵
- [x] 权限委托 v1：`autonomy` 事前授权 + 高危拒绝 + deny 优先 + 续聊追加（`specs/agent-teams-permissions.md`）
- [x] 面板独立窗口、成员窗口、标题/路由修复

## P0 — 下一步（直接改善现有模式）

- [ ] **1. per-member model 覆盖**
  - 目标：dispatch/task/花名册成员支持 `model: "provider/model"`；explicit model 优先于 agent 配置与 lead 模型。
  - 现状：只有 variant；member 模型逻辑在 `tool/dispatch.ts`、`tool/task.ts`（`info.model ?? messageModel`），校验函数 `tool/subagent.ts resolveSubagentVariant` 可复用。
  - 验收：未知 model 在创建子会话前失败；explicit model + 合法 variant 组合可用；metadata 记录 model/variant；测试覆盖。
  - 依赖：无。可与 2、3、4 并行（文件冲突需协调）。

- [ ] **2. hooks / 确定性控制点**
  - 目标：给团队/子代理生命周期与权限决策暴露 plugin/配置级 hook：member started / member settled / team ended / permission before-decide（allow/deny/改写入参）。
  - 现状：plugin 已有 `tool.execute.before/after`（`session/tools.ts`）；缺 subagent 生命周期与权限 hook；事件 `session.next.*` 在旧协议不投递，只能轮询。
  - 验收：插件可在成员启动前调整 prompt/权限、在成员结束后做审计/告警；有测试或 demo。
  - 依赖：权限 hook 需与 `specs/agent-teams-permissions.md` §7（P2 草案）对齐。

- [ ] **3. 子代理 checkpoint / 回退 + 树状转录**
  - 目标：成员会话可回退到某个消息点；面板/主时间线展示 team 树，可一键钻入成员转录并看到实时活动。
  - 现状：成员窗口可点开；面板有状态/活动；无子代理粒度 checkpoint，无树状视图。
  - 验收：dispatch 卡片展开成员列表（复用 `session-ui` message-part 的 `case "dispatch"`）；成员可回退；不回退触发的工具调用不产生孤儿 job。
  - 依赖：opencode 既有 revert/snapshot 机制调研。

- [ ] **4. 成本与状态可见**
  - 目标：per-member cost（非仅 tokens）、team 聚合 cost、面板/工具卡显示；可选状态行。
  - 现状：tokens/elapsed 已有；member 模型成本可从 provider cost 与 tokens 计算。
  - 验收：metadata 增加 `cost`；预算 `budget_tokens` 之外支持金额预算（如做）。
  - 依赖：1（模型信息，用于定价）。

## P1 — 手感打磨

- [ ] **5. peer inbox 未读/已读**：`unread_only` 目前是 reserved；补已读游标（面板打开即已读）、未读徽标；`agent_inbox` 支持只拉未读。验收：未读计数与已读状态在面板/工具间一致。
- [ ] **6. blackboard 增强**：UI 手动 put/delete（带权限确认）、按 key 前缀过滤（路由已支持 prefix）、复制值、"自上次查看哪些 key 更新"高亮。验收：不新增 i18n key 或同批翻译。
- [ ] **7. 每成员取消/重试 + 预算提示**：面板按钮走 `runState.cancel` / `task_id` 续聊；预算命中时面板显式提示而非静默 cancelAll。验收：取消无孤儿 job（已有测试基础）。
- [ ] **8. 桌面通知**：成员完成/失败、收到 peer 消息时系统通知（复用 `notification.permission.*` 模式与设置开关）。
- [ ] **9. 权限体验**：模式切换（plan / accept-edits 等等价物）、settings 分级（enterprise/project/user 优先级）、审批框内修正命令或给替代指令、deny 原因展示。验收：规则优先级有测试；UI 不覆盖已有行为。
- [ ] **10. 动态 variant/model 列表**：工具描述注入或只读目录工具（`agent_catalog`），让 lead 不必试错；错误消息已有候选列表可作兜底。
- [ ] **11. 聚合与预算细化**：`aggregate: "summary"`（small model 汇总）；团队级默认 `max_tokens`/`max_steps`；预算命中"软着陆"（先收已完成成员再停）。
- [ ] **12. i18n 补齐**：为 `agentTeams.*`、`dialog.blackboard.*`、`dialog.peerInbox.*`、`dialog.team.*`、`command.session.*` 跑 `bun run translate:app`，使 `packages/app/src/i18n/parity.test.ts` 转绿；之后新增 key 同步执行。
- [ ] **13. 刷新机制**：dispatch 状态改订阅 v1 `message.part.updated`；黑板/inbox 改自适应轮询（有写入快、静默慢），降低空转与延迟。

## P2 — 生态/企业（评估后再定）

- [ ] **14. Bash 沙箱**：文件系统/网络隔离（对照 Claude Code 的 seatbelt/bubblewrap 方向）。
- [ ] **15. 审计与托管**：OTel 事件/指标、托管策略（只读配置）、审批审计导出。
- [ ] **16. 发布流程**：版本号、CHANGELOG、安装包固定产物目录；里程碑打包时执行。
- [ ] **17. 生态补齐**：marketplace/插件分发、SDK、GitHub Actions（对应 Claude Code 的生态规模，非单点能力）。

## 实施纪律备忘（沿用）

- 分工模式：max 负责 spec/拆分/终审；实现子代理默认思考强度（`variant: "default"` 或空串兼容旧 server）。
- 每次派活：冻结契约（签名/错误文案/文件清单/验收命令/非目标）；要求成员在回报中列出 deviations/ambiguity。
- 终审不可省：独立重跑 typecheck+聚焦测试、逐条读 diff 语义；"测试全绿"只证明实现与 spec 自洽，不证明需求正确。
- 成本纪律：大任务拆小或给 `budget_tokens`；参考单次实现任务曾消耗约 5M tokens 的教训。
