# opencode-modify — Agent Teams 多智能体编排分支

> 独立维护的多智能体编排分支（源自 opencode 快照，不跟踪上游）：把「一个主 Agent 调度多个并行子 Agent」做成一等公民——派发、通信、共享状态、可观测、可干预，全部内建。

这不是又一个 opencode 皮肤或发行版。本分支的定位是**多智能体编排（agent-teams）的试验场**：在保留既有全部能力（TUI/桌面端、LSP、MCP、插件、会话管理……）的前提下，围绕"团队"补上一整套原版没有的运行时、工具与 UI。

本仓库为**独立维护**：不下载官方 CLI、不检查官方更新、不执行官方升级，一切代码只来自本仓库构建。

---

## 特性总览

| 能力         | 工具                                                                                                    | 说明                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 团队派发     | `dispatch`                                                                                              | 花名册/ad-hoc 并行子代理，join/background，并发上限、预算、续聊                                                                  |
| 团队管理     | `team`                                                                                                  | 成员状态快照与按需停止（单个/全队）                                                                                              |
| 成员通信     | `agent_send` / `agent_inbox`                                                                            | 会话树内消息投递与审计收件箱                                                                                                     |
| 共享状态     | `blackboard`                                                                                            | 树内 KV，版本化 + CAS + append                                                                                                   |
| 生命周期通知 | 自动                                                                                                    | background 完成唤醒、等权限/停滞看门狗                                                                                           |
| 桌面 UI      | 内建                                                                                                    | Agent Teams 独立窗口：Team / Blackboard / Inbox 面板                                                                             |
| 独立 server  | `build:server`                                                                                          | 无 Electron 的 standalone 二进制，内嵌 Web UI；可在 Linux/Windows 上作为常驻服务运行                                             |
| 设备标签     | `/global/health` · `/api/health`                                                                        | 在 Web UI 的服务器列表显示 `Linux · linux-1g` 等来源标签；用 `OPENCODE_DEVICE_NAME` 覆盖默认 hostname                            |
| 自动项目记忆 | `.opencode/memory.md`                                                                                   | 新项目首次构建 prompt 时自动扫描 manifest/目录并生成项目记忆；不覆盖已有文件，不调用模型                                         |
| 按需启用 MCP | `mcp`                                                                                                   | 模型可列出/启用/停用 `opencode.json` 中已配置的 MCP；不能新增 server、命令或 URL                                                 |
| 语义引擎     | `read_view`（默认）/ `blast_radius` / `project_map` / `edit_batch` / `edit_transaction` / `verify_test` | 基于本机 JetBrains IDE 的无头分析：定义/引用/诊断/项目地图/事务编辑/读时对账；默认只暴露 read_view，其余经 `semantic.tools` 开启 |

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

  | 环境变量                                            | 默认     |
  | --------------------------------------------------- | -------- |
  | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_INTERVAL_MS`   | `60000`  |
  | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_PERMISSION_MS` | `300000` |
  | `OPENCODE_EXPERIMENTAL_TEAM_WATCHDOG_INACTIVE_MS`   | `600000` |

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

## 语义引擎（JetBrains IDE 无头分析）

仓库内置 `semantic-server`：一个无头启动本机 JetBrains IDE 平台的语义守护，通过 TCP + locator
与 opencode 客户端通信。它把 IDE 的 PSI/索引能力暴露成工具，并额外提供上下文对账（读时 delta、
编辑版本戳、会话 ledger/fold）：

默认只向模型暴露 `read_view`（含 IDE 诊断）；其余工具需在 `semantic.tools` 中显式开启。

| 工具                              | 能力                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `read_view`                       | 内容/符号/覆盖/锚点/诊断；`known_version` 命中时返回 `unchanged`，过期时返回有界 delta |
| `blast_radius`                    | 定义、调用者、callees、受影响文件/测试、入口点、风险评级                               |
| `project_map`                     | 目录模块、入口点、模块依赖/环、hot（占位）                                             |
| `edit_batch` / `edit_transaction` | 锚点编辑、逐文件版本/changed/position_map、跨文件事务与崩溃恢复                        |
| `verify_test`                     | 运行项目测试并归一化结果                                                               |

### 支持矩阵（当前）

