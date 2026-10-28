# 源码地图（维护用）

用途：在放弃 TUI、放弃 merge 官方之后，快速回答三个问题：

1. 我要改的东西在哪个包？
2. 这个包依赖谁、谁依赖它？
3. 改完要跑什么、会不会碰协议/生成代码/Java 守护？

原则：**先看依赖方向，再看运行时拓扑，最后看具体流程。** 不要从 `packages/opencode/src` 里乱翻。

---

## 1. 顶层结构

```text
packages/
  schema/       协议与领域类型（Session/Message/Part/Event/Permission/FileSystem...）
  protocol/     HTTP API 定义（HttpApi group/endpoint），server 与 client 的共同契约
  core/         V2 领域实现：session、event、project、filesystem、workspace、location
  server/       server 侧通用路由/中间件（CORS、auth、proxy、UI）
  client/       V2 生成客户端（generated / generated-effect），协议变更后重新生成
  opencode/     V1 服务端、CLI（run/serve）、工具、provider、semantic TS 侧
  session-ui/   会话渲染组件：message-part、markdown、diff、tool renderers
  app/          Web/Desktop 共用 UI：路由、设置、session 页面、LAN 设置
  ui/           通用 UI 组件、主题、i18n
  desktop/      Electron 主进程、preload、renderer 入口、sidecar、LAN 代理
  tui/          TUI（已决定冻结/退场，不再作为主路径）
  sdk/          JS SDK（v1/v2 generated）
semantic-server/ Java + JetBrains IDE 语义守护
specs/          设计/维护文档（本文件、gap-list、agent-teams-*、lan-access）
script/         构建/发布/翻译/基准脚本
```

### 依赖方向（硬约束）

```text
schema ─┬─> core ──────> server
        ├─> protocol ──> server
        └─> client
core/protocol ──> opencode (V1/CLI/工具)
client ──> app / session-ui / desktop
```

- `client` **不能**依赖 `core` 或 `server`。
- `session-ui` 依赖 UI、SDK 类型和少量 core 工具，不直接依赖 server。
- `desktop` 可以依赖 app/session-ui/ui；主进程不要 import renderer 代码。

---

## 2. 运行时拓扑

```text
Electron main
  ├─ sidecar（utilityProcess）
  │    └─ OpenCode server（127.0.0.1:<random>）
  ├─ LAN proxy（可选，0.0.0.0:4096）
  │    ├─ 本地 Web UI（packages/app/dist / resources/web-ui）
  │    ├─ GET /__cockpit/projects（桌面端项目列表）
  │    └─ API 转发到 sidecar
  ├─ semantic daemon（按需拉起）
  │    └─ JetBrains IDE headless + semantic-server.jar
  └─ BrowserWindow
       └─ renderer（app UI）
            └─ 通过 preload 的 window.api 访问桌面能力
```

- 桌面端默认 sidecar v1；`OPENCODE_SIDECAR_V2=1` 时走 `background-cli` 的 v2 daemon。
- 语义守护只在首次语义请求时拉起；每个项目/IDE 一个 sandbox。
- LAN 访问不直接暴露 sidecar，而是经过 `lan-proxy.ts`。

---

## 3. 核心流程

### 3.1 会话执行

```text
app prompt
  → client /api/session/:id/prompt
  → server session handler
  → core SessionV2.prompt（持久化 session_input）
  → SessionExecution.wake(sessionID)
  → SessionRunner / llm.stream
  → tool calls
  → ToolRegistry / tool.execute
  → event stream → app/session-ui 更新
```

V1 路径仍在 `packages/opencode/src/session`（`prompt.ts`、`processor.ts`、`llm.ts`）。
V2 路径在 `packages/core/src/session`（`runner/`、`execution/`、`projector.ts`）。

**改会话循环前先确定你改的是 V1 还是 V2。** 两边不要同时改，除非你明确在迁移。

### 3.2 工具

```text
packages/opencode/src/tool/registry.ts
  ├─ Effect.all({ ... Tool.init(...) })
  ├─ semanticTool(...) 过滤 semantic.tools
  └─ base[] 组装模型可见工具
packages/opencode/src/tool/<name>.ts
  └─ Tool.define(id, Effect<Def>)
packages/session-ui/src/components/message-part.tsx
  └─ ToolRegistry.register({ name, render })
```

- `hide: true` 只影响模型可见列表，不影响调用解析。
- `fallback_option_direct` 会把隐藏的 edit/write/apply_patch 暴露给模型。
- 新工具必须同时考虑：注册、权限、渲染、测试、prompt 描述。

### 3.3 Markdown 渲染

