# Agent Teams 权限委托（事前授权 + 风险分级）

本 spec 定义 lead（主 agent）把受限文件系统权限**事前**授予被派发子 agent 的能力。
承接 `specs/agent-teams.md`，边界同样明确：**不新增任何服务端多 agent 能力**——不引入服务端团队调度、跨进程/跨机器所有权或服务端唤醒；授权只落在本地单 server 进程内的子会话权限（Session permission）上。

设计结论（与用户确认）：

1. 交互式"lead 实时批准"不是第一版目标：join 模式下 lead 的 LLM turn 被工具调用阻塞，无法应答审批，需要动唤醒语义；且 LLM 批 LLM 不构成安全边界。
2. 第一版做**事前授权**：lead 在派活时声明成员可访问的目录，权限规则随子会话创建落库，未声明的外部路径仍走人类审批。
3. 风险分级：低危（worktree 内）本就无需授权；中危（显式声明的外部目录）允许 lead 事前授权；高危永远拒绝 agent 授权、必须人类审批。
4. 审计：授权写入子会话 permission（持久化）、写入 dispatch/task 工具 metadata，面板可读。

## 1. 目标

- `task` / `dispatch` / 花名册成员新增 `autonomy` 参数，声明允许无提示访问的外部目录。
- 授权在创建子会话前校验；高危或与 deny 冲突的授权**在创建任何子会话之前**报错。
- 授权以 `external_directory allow` 规则写入子会话 permission，与现有 `assertExternalDirectory` 的 ask 流程对接（pattern 必须与 ask 的 glob 完全一致才能命中）。
- `variant: "default"` 作为显式"不加思考强度覆盖"的哨兵（关联改动，见 §5）。

## 2. 非目标

- 不做交互式 lead 审批（P2 草案见 §7）。
- 不允许 agent 产生 `always` 级别的全局批准；授权仅作用于该成员会话本身，不扩散到兄弟成员或父会话。
- 不引入新的 permission key；v1 只覆盖 `external_directory`。
- 不自动展开 `~`/`$HOME`（一律要求绝对路径，展开后的家目录属于高危，见 §3）。
- 不改人类审批默认行为：未授权的外部路径仍然弹窗由人批准。

## 3. 风险分级（v1 判定规则）

`isHighRiskAutonomyPath(path)` 为真即拒绝 agent 授权：

- 路径等于文件系统根（Windows 盘根如 `E:\`，POSIX `/`）。
- 路径等于用户家目录，或家目录的祖先（如 `C:\Users`）。
- 路径包含任一敏感目录段（大小写不敏感，按路径段比较）：
  `.ssh`、`.aws`、`.gnupg`、`.kube`、`.docker`、`.password-store`、
  `.config/opencode`、`appdata/roaming/opencode`。
- pattern 只有通配（`*`、`**`、`/` 结尾的通配等）。

中危 = 其它绝对路径（允许授权）。低危 = worktree 内（不触发 ask，无需授权）。

## 4. v1 实现契约（冻结）

### 4.1 `packages/opencode/src/tool/subagent.ts`

新增导出：

```ts
export function isHighRiskAutonomyPath(input: string): boolean

