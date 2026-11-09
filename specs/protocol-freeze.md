# 协议冻结规范（Protocol Freeze）

> 状态：生效（政策基线）
> 建立日期：2026-11-09
> 适用仓库：`E:\opencode-source`（独立维护分支）
> 文档性质：这是对公开契约的冻结政策，不是实现完成声明。未完成迁移和未发布行为见 §9；它们不因写入本文而自动冻结。
> 修订：按 §10 检查清单评审；仅文档修订也记录到 §11。

## 1. 目的与原则

本仓库不再直接 merge upstream，因此必须自己承担对外协议兼容责任。目标：

- app/desktop/TUI/SDK/plugin/IDE 语义守护可以按自己的节奏升级；
- 生成客户端可重复生成，服务端/客户端形状不会漂移；
- 破坏性变更显式、可审查、有迁移窗口。

“冻结”的含义：

- 冻结的是已经发布或已被仓库内消费者使用的对外契约：路由、字段、事件类型、错误形状、认证方式、语义引擎方法。
- 不冻结内部实现、数据库表结构、prompt 文本、UI 布局或未发布迁移中的代码。
- 冻结不等于永不变化；变化必须按 major 规则进行。

三条基本规则：

1. 单一事实来源（§3）。
2. 同一 major 内只允许加法（§4、§5）。
3. 破坏性变更必须进入新 major，并完成弃用和迁移（§7）。

## 2. 冻结范围

### 2.1 核心 HTTP API

核心 HTTP API 包括以下两部分，只要被现有客户端使用，即属于冻结面：

| 部分 | 事实来源 | 状态 |
| --- | --- | --- |
| V2 `/api/*` 路由 | `packages/protocol/src/api.ts`、`packages/protocol/src/groups/*.ts` | 冻结；`/experimental/*` 与明确标为 experimental 的组除外 |
| 仍被 app/desktop/TUI/SDK 使用的 legacy 非 `/api` 路由 | `packages/opencode/src/server/routes/instance/httpapi/groups/*.ts`、`packages/opencode/src/server/routes/instance/httpapi/api.ts` | 冻结维护；不再加新功能，只做兼容修复与迁移 |

`packages/protocol/src/api.ts` 的 OpenAPI 描述仍写 “Experimental HttpApi surface for selected instance routes.”，这是当前文档状态（§9），不改变本规范对已发布 `/api/*` 稳定行为的冻结决定；本节的 experimental 例外只适用于 `/experimental/*` 或明确以 experimental 命名的组。

至少包括以下域：

- session：`packages/schema/src/session.ts`、`packages/protocol/src/groups/session.ts`、`packages/protocol/src/groups/message.ts`，以及 legacy `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`。
- project：当前主要位于 legacy `packages/opencode/src/server/routes/instance/httpapi/groups/project.ts`；V2 仅有相关 `packages/protocol/src/groups/project-copy.ts`。在 project V2 迁移完成前，legacy 路由是稳定契约。
- provider：`packages/schema/src/provider.ts`、`packages/protocol/src/groups/provider.ts`，以及 legacy `packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts`。
- agent：`packages/schema/src/agent.ts`、`packages/protocol/src/groups/agent.ts`，以及 legacy `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts` 中的 `/agent`。
- file：`packages/schema/src/filesystem.ts`、`packages/protocol/src/groups/fs.ts`，以及 legacy `packages/opencode/src/server/routes/instance/httpapi/groups/file.ts`。

同属稳定核心的还有 `/api/health`、`/api/location`、`/api/model`、`/api/event`、`/api/pty`、`/api/permission`、`/api/question`、`/api/integration`、`/api/credential`、`/api/command`、`/api/skill`、`/api/reference` 等未标注 experimental 的公开路由。

冻结的 HTTP 元素：

- 路径、HTTP method、路径参数、查询参数、请求体字段名与类型；
- 必填/可选/可空语义；
- 成功状态码、错误状态码、响应 content-type；
- 分页 cursor 语义、排序与重复项规则（有文档者）；
- 公开的端点 identifier / group identifier（它们决定生成客户端的方法名与类型名）；
- 认证方式与认证失败行为。

不冻结：OpenAPI 描述文案、示例文案、日志文本、内部 handler 名称、实现性能。