```text
session-ui/markdown.tsx
  ├─ markdown-stream.ts（流式切块）
  ├─ markdown.worker.ts（marked + shiki）
  ├─ markdown-cache.tsx（DOMPurify + 缓存 + 本地图片 data-local-image）
  ├─ markdown-image.ts（本地图片路径识别 + blob URL）
  └─ markdown-projection.ts / markdown-code-state.ts
```

本地图片流程：marked 生成 `<img src>` → DOMPurify 前把本地路径移到 `data-local-image` 并移除 `src` → `createMarkdownImages` 通过 `readImage` 读文件 → blob URL 写回 `src`。

### 3.4 语义引擎

```text
opencode/src/tool/read-view.ts
  → opencode/src/semantic/manager.ts
  → opencode/src/semantic/client.ts（TCP + JSON-RPC）
  → semantic-server Launcher（选择 IDE/JBR）
  → semantic-server.jar（JetBrains headless）
  → ReadViewService / BlastRadiusService / EditBatchService / EditTransactionService
```

- `semantic.enabled` 默认 false；`semantic.tools` 默认 `["read_view"]`。
- 具体能力：Java/Python 走 PSI；JS/TS 语法级降级。
- 大文件保护：`ReadViewService` 超过 5MB 直接返回 `fileTooLarge`，调用方回退普通 read。
- JVM 参数：`-Xmx${OPENCODE_SEMANTIC_HEAP_MB:-2048}m`、`-Xss16m`、`-XX:+ExitOnOutOfMemoryError`。
- 改 Java 后必须重建 jar；运行中的守护会锁住旧 jar。

### 3.5 Agent Teams

```text
tool/dispatch.ts / task.ts / team.ts
  → 子会话 sessionID
  → SessionExecution / SessionRunner
  → 成员工具调用
  → dispatch metadata（tokens/model/status）
  → app 的 team 面板 / blackboard / inbox
```

- 由 `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` 控制注册。
- 预算单位是 tokens（`budget_tokens`）；per-member cost 仍是 backlog。
- 团队能力不要下沉到 session 核心；它是上层编排。

### 3.6 桌面 LAN 访问

详见 `specs/lan-access.md`。

```text
settings-v2/lan-access.tsx
  → platform.lanAccess.get/set
  → preload window.api.lanAccess
  → ipc.ts lan-access-get/set
  → desktop/main/lan.ts（设置/生命周期）
  → desktop/main/lan-proxy.ts（0.0.0.0 → 127.0.0.1 sidecar）
```

### 3.7 桌面设置 / IPC

```text
app: settings-v2/*
  → platform.tsx（可选能力）
  → desktop/preload/index.ts（window.api）
  → desktop/main/ipc.ts（ipcMain.handle）
  → desktop/main/<feature>.ts
```

新增桌面能力时，四个地方必须同步：`ipc.ts`、`preload/types.ts`、`preload/index.ts`、`renderer/index.tsx` / `platform.tsx`。

### 3.8 Pack / 插件

详见 `specs/plugin-development.md`。

```text
config directory /packs/<id>/pack.json
  → opencode/src/pack/pack.ts（发现、MemoryPackStore、自动 enable）
  → @opencode-ai/plugin/pack/host（PackHost + ContributionLedger）
  → @opencode-ai/plugin/pack/runtime（ProcessPackRuntime）
  → @opencode-ai/plugin/ipc（JSON-RPC / stdio / MessagePort）
  → session/prompt.ts（当前只消费 prompt 贡献）
```

边界：

- Prompt 贡献：已进入 V1 system 数组。
- Tool / Agent 贡献：仅在账本中，核心尚未消费。
- Web RPC / UI 贡献：尚未实现。
- 卸载：`PackHost` 撤销账本、调用 `onUnmount`/`onDelete`、清理命名空间；不删除 session 历史。
- 产品内发现目前自动 install + enable；只放可信 pack。

---

## 4. Fork 变更地图