export function resolveAutonomy(input: {
  directories: readonly string[]
  rulesets: readonly PermissionV1.Ruleset[]
}): Effect.Effect<string[], Error>
```

`resolveAutonomy` 行为：

1. `directories` 为空或 undefined 时由调用方跳过（不调用）。
2. 每个输入必须是绝对路径（`path.isAbsolute`）。相对路径 → `Autonomy path must be absolute: "<p>"`。
3. 高危 → `Autonomy path is high-risk and requires human approval: "<p>"`。
4. 去重；上限 8 条 → 超出报 `Autonomy accepts at most 8 directories`；单条长度 ≤ 512。
5. 与 `rulesets`（子 agent 自身 permission + 继承后的子会话 permission）的 deny 冲突 → `Autonomy path conflicts with a deny rule: "<p>"`。判定与 `Permission.evaluate` 相同：按顺序取最后一条匹配规则（`Wildcard.match("external_directory", rule.permission) && Wildcard.match(pattern, rule.pattern)`），仅当该规则 `action === "deny"` 才拒绝；catch-all deny 被后续更具体的 ask/allow 覆盖时不阻止授权。
6. 返回规范化后的 glob 数组：`FSUtil.normalizePathPattern(path.join(dir, "*"))`（与 `tool/external-directory.ts:30-33` 生成 ask pattern 的方式保持一致，win32 用反斜杠）。

`resolveSubagentVariant` 扩展：`input.variant === "default"` 时返回 `undefined`（显式无覆盖），不做 variants 查询。

### 4.2 `createSubagentSession`

`input` 增加 `autonomy?: readonly string[]`（已规范化的 glob）。在拼装 `permission` 时，将每条转换为：

```ts
{ permission: "external_directory", pattern: glob, action: "allow" as const }
```

追加到继承规则之后（追加顺序保证 allow 覆盖 agent 默认的 `*: ask`；与继承 deny 的冲突已在 4.1 校验阶段排除）。

`input.existing`（`task_id` 续聊）路径：不新建会话，改为把尚未存在的 grant 规则追加到既有会话 permission（`sessions.setPermission`，按 permission/pattern/action 去重），避免"校验通过但授权未生效"的静默忽略。

### 4.3 `dispatch` / `task` / 花名册

- `dispatch` `Member` 增加 `autonomy: Schema.optional(Schema.Array(Schema.String))`，description 说明"显式声明的外部目录绝对路径，允许该成员无提示访问；高危路径会被拒绝，需要人批"。
- `task` `BaseParameterFields` 增加同名可选字段。
- `packages/core/src/v1/config/config.ts` 的 `team.members[]` 增加 `autonomy: Schema.optional(Schema.Array(Schema.String))`。
- 调用顺序（task 与 dispatch 相同）：解析 agent → 计算 `rulesets = [info.permission, deriveSubagentSessionPermission({ parentSessionPermission: parent.permission ?? [], subagent: info })]` → `resolveAutonomy` → 通过后才 `createSubagentSession({..., autonomy})`。
- 工具 metadata：dispatch 成员对象与 task metadata 增加 `autonomy?: string[]`（有则携带，供面板/审计）。dispatch 的 `MemberRuntime` 增加 `autonomy?: string[]`，初始值取自 resolved member，writeMetadata 输出。

### 4.4 文档

- `dispatch.txt` 增加一条 usage note（`autonomy` 语义 + 高危拒绝 + deny 优先）。
- `task.txt` 增加一条 usage note。
- 不新增 i18n key（避免 62 语言 parity 债）。

## 5. `variant: "default"` 哨兵（关联改动）

- `resolveSubagentVariant` 接受 `"default"`，返回 `undefined`（显式不覆盖推理强度）。
- dispatch `runMember` 转发逻辑改为：
  `entry.input.variant === "default" ? undefined : (entry.input.variant ?? (entry.info.model ? undefined : parentVariant))`
- task `runTask` 同理。
- 目的：lead 在自身为高思考强度（如 `max`）时可以显式让成员用模型默认强度运行。

## 6. 测试矩阵

`packages/opencode/test/tool/subagent.test.ts`（新增，纯函数单元测试）：

- `isHighRiskAutonomyPath`：盘根、家目录、家目录祖先、`.ssh`、`.config/opencode`、纯通配 → true；普通外部目录 → false。
- `resolveAutonomy`：接受绝对目录并返回规范化 glob；拒绝相对路径；拒绝高危；拒绝与 deny 冲突（构造 `{permission:"external_directory", pattern:"<dir>/*", action:"deny"}`）；catch-all deny 被后续 ask 覆盖时允许；超过 8 条报错；去重。

`packages/opencode/test/tool/dispatch.test.ts`：

- 带 `autonomy` 的成员：子会话 `permission` 包含对应 `external_directory allow` 规则；结果 metadata 成员含 `autonomy`。
- 高危/冲突授权：在创建任何子会话前失败，`sessions.children` 为 0。
- `task_id` 续聊 + `autonomy`：既有会话 permission 追加 allow 规则。
- `variant: "default"`：`ops.prompt` 收到的 `variant` 为 `undefined`（即便父 variant 为 `xhigh`）。

`packages/opencode/test/tool/task.test.ts`：

- 同上：`autonomy` 生效、metadata 携带；`variant: "default"` 不继承父 variant。

`packages/opencode/test/tool/parameters.test.ts`：`task` JSON schema 快照更新（`bun test -u`）。

验收命令（在 `packages/opencode`）：

```
bun typecheck                                  # 仅允许既有 provider.ts(1467,65) 错误
bun test test/tool/subagent.test.ts test/tool/dispatch.test.ts test/tool/task.test.ts
bun test test/tool/parameters.test.ts -u
```

## 7. P2 草案：交互式 lead 审批（不在本次实现）

- 输入：`Permission.ask` 在判定需要 ask 时先看委托策略；委托命中时发布定向事件而不是人审。
- 路由：只允许请求者**直接父会话**应答；不能跨树、不能让 root 之外的人批。
- 决策：只允许 `once`/`reject`（agent 永远不能产生 `always`）；必须带 reason；写入审计事件。
- 唤醒：join 阻塞路径不适用；只在 lead 空闲/background 模式且能安全唤醒时启用，需要 SessionExecution 配合。
- 防护：每 run 次数预算、rate limit、人类随时 veto、时间线可见。
