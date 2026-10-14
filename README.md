# opencode-modify — Agent Teams 多智能体编排分支

> 独立维护的多智能体编排分支（源自 opencode 快照，不跟踪上游）：把「一个主 Agent 调度多个并行子 Agent」做成一等公民——派发、通信、共享状态、可观测、可干预，全部内建。

这不是又一个 opencode 皮肤或发行版。本分支的定位是**多智能体编排（agent-teams）的试验场**：在保留既有全部能力（TUI/桌面端、LSP、MCP、插件、会话管理……）的前提下，围绕"团队"补上一整套原版没有的运行时、工具与 UI。

本仓库为**独立维护**：不下载官方 CLI、不检查官方更新、不执行官方升级，一切代码只来自本仓库构建。

---

## 特性总览

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 团队派发 | `dispatch` | 花名册/ad-hoc 并行子代理，join/background，并发上限、预算、续聊 |
| 团队管理 | `team` | 成员状态快照与按需停止（单个/全队） |
| 成员通信 | `agent_send` / `agent_inbox` | 会话树内消息投递与审计收件箱 |
| 共享状态 | `blackboard` | 树内 KV，版本化 + CAS + append |
| 生命周期通知 | 自动 | background 完成唤醒、等权限/停滞看门狗 |
| 桌面 UI | 内建 | Agent Teams 独立窗口：Team / Blackboard / Inbox 面板 |

除此之外还有一批针对多代理场景的稳定性修复（见下文「稳定性修复」）。

---

## 架构

```text
                     ┌────────────────────────────────────────────┐
                     │ Lead session（build / plan / 任意 primary） │
                     │  dispatch · team · agent_send · blackboard │
                     └───────────────┬────────────────────────────┘
                                     │ dispatch(team|tasks, mode, concurrency, …)
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
       ┌────────────┐         ┌────────────┐         ┌────────────┐
       │ member  A  │         │ member  B  │   ...   │ member  N  │   子会话（独立上下文）
       └─────┬──────┘         └─────┬──────┘         └─────┬──────┘
             │  每成员一个 BackgroundJob（id = 子会话 ID，进程内、可取消）
             └──────────────────────┬──────────────────────┘
                                    ▼
        agent_send / agent_inbox   会话树内消息（hop/体积/速率限制、可审计）
        blackboard                 会话树内共享 KV（CAS、限额、durable 事件）
        team status/stop           按需盘点与干预
        completion wake · watchdog 主动通知（≤2KB 注入父会话）
```

---

## 新功能详解

### 1. `dispatch` — 团队派发

- **花名册或即席组队**：`team` 参数读取 `opencode.json` 的 `team` 配置；`tasks` 直接传成员数组（1..16），两者同时给出时 `tasks` 覆盖。
- **两种模式**：`mode: "join"`（默认）等待全部成员并聚合返回；`mode: "background"` 立即返回，成员完成时通知。
- **真正的并发上限**：`concurrency`（默认 4，钳制 1..16，可被花名册 `max_parallel` 兜底）用信号量限制**同时运行**的成员数，而不是只限制等待。
- **成员级控制**：
  - `variant`：思考强度（如 `low`/`high`/`max`），在派发前按成员实际模型校验；
  - `autonomy`：为该成员授权额外的外部目录，高风险路径直接拒绝并交人工确认；
  - `budget_tokens`：团队累计 token 预算，超出后停止后续成员。
- **续聊与追加**：`task_id` 传入成员子会话 ID 即可继续该成员；若它仍在运行，新指令会追加到当前轮之后，而不是被丢弃。
- **聚合结果**：join 返回 `<team>` XML，每个 `<member>` 带 `id`（子会话 ID）、`agent`、`name`、`state`、结果或错误，以及实际命中的 `variant`、`tokens`、`elapsedMs`；`aggregate: "none"` 可只保留状态骨架。

### 2. `team` — 团队管理（新增）

- `op: "status"`：按需盘点当前会话的直接子成员（最多 32 条），每行含 `state`、当前 `activity`、静默时长 `quiet`、`waiting_permission` 计数、tokens、elapsed；传 `session_id` 可看单个成员的详情块（最后一段文本、待处理权限询问、最后一次工具调用）。输出整体 ≤2KB，可截断。
- `op: "stop"`：停止单个成员或全部后代（`SessionRunState.cancel` 级联取消其后台 job 与待处理权限询问）。目标必须位于调用者会话树内；该操作会按 `team` 权限 key 请求授权。