| 变更 | 主要文件 | 备注 |
|---|---|---|
| `output` 工具 | `packages/opencode/src/tool/output.ts`、`tool/registry.ts`、`session-ui/message-part.tsx` | 只打印文本，不做动作；GUI 用 Markdown 渲染 |
| Markdown 本地图片 | `session-ui/markdown-image.ts`、`markdown-cache.tsx`、`markdown.tsx`、`app/utils/markdown-image.ts` | 相对/绝对/`file://` 路径 |
| LAN 访问 | `desktop/main/lan*.ts`、`desktop/main/ipc.ts`、preload、app `lan-access.tsx` | 静态 Web UI + 项目列表 + API 代理；见 `specs/lan-access.md` |
| Pack / 插件 IPC | `packages/plugin/src/ipc/*`、`packages/plugin/src/pack/*`、`opencode/src/pack/*` | 自有 JSON-RPC、生命周期、账本、子进程宿主；prompt 已接入，见 `specs/plugin-development.md` |
| Web UI / 项目播种 | `packages/app/src/context/global.tsx`、`packages/desktop/src/main/lan.ts`、`build-local.ts`、`electron-builder.config.ts` | 新浏览器从服务端 `/project` + LAN `/__cockpit/projects` 播种项目，覆盖非 git 目录；LAN 代理服务本地 `app/dist` |
| shell 语法解析降级 | `opencode/src/tool/shell.ts` | tree-sitter 失败 → 整条命令权限确认 |
| read_view 大文件保护 | `semantic-server/.../ReadViewService.java`、`opencode/src/semantic/protocol.ts`、`tool/read-view.ts` | `fileTooLarge` 回退普通 read |
| JVM 加固 | `semantic-server/.../Launcher.java` | `-Xss16m`、可配 heap、OOM 退出 |
| auth readonly 修复 | `opencode/src/auth/index.ts` | `Schema.mutable(Schema.Array(ApiKey))` |
| Window.api 冲突修复 | `packages/app/src/app.tsx` | 本地 `DesktopWindowAPI` 断言，避免与 desktop env.d.ts 合并冲突 |
| 语义默认收窄 | `tool/registry.ts`、config | 默认 `read_view`，其余需 `semantic.tools` |
| 隐藏直接编辑工具 | `tool/edit.ts`、`write.ts`、`apply_patch.ts`、`fallback-option-direct.ts` | 模型先取 fallback 才能直接用 |

---

## 5. 常见改动索引

### 加一个内置工具

1. 新建 `packages/opencode/src/tool/foo.ts`，`Tool.define`。
2. `tool/registry.ts`：`const foo = yield* FooTool`，加入 `Effect.all` 和 `base`。
3. 决定是否受 `semantic.tools` / flags 控制。
4. `session-ui/message-part.tsx` 注册 renderer（否则落到 GenericTool）。
5. 加 `packages/opencode/test/tool/foo.test.ts`（需要 Instance/Truncate/Agent 的用 `testEffect`）。
6. `bun typecheck` + `bun test`。

### 加一个配置项

1. `packages/core/src/v1/config/config.ts`（或对应 config 模块）。
2. 如需 V2 schema，同步 `packages/schema` / `packages/protocol`。
3. `packages/opencode/src/config` 读取。
4. 文档 / 测试。

### 加一个设置项 / 面板

1. `packages/app/src/context/settings.tsx`（持久化）。
2. `components/settings-v2/general.tsx` 或对应 tab。
3. i18n：优先复用现有 key；新增 key 至少补 en/zh。
4. 测试/Storybook（如果附近有）。

### 加一个桌面能力

1. `desktop/main/<feature>.ts`。
2. `desktop/main/ipc.ts`：注册 handler + 输入校验。
3. `desktop/preload/types.ts` + `preload/index.ts`。
4. `desktop/renderer/index.tsx` 注入 `Platform`。
5. `app/context/platform.tsx` 加可选类型。
6. app UI 用 `platform.<feature>`，Web 端保持 undefined。

### 改协议 / API

1. `packages/protocol/src/groups/*`。
2. `packages/schema`（如类型变化）。
3. `packages/client` 执行 `bun run generate`（不要手改 `src/generated*`）。
4. server handler / client 调用方。
5. 回归 `packages/opencode`、`packages/app` typecheck。

### 改 Markdown

1. 解析/高亮：`markdown.worker.ts`、`markdown-stream.ts`。
2. 安全/缓存：`markdown-cache.tsx`。
3. 本地资源：`markdown-image.ts` + app 的 `readImage`。
4. 组件生命周期：`markdown.tsx`（不要在 effect 外创建 images）。

### 改语义引擎

1. Java：`semantic-server/src/main/java/opencode/semantic/*`。
2. TS 契约：`opencode/src/semantic/protocol.ts`、`client.ts`、`manager.ts`。
3. 工具：`tool/read-view.ts`、`edit-batch.ts`、`edit-transaction.ts`、`blast-radius.ts`、`project-map.ts`、`verify-test.ts`。
4. `bash semantic-server/script/build-local.sh`（关闭运行中的桌面/守护，否则 jar 被锁）。
5. 跑 `semantic-server/script/protocol-conformance.ts`、python-probe、相关测试。

### 改 Agent Teams

1. `tool/dispatch.ts`、`tool/task.ts`、`tool/team.ts`。
2. `tool/agent-send.ts`、`tool/agent-inbox.ts`、`tool/blackboard.ts`。
3. `session/blackboard.ts`、`session/run-state.ts`。
4. app 的 `agent-teams-panels.tsx`、`pages/agent-teams.tsx`。
5. flags：`OPENCODE_EXPERIMENTAL_AGENT_TEAMS`。