`/experimental/*`、`packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts`、TUI 控制路由与 Pack/plugin 内部接口不属于核心冻结面。

### 2.2 SSE

冻结以下事件流：

- `GET /event`：legacy 实例事件流。
- `GET /global/event`：全局事件流。
- `GET /api/event`：V2 事件流。
- `GET /api/session/:sessionID/event`：V2 durable session 事件 replay-and-tail 流。

冻结内容：

- `Content-Type: text/event-stream`；
- SSE 帧格式：`data:` 行承载 JSON，空行结束一帧；注释/心跳可被忽略；
- 事件 envelope：
  - legacy `/event` 与 `/global/event`：`{ id, type, properties }`，全局流外层为 `{ directory, project?, workspace?, payload }`；
  - V2 `/api/event`：`{ id, type, data, metadata?, durable?, location? }`；
  - V2 `/api/session/:sessionID/event`：`SessionEvent.Durable`，`after` 为排他 aggregate sequence，先 replay 后 tail；
- 事件 `type` 字符串是契约；不得复用为不同语义；
- 客户端必须忽略未知事件字段和心跳；未知事件类型在客户端实现 default/unknown 分支之前属于 breaking（当前 Effect client 仍会断流，见 §9）。
- 心跳间隔和连接保持实现不是契约，客户端不得依赖固定间隔。

事件清单的事实来源：`packages/schema/src/event.ts`、`packages/schema/src/event-manifest.ts`、`packages/schema/src/session-event.ts`、`packages/protocol/src/groups/event.ts`、`packages/protocol/src/groups/session.ts`；legacy 事件另见 `packages/opencode/src/server/routes/instance/httpapi/groups/event.ts`、`packages/opencode/src/server/routes/instance/httpapi/groups/global.ts` 和 `packages/opencode/src/server/event.ts`。

### 2.3 错误与认证

错误形状：

- V2 使用 tagged error JSON，通常为 `{ "_tag": "...", "message": "...", ... }`；定义在 `packages/protocol/src/errors.ts`（`InvalidRequestError`、`UnauthorizedError`、`ConflictError`、`ServiceUnavailableError`、`UnknownError`、`ProviderNotFoundError`、`SessionNotFoundError`、`MessageNotFoundError`、`InvalidCursorError`、`PermissionNotFoundError`、`QuestionNotFoundError`、`ForbiddenError`、`PtyNotFoundError` 等）。
- legacy 使用 `NamedError` 形状 `{ "name": "...", "data": { ... } }`；映射与测试见 `packages/opencode/src/server/routes/instance/httpapi/public.ts`、`packages/opencode/test/server/httpapi-schema-error-body.test.ts`、`packages/opencode/test/server/httpapi-error-middleware.test.ts`。
- 状态码映射属于契约；例如 schema 拒绝为 400，未认证为 401，未知 500 不泄露内部堆栈。
- 客户端遇到未知 `_tag` / `name` 时必须按通用错误处理，不得崩溃或把整个响应判为解析失败。

认证：

- 未配置 `OPENCODE_SERVER_PASSWORD`（或为空）时不要求认证；
- 配置后接受 `Authorization: Basic base64(username:password)`，用户名来自 `OPENCODE_SERVER_USERNAME`，默认 `opencode`；
- 浏览器/WebSocket 升级场景接受 `?auth_token=<base64(username:password)>`，且其优先级高于 Basic header；
- 失败返回 401，并带 `WWW-Authenticate: Basic realm="Secure Area"`；
- PTY connect ticket 是已文档化的例外通道，ticket 由 `packages/protocol/src/groups/pty.ts` 和连接 handler 校验；不得把 ticket 校验扩散成通用认证旁路。

事实来源：`packages/server/src/auth.ts`、`packages/server/src/middleware/authorization.ts`、`packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`、`packages/protocol/src/middleware/authorization.ts`。

### 2.4 语义引擎 JSON-RPC

冻结的引擎协议：