### 3. 生命周期通知（新增）

- **完成唤醒**：background 模式下成员完成/失败时，父会话会收到一条 ≤2KB 的合成 `<team_update>`（状态、摘要、结果尾部、tokens/elapsed），完整结果留在成员会话，可用其 `session_id`（`task_id`）回读。同一 job 只通知一次。
- **看门狗**：background 模式下，成员**等待权限**超过阈值或**长时间无活动**时，父会话会收到 ≤512B 的 `<team_watchdog>` 提醒（附带操作建议：批准/拒绝、`team op=stop`、`agent_send` 干预）。同一权限询问、同一停滞区间只提醒一次。阈值可通过环境变量调整：

  | 环境变量 | 默认 |
  | --- | --- |
  | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_INTERVAL_MS` | `60000` |
  | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_PERMISSION_MS` | `300000` |
  | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_INACTIVE_MS` | `600000` |

### 4. `agent_send` / `agent_inbox` — 成员通信

- 目标限同一会话树：子会话 ID、`"parent"` 或 `"root"`；自投递与跨树投递被拒绝。
- **异步投递**：消息先写入 mailbox 审计，再由独立 fiber 投递——发送者永远不会被阻塞（修复了子代理与主代理互等导致的死锁）。
- 运行中的目标在下一个安全边界把消息作为 steer 消费；空闲目标默认唤醒（`agent_message.wake_idle: false` 可改为排队，待其下次运行注入）。
- 限制可配：`max_hop`（默认 8）、`max_body_bytes`（默认 8192）、`max_per_minute`（默认 20）。
- `agent_inbox` 读取本会话的 mailbox 审计记录。

### 5. `blackboard` — 共享黑板

- 会话树作用域的单工具 KV：`put`（`set`/`append`）、`get`、`list`、`delete`，`if_version` 实现乐观并发（CAS）。
- 限额：单值默认 64KB、单树默认 256 键；变更发布 durable 事件，UI/其他成员可订阅。
- 成员任务提示中会自动附带黑板可用说明；key 约定由 lead 在任务中给出。

### 6. 权限与提示词

- 新增 `dispatch`、`team` 等权限 key；子代理默认拒绝 `dispatch`，可按 agent 显式放开（用于"子专家团"）。
- 成员权限从父会话派生；`autonomy` 授权会校验高风险路径。
- 提示词按需注入：`<team_delegation>` 只发给能派发的主代理；`dispatch` 工具描述动态列出已配置花名册——不会给子代理增加无关上下文。

### 7. 桌面端 UI

- **Agent Teams 独立窗口**（桌面端默认开启）：Team 面板（成员列表、状态圆点、当前 activity、tokens/elapsed/variant、点击打开成员会话）、Blackboard 面板、Inbox 面板。
- 采用事件刷新 + 轮询双通道与 reconcile-by-key 渲染，避免列表闪烁。
- 子会话窗口顶部有运行详情条（当前模型、状态、耗时）。

### 8. 稳定性修复

- `agent_send` 不再阻塞发送者（根因：`Runner.ensureRunning` 在目标忙碌时等待其当前轮次）。
- `dispatch` 并发上限真正生效；对运行中成员 `task_id` 续聊不再丢 prompt。
- shell 工具超时/中止时，终止失败（进程刚好退出、taskkill 报错等）不再把整个工具调用变成错误并丢弃已捕获输出；终止等待有上限。

---

## 配置

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // 允许成员再派发一层（默认 1：子代理不能再派发）
  "subagent_depth": 2,
  "team": {
    "alpha": {
      "description": "示例花名册",
      "max_parallel": 4,
      "aggregate": "concat",
      "members": [
        { "agent": "general", "role": "implementer", "variant": "high" },
        { "agent": "explore", "prompt": "只做侦查并回报结论" }
      ]
    }
  },
  "agent_message": { "max_hop": 8, "max_body_bytes": 8192, "max_per_minute": 20, "wake_idle": true },
  "blackboard": { "max_value_bytes": 65536, "max_keys": 256 }
}
```