---


## 6. 构建 / 测试 / 发布

```bash
# 单包
cd packages/opencode && bun typecheck && bun test
cd packages/app && bun typecheck
cd packages/session-ui && bun typecheck && bun test
cd packages/desktop && bun typecheck && bun test

# 单独构建语义 jar
bun run build:semantic

# 服务端 + 桌面 GUI + Web UI + 语义 jar（默认四步）
bun run build:local

# 跳过 Web UI / 语义 jar；要求语义 jar 必须成功
bun run build:local --no-web
bun run build:local --no-semantic
bun run build:local --semantic

# 打包/部署（示例）
bun run build:local --package --deploy D:/opencode-desktop-dev
```

语义 jar 构建会先写到 `semantic-server/build-local/semantic-server.next.jar`：如果 `semantic-server.jar` 正被运行中的守护占用，就保留 `.next.jar`，打包配置会自动选择最新的 jar；关闭应用后再次构建即可激活。

每次代码改动后更新 `BUILD.md`（`build:local` 会自动追加/更新一行）。

Windows 本地打包通过 `electron-builder.config.ts` 的 `electronDist` 复用已安装的 Electron，避免每次下载 ~150MB 的 Electron zip；跨平台打包仍由 electron-builder 选择对应平台。

---

## 7. 已知债务 / 风险

| 项 | 状态 | 建议 |
|---|---|---|
| TUI | 冻结/待删 | 保留 `run`/`serve`；不要再加功能 |
| 官方 merge | 已放弃 | 每季度 cherry-pick 安全/关键修复 |
| V1/V2 双轨 | 并存 | 先冻结，选一条做 strangler 迁移 |
| 旧 layout / 旧 settings | 仍存在 | 新 layout 默认后删除 |
| 62 语言 | 仍存在 | 只维护 zh/en，其余删除 |
| 生成代码 | generated / generated-effect | 只通过 `bun run generate` |
| i18n parity | 已知红 | 新 key 至少 en/zh；不要依赖 parity 绿灯 |
| 语义 jar 锁 | Windows 常见 | 构建前退出桌面/守护；必要时生成 `.next.jar` 后替换 |
| shell 流式测试 | Windows 偶发失败 | 与本次改动无关；不要用该测试判断回归 |
| LAN 无 TLS | 设计取舍 | 只用于可信局域网；公网用 Tailscale/反代 |
| LAN UI 依赖外网 | sidecar UI 代理 app.opencode.ai | 离线环境需要本地 UI 方案 |
| Effect v4 beta | 已锁定版本 | 升级需单独评估 |

---

## 8. 维护节奏

- **每天**：把摩擦点记到 `specs/friction.md`（建议建立）。
- **每周**：`bun typecheck` + 聚焦测试 + 一次 desktop smoke。
- **每两周**：构建/部署一次，确认 `BUILD.md` 两端标记一致。
- **每季度**：依赖升级、上游安全 cherry-pick、删除一个已退役 surface（TUI/旧布局/多余语言）。
- **每次改核心**：先写清楚改的是 V1 还是 V2、是否碰协议、是否需要重新生成 client。

---

## 9. 关键文件速查

| 想找 | 文件 |
|---|---|
| 工具注册 | `packages/opencode/src/tool/registry.ts` |
| 会话循环（V1） | `packages/opencode/src/session/prompt.ts`、`processor.ts` |
| 会话执行（V2） | `packages/core/src/session/execution/*`、`runner/*` |
| 事件 | `packages/schema/src/session-event.ts`、`packages/core/src/event*` |
| 权限 | `packages/opencode/src/permission/index.ts`、`packages/app/src/context/permission.tsx` |
| 快照/回退 | `packages/opencode/src/snapshot/index.ts`、`session/revert.ts` |
| Markdown | `packages/session-ui/src/components/markdown*` |
| 工具渲染 | `packages/session-ui/src/components/message-part.tsx` |
| 桌面主进程 | `packages/desktop/src/main/index.ts` |
| 桌面 IPC | `packages/desktop/src/main/ipc.ts` |
| LAN | `packages/desktop/src/main/lan*.ts`、`specs/lan-access.md` |
| 语义 TS | `packages/opencode/src/semantic/*` |
| 语义 Java | `semantic-server/src/main/java/opencode/semantic/*` |
| 配置 schema | `packages/core/src/v1/config/config.ts` |
| 协议 | `packages/protocol/src/groups/*` |
| 生成 client | `packages/client/src/generated*`、`packages/sdk/js/src/v2/gen` |