- JSON-RPC 2.0 over TCP `127.0.0.1`，NDJSON 分帧；
- 每连接第一个请求必须是 `hello`，参数含 `token`；成功返回 `{ "ok": true }`；重复 `hello` 幂等；`hello` 之前调用其他方法或 token 错误返回 `-32019` 并关闭连接；
- 方法名：`hello`、`ping`、`subscribe`、`read_view`、`blast_radius`、`edit_batch`、`edit_transaction`、`project_map`、`verify_test`、`shutdown`；
- 通知：`notifications/indexing`；
- 错误码与错误语义：`packages/opencode/src/semantic/protocol.ts` 中的 `ErrorCode`、`RpcError`、`TimeoutError`、`ConnectionError`、`UnavailableError`；
- 请求/结果字段名、类型、必填/可选语义与联合判别字段；
- 结果中的 `version`、`old_version`、`new_version` 等是引擎生成的不透明版本戳，客户端不得解析其内部格式。

事实来源：

- TS 侧权威 schema：`packages/opencode/src/semantic/protocol.ts`；
- TS 调用映射：`packages/opencode/src/semantic/client.ts`；
- Java 守护：`semantic-server/src/main/java/opencode/semantic/JsonRpcServer.java` 及其 service；
- 跨实现一致性：`semantic-server/script/protocol-conformance.ts`、`semantic-server/fixtures/*`。

当前语义协议结果/错误 schema 已改为 `onExcessProperty: "ignore"`，未知结果字段会被忽略；请求侧 `VerifyTestOptions` 仍保持严格，见 §4.5 与 §9。

### 2.5 Plugin、TUI、Pack

这三者与核心协议分开治理：

| 面 | 状态 | 版本/契约 | 事实来源 |
| --- | --- | --- | --- |
| Plugin（进程内 Hooks） | 独立、非核心冻结 | 由 `@opencode-ai/plugin` 包版本管理；不承诺与核心 major 同步 | `packages/plugin/src/index.ts`、`packages/plugin/src/tool.ts`、`packages/plugin/src/tui.ts` |
| Plugin IPC | 独立、experimental | `IPC_PROTOCOL_VERSION = 1`；`initialize` 显式校验，mismatch 拒绝 | `packages/plugin/src/ipc/protocol.ts`、`packages/plugin/src/ipc/process.ts`、`packages/plugin/src/ipc/lifecycle.ts` |
| TUI | 冻结/退场，仅维护 | TUI control 路由与 `tui.*` 事件不属于核心冻结；不再新增依赖 | `packages/tui`、`packages/schema/src/tui-event.ts`、`packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts` |
| Pack | experimental | manifest `api` 与 IPC 协议独立于核心 major；`api` 目前解析但未参与强制校验 | `packages/plugin/src/pack/*`、`packages/plugin/src/pack/manifest.ts` |

Plugin/TUI/Pack 的变更不得倒逼核心协议新增字段；需要核心能力时，先按核心协议流程加可选能力，再由它们在后续版本使用。

## 3. 所有权与事实来源

依赖方向保持仓库约束：Schema -> Core/Protocol -> Server；Client 只依赖 Schema/Protocol，不能依赖 Core/Server；`sdk-next` 才组合 Client、Core、Server（见 `AGENTS.md`）。