| 语言     | read_view                      | project_map / blast_radius | 说明                                                       |
| -------- | ------------------------------ | -------------------------- | ---------------------------------------------------------- |
| Java     | 完整（锚点/诊断/跨文件定义）   | 完整                       | IDEA / IntelliJ 平台                                       |
| Python   | 完整（符号/锚点/诊断）         | 可用                       | PyCharm；未配置解释器时引用退化为名称级匹配                |
| JS/TS    | 内容/位置/符号；锚点与诊断降级 | 语法级可用                 | 不调用 TS 语言服务 resolve，避免卡死；精度低于 Java/Python |
| HTML/CSS | 内容/位置                      | 不适用                     | 仅文件视图                                                 |

### IDE 自动发现与选择

**目标机不需要额外安装 JDK**：未显式配置 `semantic.command` 时，客户端自动发现已安装的
JetBrains IDE，并用它自带的 JBR 启动 jar。发现源：

- 显式配置：`semantic.ide_home`（路径）或 `semantic.ide`（`auto | idea | pycharm | webstorm | ...` 或路径）；
- Windows 卸载表注册项（PowerShell 优先、`reg` 回退）、Toolbox、常见安装目录；
- macOS `/Applications/*.app`、Linux Toolbox/`/opt` 兜底。

每个候选都要通过 `product-info.json`（`productCode`/`buildNumber`）、`lib/` 与
`jbr/bin/java[.exe]` 校验。选择顺序：显式配置 > 产品 selector > 按项目语言自动选择
（`src/main/java`/`pom.xml`/`pyproject.toml`/`package.json` 等 tier-1 信号优先，扩展名计数回退），
偏好序 `IU > PY > WS > PC`（Java: IU；Python: PY>PC；JS/TS: IU>WS）。混合仓库选覆盖语言最多者，
也可用 `semantic.ide` 显式覆盖。

jar 解析顺序：`semantic.jar` > `OPENCODE_SEMANTIC_JAR`/`SEMANTIC_JAR` > 打包资源
`resources/semantic-server/semantic-server.jar` > 开发目录 `semantic-server/build-local/`。
自动选中的 IDE 会注入 `SEMANTIC_IDE_HOME`，并参与 locator/sandbox 的按 IDE 隔离命名。

### 配置示例

```jsonc
{
  "semantic": {
    "enabled": true, // 默认 false
    // 默认只暴露 read_view（含诊断）；需要时加入 blast_radius/project_map/edit_batch/edit_transaction/verify_test
    "tools": ["read_view"],
    // 省略 command：自动发现 IDE，用其 JBR 启动 jar（推荐）
    // "command": ["<IDE>/jbr/bin/java.exe", "-Djava.awt.headless=true", "-jar", "<jar>"],
    "jar": "<可选：semantic-server.jar 路径>",
    "ide": "auto", // auto | idea | pycharm | webstorm | <安装路径>
    "ide_home": "<可选：IDE 安装目录>",
    "jdk_home": "<可选：项目 SDK/JDK>",
    "exclude": ["node_modules", "packages/*/dist"],
  },
}
```

### 分发与许可边界

- 先运行 `bash semantic-server/script/build-local.sh` 生成引擎 jar，再执行
  `bun run build:local -- --package`，jar 会放进 `win-unpacked/resources/semantic-server/`；
  对方机器只需**自己安装并授权 JetBrains IDE**，开启 `semantic.enabled` 即可（默认仅暴露 read_view，无需 JDK）。
- 显式 `semantic.command` 仍完全优先，适合自定义运行时或已有 JDK 的环境。
- 引擎**不打包、不下载、不修改** JetBrains IDE/JBR/插件，不读取授权状态；IDE 与授权均由使用者
  自行提供。IDE 安装不完整时按能力降级（`read_view` 返回 warnings），不会尝试修复。
- 详细协议与降级取舍见 `LLM-IDE-SPEC/` 与 `semantic-server/README.md`。

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
        { "agent": "explore", "prompt": "只做侦查并回报结论" },
      ],
    },
  },
  "agent_message": { "max_hop": 8, "max_body_bytes": 8192, "max_per_minute": 20, "wake_idle": true },
  "blackboard": { "max_value_bytes": 65536, "max_keys": 256 },
}
```

开关（CLI 默认关闭，桌面端默认开启）：

| 环境变量                                     | 作用                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `OPENCODE_EXPERIMENTAL_AGENT_TEAMS`          | 注册 `dispatch`/`team`/`agent_send`/`agent_inbox`/`blackboard` 与团队提示词 |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | 打开 `task` 工具的后台模式                                                  |
| `OPENCODE_EXPERIMENTAL`                      | 一次开启全部实验特性（含以上）                                              |
| `OPENCODE_DEVICE_NAME`                       | Web UI 设备标签名称；默认使用操作系统 hostname                              |
| `OPENCODE_DISABLE_PROJECT_MEMORY`            | 设为 `1` 关闭首次提示时的自动 `.opencode/memory.md` 生成                    |

---

## 快速开始（源码运行）

本仓库为私有分支，不通过 npm 分发：

```bash
bun install
bun dev              # CLI（TUI）
bun dev:desktop      # 桌面端（agent-teams UI 默认开启）
bun dev:web          # Web 版