开关（CLI 默认关闭，桌面端默认开启）：

| 环境变量 | 作用 |
| --- | --- |
| `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` | 注册 `dispatch`/`team`/`agent_send`/`agent_inbox`/`blackboard` 与团队提示词 |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | 打开 `task` 工具的后台模式 |
| `OPENCODE_EXPERIMENTAL` | 一次开启全部实验特性（含以上） |

---

## 快速开始（源码运行）

本仓库为私有分支，不通过 npm 分发：

```bash
bun install
bun dev            # CLI（TUI）
bun dev:desktop    # 桌面端（agent-teams UI 默认开启）
bun dev:web        # Web 版
bun run build:local  # 一次性构建服务端 bundle + 桌面 GUI（带防陈旧校验）
# 可选：--package 仅打包 win-unpacked（本地部署用）；--installer 额外产出 NSIS 安装器；--deploy <dir> 覆盖部署到运行目录
```

桌面端/服务端验证前请先执行 `bun run build:local`（或 `bun run build:local -- --package --deploy D:/opencode-desktop-dev`），避免陈旧产物让改动"不生效"。

测试（必须在包目录内运行，禁止从仓库根运行）：

```bash
cd packages/opencode
bun typecheck
bun test --timeout 30000 test/tool/dispatch.test.ts
bun test --timeout 30000 test/tool/team.test.ts
bun test --timeout 30000 test/tool/agent-send.test.ts test/session/collaboration.test.ts
```

---

## 构建标记纪律（防止误用老客户端）

**每次代码修改后必须留下构建标记；GUI 与服务端必须来自同一次构建。**

1. 修改完成后运行 `bun run build:local`：脚本会自动在仓库根 **`BUILD.md`** 追加/更新一行（时间、Build ID、提交、本次更改、服务端标记、GUI 标记）；若手工构建，也必须手动在 `BUILD.md` 追加一行说明本次更改。
2. 运行时核对两端标记：
   - 服务端：启动日志出现 `server listening build=<id>`，`GET /global/health` 返回 `build` 字段；
   - GUI：Agent Teams 窗口页头显示 `build <id>`；
   - 两者不一致时 GUI 会显示警示条——此时先重新构建（`bun run build:local`），再复验，禁止用旧客户端验证新改动。
3. `BUILD.md` 是唯一权威记录：同一「提交 + dirty 状态」只保留一行；排查“改动不生效”时，先对照这里的标记与正在运行的版本是否一致。

详见 `specs/build-markers.md`。

---

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `packages/opencode` | 核心运行时、会话、工具（`dispatch`/`team`/`agent_send`/`agent_inbox`/`blackboard`…） |
| `packages/core` | 服务层：`BackgroundJob`、mailbox、blackboard 存储、配置 schema |
| `packages/app`、`packages/desktop` | Web/桌面 UI（Agent Teams 窗口与面板） |
| `packages/schema`、`packages/session-ui` | 事件协议与共享会话 UI |
| `specs/` | 中文设计文档（见下） |

## 设计文档

- `specs/agent-teams.md` — 团队派发/消息/黑板的总体设计
- `specs/agent-teams-management.md` — `team` 工具、完成唤醒、看门狗与上下文预算
- `specs/agent-teams-delivery.md` — 投递可靠性：队列入队、可靠唤醒、取消解耦
- `specs/agent-teams-permissions.md` — 团队场景的权限模型
- `specs/agent-teams-prompt-awareness.md` — 提示词注入策略
- `specs/agent-teams-backlog.md` — 后续计划（任务板、广播、成员超时等）
- `specs/independent-maintenance.md` — 独立维护：切断上游运行时/构建时联系
- `specs/build-markers.md` — 构建标记：`BUILD.md` 记录、GUI/服务端双标记与不匹配告警

---

## 独立维护声明

- 本仓库独立维护：不跟踪上游、不下载官方 CLI、不检查官方更新、不执行官方升级；桌面端与 CLI 的代码一律来自本仓库构建（`bun run build:local`）。
- 升级方式只有一种：`git pull` 本仓库后重新构建。`opencode upgrade` 在该分支会被明确拒绝。
- 仅保留必要的开源许可与版权声明（见 [LICENSE](LICENSE)，MIT）；其余与上游发行渠道的关系均已移除。