| 产物 | 角色 | 规则 |
| --- | --- | --- |
| `packages/schema/src/*.ts` | 可序列化领域对象、事件、枚举、ID 的事实来源 | 字段、类型、判别式、事件 data schema 先改这里；`packages/schema/src/event-manifest.ts` 决定公开事件清单 |
| `packages/protocol/src/api.ts`、`packages/protocol/src/groups/*.ts` | HTTP 路由、method、payload、middleware 放置、成功/错误 union 的事实来源 | 改路由先改这里；不允许只改 server handler 或只改生成客户端 |
| `packages/protocol/src/errors.ts`、`packages/protocol/src/middleware/*.ts` | 公共错误与中间件契约 | 错误 `_tag`、状态码、认证中间件形状属于公开契约 |
| `packages/server/src/*` | V2 实现 | 只实现契约；handler 不是协议来源 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/*.ts` | legacy HTTP 路由来源 | 迁移完成前是 legacy 稳定契约；不得与 `packages/protocol` 同名端点产生不同语义 |
| `packages/client/src/contract.ts` | 客户端侧的 API 投影与命名映射 | `groupNames`/`endpointNames`/`omitEndpoints` 的变化会改变生成客户端，按 breaking 处理 |
| `packages/client/script/build.ts` | 生成器入口 | 运行 `bun run generate`；生成物见下 |
| `packages/client/src/generated/*`、`packages/client/src/generated-effect/*` | 机器生成 | 禁止手改；由 `check:generated` 校验；变更必须同批提交 |
| `packages/sdk/js/script/build.ts` | legacy JavaScript SDK 生成 | 公开 Protocol/Server HttpApi 变化后按 `AGENTS.md` 重新生成 |
| `packages/opencode/src/semantic/protocol.ts` | 语义协议 TS 事实来源 | 方法名、参数/结果 schema、错误码先改这里 |
| `semantic-server/src/main/java/opencode/semantic/*` | 语义守护实现 | 必须与 TS 协议和 conformance fixtures 一致 |
| `semantic-server/script/protocol-conformance.ts` | 语义跨实现契约测试 | 任何语义协议变更必须扩展/更新并通过 |

规则：

- 生成物与源冲突时，源是事实；生成物必须重新生成，不能反向修改生成物“修复”契约。
- `openapi.json`、OpenAPI 文档和 `packages/sdk` 是派生产物，不是独立事实来源。
- 如果文档、注释与 schema/protocol 冲突，以 `packages/schema` / `packages/protocol` 的可执行 schema 为准；发现冲突应修文档，不得两份并行维护。
- 端点 identifier、事件 `type`、错误 `_tag`/`name`、认证 header 名一旦发布，均视为公开契约，不得为了内部可读性重命名。

## 4. 开放 schema 策略

### 4.1 稳定对象默认为开放对象

对已冻结的 HTTP 响应、SSE 事件 payload、语义协议结果以及请求 payload：

- 解码时忽略未知的额外字段；
- 不得因为出现未知字段而拒绝整个请求或响应；
- 新增字段必须先在事实来源中声明为 optional，再发布；
- 服务端可以在同一 major 内新增 optional 字段、可选对象成员和新可选能力；
- 新事件类型/新 union 变体只有在所有受支持客户端具备 unknown/default 分支时才算加法，否则按 breaking 处理（当前 Effect client 尚未具备，见 §9）。

### 4.2 必填、类型和判别式保持严格

以下仍然严格校验，不得以“开放 schema”为由放宽：

- required 字段缺失；
- 字段类型不匹配、格式不合法、数值越界；
- 字符串 discriminator（`type`、`_tag`、`kind`、`role`、`status` 等）不在已知集合；
- 认证、权限、票据等安全敏感字段；
- durable event 的 `durable.version` 与事件类型组合。

未知字段忽略不等于未知语义接受。未知 discriminator 值应作为协议不兼容处理，而不是静默降级为另一个分支。

### 4.3 客户端行为

- 客户端必须忽略响应和事件中的未知字段；
- 事件消费者必须有 default/unknown 分支，并继续消费后续事件；这是冻结目标，当前 Effect client 的 SSE union 仍需补齐（见 §9）；
- 在补齐前，新增事件类型不得作为同 major 加法发布；
- 未知 `_tag`/`name` 错误按通用错误展示，保留原始 message 与状态码；
- 生成客户端目前对 JSON 只做解析不做运行时 schema 校验；不得新增“遇到未知字段就抛错”的客户端逻辑。

### 4.4 服务端行为

- 服务端新增字段必须 optional；不得在同一 major 内把 optional 改 required；
- 不得改变现有字段的含义、单位、编码或 null/absent 语义；
- 不得用未知字段承载安全决策；
- 新增事件类型可以不要求 capability，但客户端必须能忽略；如果新事件要求客户端主动行为，必须通过 capability 宣告。

### 4.5 当前实现状态

语义结果/错误 schema 已使用 `onExcessProperty: "ignore"`，新增 optional 结果字段可被旧客户端忽略；`VerifyTestOptions` 是请求侧选项契约，仍保持严格。`semantic-server/script/protocol-conformance.ts` 的原始帧 fixture 解码也已按 open-schema 对齐。

## 5. 版本协商与兼容性

### 5.1 版本模型

- 核心协议使用整数 major 编号。本文把当前稳定的对外行为记为 Core Protocol Major 1（文档基线编号）；当前代码尚未在 HTTP wire 上发送版本号（见 §9）。
- 同一 major 内只允许加法：新增 optional 字段、可选请求字段、新端点、新 capability；新事件类型/新 union 变体需客户端先具备 unknown 分支，否则按 breaking。
- 不使用 wire 级 minor 号表达加法；是否需要客户端配合由 capability 表达。
- capability 是稳定的小写点分 token（例如 `domain.feature`），只表示可选行为，不替代 major；未知 capability 必须忽略。
- 任何破坏性变化必须进入新 major，不允许通过 capability 伪装成加法。

### 5.2 HTTP 版本协商

实现落地时使用以下规范名（当前尚未实现，见 §9）：

- 请求头 `x-opencode-protocol-version: <major>`；
- 请求头 `x-opencode-protocol-capabilities: <token>[,<token>...]`；
- 响应头回显服务端选择/支持的 major 与 capabilities；
- 缺少 version 头视为 Major 1（向后兼容旧客户端）；
- 缺少 capabilities 视为空集；
- 没有共同支持的 major 时返回明确错误（400，`InvalidRequestError` 形状），不得静默降级或猜测；
- 服务端可在同一 major 内返回请求未声明的新 optional capability；客户端必须忽略未知 capability。

如实现采用不同的头名，必须先更新本文并完成评审，不能两套名字并行。

### 5.3 语义引擎版本独立

- 语义引擎协议拥有自己的版本，不从产品版本、`package.json` 版本或核心协议 major 推导。
- 产品发布可以升级语义守护 jar 而不改变核心协议 major；反之亦然。
- `hello` 的未来扩展必须是加法：可选 `protocol` 与 `capabilities` 字段；缺失视为基线 version 1、空 capability 集。
- 不支持的引擎 major 必须显式失败并关闭连接；具体 JSON-RPC 错误码在实现前登记到 `packages/opencode/src/semantic/protocol.ts`。
- 语义引擎的 breaking change 需要自己的 major、独立的兼容窗口和 `semantic-server/script/protocol-conformance.ts` 覆盖。
- 当前 `hello` 只有 `{ token }` / `{ ok: true }`，没有版本字段；这是 §9 的已知状态，不是永久契约。

### 5.4 Plugin、TUI、Pack

- Plugin IPC：`IPC_PROTOCOL_VERSION = 1` 是独立版本；`initialize` 已校验，mismatch 必须拒绝；新增 method/字段优先加法，破坏性变化必须提升 IPC 版本并给出迁移说明。
- Plugin 进程内 API：不纳入核心冻结；按 `@opencode-ai/plugin` 包版本治理，破坏性变化需要发布说明。
- TUI：按 `specs/source-map.md` 的退场决定，TUI control 路由与 `tui.*` 事件只做维护/安全修复；不得新增外部依赖，移除前按 §7 弃用。
- Pack：处于 experimental；manifest `api` 与 IPC 协议独立于核心 major。`api` 目前只解析、未强制校验（`packages/plugin/src/pack/manifest.ts`），在正式冻结前必须补齐校验；破坏性 Pack 变化必须提升 `api`/IPC 版本并提供迁移说明。
- 三者均不得要求核心协议在同一 major 内做破坏性变化来适配。

### 5.5 变更分类

| 变更 | 同 major 是否允许 | 要求 |
| --- | --- | --- |
| 新增 optional 响应字段 / 事件字段 | 是 | 客户端忽略未知字段；更新 schema + 生成物 + fixture |
| 新增 optional 请求字段 | 是 | 服务端忽略未知字段；旧客户端不发送也能工作 |
| 新增事件类型 | 条件 | 客户端 default 分支忽略；当前 Effect client 未实现时按 breaking，见 §9 |
| 新增端点 / 新 HTTP method | 是 | 更新 protocol + server + client + SDK + fixture |
| 新增 required 请求/响应字段 | 否 | 新 major |
| 删除/重命名字段、路由、事件类型 | 否 | 弃用 + 新 major |
| 改变字段类型、格式、单位、null/absent 语义 | 否 | 新 major |
| 改变 discriminator / enum 取值集合 | 条件 | 判别值变化或客户端未容忍时按 breaking；否则需 capability + 测试 |
| 改变认证方式、401/403 语义 | 否 | 新 major |
| 改变 SSE framing / 事件 envelope | 否 | 新 major |
| 改变语义方法结果必填字段/错误码 | 否 | 语义引擎新 major + TS/Java/conformance 同批 |
| 仅新增语义 optional 字段 | 是 | 结果/错误 schema 已 open-schema；仍建议 fixture/客户端同批验证 |

## 6. 契约测试

### 6.1 金标准 fixture

- HTTP：新增冻结用例的 golden fixture 放在 `packages/protocol/test/fixtures/http/`，按 `group/endpoint` 命名；SSE 帧放在 `packages/protocol/test/fixtures/sse/`，使用 `.ndjson`，一行一帧。
- 语义：沿用 `semantic-server/fixtures/<method>/{input.json,output.json}`，覆盖 `read_view`、`blast_radius`、`edit_batch`、`edit_transaction`、`project_map`、`verify_test` 等现有方法。
- fixture 必须是服务端 encode 输出或与 schema 严格一致的规范化结果；不得手写与 schema 矛盾的“理想响应”。
- 规范化 volatile 值：ID、时间戳、版本戳、绝对临时路径使用占位符（如 `<id>`、`<timestamp>`、`<version>`、`<tmpdir>`）；禁止包含密钥、token、真实用户路径。
- 至少覆盖 required 字段、optional 字段省略、optional 字段存在三种情况。

### 6.2 服务端 encode 与客户端 decode

- 服务端 encode：通过 HTTP 测试层调用真实 handler，按 fixture 比较状态码、content-type、JSON/SSE 帧；现有基础设施见 `packages/opencode/test/server/httpapi-exercise/index.ts`、`packages/opencode/test/server/httpapi-layer.ts`、`packages/opencode/test/server/httpapi-event.test.ts`。
- 客户端 decode：用生成客户端的 Promise 或 Effect 入口消费同一 fixture 对应的响应；至少验证 JSON 可解析、类型契约可编译、未知字段被保留/忽略且不抛错。客户端测试见 `packages/client/test/contract-identity.test.ts`、`packages/client/test/promise.test.ts`、`packages/client/test/effect.test.ts`。
- 错误与认证：`packages/opencode/test/server/httpapi-authorization.test.ts`、`httpapi-error-middleware.test.ts`、`httpapi-schema-error-body.test.ts`、`httpapi-public-openapi.test.ts`、`httpapi-sdk.test.ts` 必须随相关变更更新或新增。
- 生成契约一致性：`packages/client/test/contract-identity.test.ts` 已断言 server/client 生成结果一致；任何端点/identifier 变更必须通过该测试。

### 6.3 生成客户端检查

- 在 `packages/client` 下运行 `bun run generate`，提交 `packages/client/src/generated` 与 `packages/client/src/generated-effect` 的 diff。
- 在 `packages/client` 下运行 `bun run check:generated`（等价于重新生成并 `git diff --exit-code`）；不得手改生成文件。
- 公开 Protocol 或 Server HttpApi 变化后，按 `AGENTS.md` 运行 `bun run generate`；legacy SDK 变化运行 `./packages/sdk/js/script/build.ts`。
- OpenAPI 公开表面变化时，`packages/opencode/test/server/httpapi-public-openapi.test.ts` 必须覆盖新增/变化的路由、错误和 auth 文档。

### 6.4 服务端与客户端同批落地

- 任何触碰冻结面的变更，必须在同一个 PR/提交序列内完成：事实来源（`packages/schema` / `packages/protocol`）→ 服务端 handler → 生成客户端/SDK → fixtures 与测试 → 文档。
- 不允许“先合服务端，客户端下次再生成”的漂移；`check:generated` 失败即视为变更未完成。
- 语义协议变更必须在同一变更内更新 `packages/opencode/src/semantic/protocol.ts`、`packages/opencode/src/semantic/client.ts`、`semantic-server` Java 实现、`semantic-server/fixtures/*` 和 `semantic-server/script/protocol-conformance.ts`。
- 如果服务端只新增 optional 字段但仍改变 OpenAPI/生成类型，也必须重新生成；只有 `check:generated` 证明无 diff 才算不需要提交生成物。
- 测试从各包目录运行，不在仓库根运行（遵循 `AGENTS.md`）。

## 7. 弃用与移除

### 7.1 弃用

- 在事实来源中标注 `@deprecated` 或等价 annotation，并说明替代方案与计划移除的 major。
- 在 `specs/v2/schema-changelog.md` 记录 V2 schema/HTTP/SDK 变更；纯政策变更记录在本文件 §11。
- 弃用不是移除：旧字段/路由/事件在弃用期内必须继续按原语义工作。
- 弃用公告必须给出至少一个发布周期；独立维护分支的具体发布日期由维护者确定，但必须在公告中写明，且不得早于公告后的下一个 major。
- 认证、错误码、SSE framing 的弃用必须附带旧→新映射和覆盖两代行为的测试。

### 7.2 移除

- 移除只能发生在新 major。
- 移除前必须确认：旧客户端在新 server 上的兼容窗口已结束；新客户端在旧 server 上的兼容窗口已结束；迁移文档已发布；fixtures 已更新。
- durable event 的 `type` 不得复用；退役 durable event 必须保留 replay 兼容或提供数据迁移，不能只删除 decoder。`Event.durable.version` 变更按 schema 变更处理，并记录在 `specs/v2/schema-changelog.md`。
- 删除路由、字段或错误码时，必须同步删除/更新生成物、fixtures、SDK 和文档；不得留下“幽灵”生成方法。

### 7.3 迁移期望

- 同一 major 内：新 server 必须接受旧 client，新 client 必须能处理旧 server 的响应（未知字段/缺失 optional 字段均可容忍）。
- 新 major 发布后：至少保留一个发布周期的 N-1 支持；具体支持矩阵在发布说明中给出。
- 数据迁移与协议迁移分开：协议弃用不授权重置数据库；需要重置/重放时，按 `specs/v2/schema-changelog.md` 的既有格式写明影响、原因和兼容处理。
- 升级失败必须显式：版本不兼容、capability 缺失、引擎 major 不支持都返回可读错误，不做静默降级。

## 8. 非目标与例外

非目标：

- 内部模块边界、类/函数命名、日志、性能、缓存策略；
- SQLite/Drizzle 表结构与迁移细节（由 `specs/v2/schema-changelog.md` 维护，不属本协议冻结）；
- prompt 文本、模型选择、provider 上游 API、工具行为语义；
- CLI 帮助文本/终端布局、TUI 视觉与交互、Web UI 样式；
- `/experimental/*` 与 `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts` 下的实验端点；
- MCP、ACP、LSP、provider OAuth 上游协议；
- PTY 的终端字节流/WebSocket 帧细节（其 HTTP 创建、鉴权、ticket 端点属于核心冻结）；
- Plugin 进程内 API、TUI 控制面、Pack 运行时内部实现（按 §2.5 的独立策略）；
- 未发布分支上的迁移中间态。

例外：

- 当前没有经批准的冻结例外。
- 需要例外时，在本节新增表格行：范围、原因、负责人、到期日、移除条件。口头例外无效。
- 语义协议的严格解码与 open-schema 目标不一致，是待完成的实现工作（§9），不是永久例外；不得据此拒绝修复。

## 9. 当前状态与已知迁移工作（仅状态）

以下只记录 2026-11-09 核实到的现状，不构成“未完成代码已冻结”的承诺：

1. V2 与 legacy 并存：`packages/protocol/src/api.ts` 描述为 “Experimental HttpApi surface for selected instance routes.”，OpenAPI annotation `version` 为 `"0.0.1"`；legacy 路由仍在 `packages/opencode/src/server/routes/instance/httpapi/groups/*.ts`，project 等域尚未全部迁到 V2。本文冻结的是已发布/已使用的稳定行为，不冻结迁移中间态。
2. HTTP wire 暂无版本/capability 协商：`packages/protocol/src/api.ts` 只有 OpenAPI 元数据版本；请求/响应没有协议 major 头。§5.2 是待实现要求。
3. 语义 `hello` 当前只校验 token 并返回 `{ ok: true }`：`packages/opencode/src/semantic/client.ts`、`semantic-server/src/main/java/opencode/semantic/JsonRpcServer.java`；没有 `protocol`/`capabilities` 字段。§5.3 是待实现要求。
4. 语义结果/错误 schema 已使用 `onExcessProperty: "ignore"`（`packages/opencode/src/semantic/protocol.ts`）；`VerifyTestOptions` 仍严格。`semantic-server/script/protocol-conformance.ts` 的 raw fixture 解码已改为忽略未知字段，需用真实守护重跑。
5. 契约测试基础已存在：`packages/opencode/test/server/httpapi-exercise/index.ts` 与 `packages/opencode/package.json` 的 `test:httpapi` 覆盖路由演练；`packages/opencode/test/server/httpapi-*` 覆盖事件、认证、错误、SDK；`packages/client/test/contract-identity.test.ts` 覆盖 server/client 生成一致性；语义有 `semantic-server/fixtures/*` 与 `semantic-server/script/protocol-conformance.ts`。HTTP golden fixture 目录 `packages/protocol/test/fixtures/` 尚未创建，按 §6 要求新增。
6. Plugin IPC 版本为 1：`packages/plugin/src/ipc/protocol.ts`；Pack manifest 的 `api` 字段已解析但未强制校验（`packages/plugin/src/pack/manifest.ts`）；Pack 的 agent/rpc/ui adapter 尚未接入。TUI 按 `specs/source-map.md` 处于冻结/退场路径。
7. 已知迁移：V1→V2 路由迁移、open-schema 对齐、HTTP 版本协商、语义 hello 版本字段、Pack 版本校验与 adapter 接入、TUI 退场。未完成部分在落地并发布前不受本规范冻结保护。
8. HTTP 运行时：Effect client 的成功响应/已知事件字段默认忽略未知字段；但 SSE 事件 union 和 durable session event union 仍是封闭的，新增事件/判别变体会让旧 Effect client 断流或整页失败（`packages/protocol/src/groups/event.ts`、`packages/protocol/src/groups/session.ts`、`packages/schema/src/session-event.ts`）。在补 fallback 前，新增事件类型按 breaking。
9. OpenAPI/SDK：发布的 `packages/sdk/openapi.json` 仍由 Effect JSON Schema 生成 `additionalProperties: false`，严格的第三方生成客户端不会忽略新增字段。这是 open-schema 的已知对外差距；修复需在 OpenAPI transform 中递归移除该限制并重新生成 OpenAPI/SDK。
10. 语义跨实现 conformance 的 raw fixture 解码已允许未知字段；仍保留 required/type/discriminator 校验。

## 10. 未来协议变更检查清单

每次修改冻结面时逐项确认：

- [ ] 明确变更面：HTTP / SSE / 错误 / 认证 / 语义引擎 / Plugin / TUI / Pack。
- [ ] 分类：同 major 加法，还是需要新 major；是否新增 capability。
- [ ] 先改事实来源：`packages/schema`、`packages/protocol` 或 `packages/opencode/src/semantic/protocol.ts`。
- [ ] required 字段、类型、discriminator 未被放宽；没有新增 required 字段到同 major。
- [ ] 服务端新增字段为 optional；客户端忽略未知字段和未知事件的测试已覆盖。
- [ ] 更新服务端 handler 与 legacy 路由（如适用），并确认 V1/V2 语义不冲突。
- [ ] 同一变更内重新生成 `packages/client/src/generated*` 和 legacy SDK（如适用）。
- [ ] 在 `packages/client` 下运行 `bun run check:generated`，提交生成物 diff。
- [ ] 新增/更新 golden fixture：HTTP `packages/protocol/test/fixtures/`、语义 `semantic-server/fixtures/`。
- [ ] 运行相关包测试与 `bun typecheck`；语义变更运行 `semantic-server/script/protocol-conformance.ts`。
- [ ] 语义变更同批更新 TS schema、Java 守护、conformance fixture，并确认引擎版本独立。
- [ ] 需要弃用时，写 `@deprecated`、迁移映射、兼容窗口和移除 major，并记录到 `specs/v2/schema-changelog.md`。
- [ ] 更新本文件 §9（状态）与 §11（变更记录）；如新增例外，写入 §8 并给出到期日。
- [ ] 评审时确认没有手改生成物、没有只改一端、没有用未发布迁移态冒充冻结契约。

## 11. 变更记录

| 日期 | 变更 | 说明 |
| --- | --- | --- |
| 2026-11-09 | 建立协议冻结规范 | 初始政策基线；记录当前范围、所有权、open-schema、版本、测试、弃用和非目标；未完成迁移仅在 §9 作为状态记录 |
| 2026-11-09 | 对齐 open-schema 实现状态 | 语义结果/错误 schema 改为忽略未知字段；修正 SSE/union/OpenAPI 的已知差距，避免把尚未实现的未知事件容忍度写成已生效契约 |