bun run build:server # 只构建 standalone server + 内嵌 Web UI
bun run build:local  # 构建 Desktop + 内置 sidecar server + Web UI

# Desktop 可选：--package 仅打包 win-unpacked（本地部署用）；--installer 额外产出 NSIS 安装器；--deploy <dir> 覆盖部署到运行目录
```

Desktop 验证前请执行 `bun run build:local`；只用浏览器访问时执行 `bun run build:server`。两条命令的产物目录相互独立，不会互相覆盖。

### 独立 Server（浏览器 GUI）

`build:server` 产物位于：

```text
packages/opencode/dist-server/opencode-<os>-<arch>/bin/
```

默认内嵌 Web UI，启动后浏览器访问 `http://127.0.0.1:4096`；Windows 构建会把 `script/windows/` 下的启动、停止、状态和可选开机自启脚本复制到 exe 旁边。

```bash
# Windows
bun run build:server
# Linux（在 Linux 工作站上执行同一条命令）
bun run build:server
```

Linux 示例：

```bash
OPENCODE_DEVICE_NAME=linux-1g ./opencode serve --port 4096 --hostname 127.0.0.1
```

局域网访问时绑定 `0.0.0.0` 并设置 `OPENCODE_SERVER_PASSWORD`；不要把无认证端口直接暴露到公网。开机自启**默认关闭**，需要时手动运行 `enable-autostart.bat`，取消运行 `disable-autostart.bat`。

Web GUI 的项目路径选择使用 **server 端目录浏览**（`file.list`/`path.get`），不是浏览器原生文件对话框，因此 Linux workstation/headless 环境可直接选择 `/home/...`、挂载盘等 server 路径；浏览器在另一台机器时选中的仍是 server 机器路径。

### 自动项目记忆

当项目没有 `AGENTS.md`、`CLAUDE.md` 或 `CONTEXT.md` 时，首次构建 prompt 会自动生成：

```text
.opencode/memory.md
```

生成内容是**确定性的仓库元数据**，不调用模型、不读取源码：项目名、识别到的语言、常见构建/测试/lint 命令、顶层目录和工具配置文件。生成后会作为指令上下文加载。

- 只生成一次，已存在时绝不覆盖，可自由编辑。
- 只在没有现有 instruction 文件时生成，避免和 AGENTS.md 重复。
- 写文件失败只记录 warning，不阻塞对话。
- `OPENCODE_DISABLE_PROJECT_MEMORY=1` 可关闭。
- 需要更深入的项目规范时仍使用 `/init` 生成/更新 `AGENTS.md`；两者可以并存，但自动 memory 不替代人工 review。

### 按需启用 MCP

模型可以通过 `mcp` 工具按需启用已配置的 MCP server：

```text
mcp(op="list")
mcp(op="enable", name="ppt")
mcp(op="disable", name="ppt")
```

边界：

- 只允许操作 `opencode.json` 中已经存在的 MCP server。
- 不能通过该工具新增 MCP、安装包、执行任意命令或访问任意 URL。
- `mcp` 工具不负责启动外部应用；模型先用现有 shell 工具启动 Word/Excel/PowerPoint/LibreOffice 等宿主应用，再调用 `mcp(op="enable", name="...")` 连接。
- `enable` 后新 MCP 的工具在下一轮模型请求中可用；当前轮不会热插拔。
- 沿用现有权限配置，不新增权限 key。
- 已禁用的 MCP 可以在运行时临时启用，不会改写配置文件。
- 如果宿主应用使用动态 port/token，需要 bridge 更新配置或重启实例后重新连接。

### 设备标签

server 的 `/global/health` 与 `/api/health` 返回：

```json
{ "device": { "name": "linux-1g", "platform": "linux", "hostname": "build-01" } }
```

Web UI 的服务器列表和 Settings → Servers 会显示设备标签。默认名称是 hostname，可用 `OPENCODE_DEVICE_NAME` 覆盖，例如 `OPENCODE_DEVICE_NAME=linux-1g`。

语义引擎为可选能力：安装并授权 JetBrains IDE 后，在 `opencode.json` 设置
`"semantic": { "enabled": true }`（默认只暴露 `read_view`，其余工具用 `semantic.tools` 开启）；未配置 `command` 时自动发现 IDE 并用其 JBR 启动，
无需系统 JDK。语言支持与降级见下文「语义引擎」。

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

1. 修改完成后运行对应构建：Desktop/Web 用 `bun run build:local`，独立 server 用 `bun run build:server`；两者都会在仓库根 **`BUILD.md`** 追加一行（时间、Build ID、提交、本次更改、构建标记）。若手工构建，也必须手动追加说明。
2. 运行时核对两端标记：
   - 服务端：启动日志出现 `server listening build=<id>`，`GET /global/health` 返回 `build` 字段；
   - GUI：Agent Teams 窗口页头显示 `build <id>`；
   - 两者不一致时 GUI 会显示警示条——此时先重新构建（`bun run build:local`），再复验，禁止用旧客户端验证新改动。
3. `BUILD.md` 是唯一权威记录：同一「提交 + dirty 状态」只保留一行；排查“改动不生效”时，先对照这里的标记与正在运行的版本是否一致。

详见 `specs/build-markers.md`。

---

## 仓库结构

| 路径                                     | 内容                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/opencode`                      | 核心运行时、会话、工具（`dispatch`/`team`/`agent_send`/`agent_inbox`/`blackboard`…） |
| `packages/core`                          | 服务层：`BackgroundJob`、mailbox、blackboard 存储、配置 schema                       |
| `packages/app`、`packages/desktop`       | Web/桌面 UI（Agent Teams 窗口与面板）                                                |
| `script/windows`                         | 独立 server 的 Windows 启动/停止/状态与可选开机自启脚本（默认不自启）                |
| `packages/schema`、`packages/session-ui` | 事件协议与共享会话 UI                                                                |
| `semantic-server`                        | 无头 JetBrains IDE 语义守护（协议实现、fixtures、探针、conformance）                 |
| `LLM-IDE-SPEC`                           | 语义引擎设计：传输、多语言/IDE 选择、对账、LSP 路线                                  |
| `specs/`                                 | 中文设计文档（见下）                                                                 |

## 设计文档

- `specs/agent-teams.md` — 团队派发/消息/黑板的总体设计
- `specs/agent-teams-management.md` — `team` 工具、完成唤醒、看门狗与上下文预算
- `specs/agent-teams-delivery.md` — 投递可靠性：队列入队、可靠唤醒、取消解耦
- `specs/agent-teams-permissions.md` — 团队场景的权限模型
- `specs/agent-teams-prompt-awareness.md` — 提示词注入策略
- `specs/agent-teams-backlog.md` — 后续计划（任务板、广播、成员超时等）
- `specs/independent-maintenance.md` — 独立维护：切断上游运行时/构建时联系
- `specs/build-markers.md` — 构建标记：`BUILD.md` 记录、GUI/服务端双标记与不匹配告警
- `LLM-IDE-SPEC/main.md` — 语义引擎总体架构与工具契约
- `LLM-IDE-SPEC/multilang.md` — 多语言支持、IDE 自动发现/选择与发行闸门
- `LLM-IDE-SPEC/context-reconciliation.md` — 读时对账、编辑版本戳与会话 ledger/fold
- `LLM-IDE-SPEC/tcp-transport.md` — TCP + locator + hello 传输契约
- `semantic-server/README.md` — 语义守护运行、sandbox、探针与降级说明

---

## 独立维护声明

- 本仓库独立维护：不跟踪上游、不下载官方 CLI、不检查官方更新、不执行官方升级；桌面端、独立 server 与 CLI 的代码一律来自本仓库构建（`build:local` / `build:server`）。
- 升级方式只有一种：`git pull` 本仓库后重新构建。`opencode upgrade` 在该分支会被明确拒绝。
- 仅保留必要的开源许可与版权声明（见 [LICENSE](LICENSE)，MIT）；其余与上游发行渠道的关系均已移除。
