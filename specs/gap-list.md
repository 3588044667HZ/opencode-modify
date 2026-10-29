# 语义引擎与产品化缺口清单（交接文档）

用途：给维护代理的任务清单，按优先级排列；每条只记 **目标 / 现状 / 方向 / 验收 / 依赖**。
范围：仅列 `specs/agent-teams-backlog.md` **未覆盖**的缺口。已列入 backlog 的项
（per-member model、hooks、子代理 checkpoint、inbox 未读、blackboard 增强、取消/重试、通知、
权限体验、动态 model 列表、聚合预算、i18n、刷新机制、沙箱、审计托管、发布流程、生态）不重复。

边界（长期有效，沿用 backlog 纪律）：
- 不新增服务端多 agent 能力（无集群调度、无跨进程/跨机器所有权、无服务端唤醒）；
- 不碰 auth 多 key、provider-clone、bun.lock；
- 新增 i18n key 必须同批处理 62 语言（`bun run translate:app`）或先用零新增 key 的方案；
- 发布动作只在里程碑执行；修改代码后运行 `bun run build:local` 同步两端构建标记。

---

## G1 — 语义引擎暴露策略（P0，杠杆最大）

- **目标**：让已实现但默认关闭的差异化能力（`edit_batch` / `edit_transaction` / `blast_radius`）对普通用户生效，而非停留在"需显式开启"。
- **现状**：`packages/opencode/src/tool/registry.ts:239` 默认 `semantic.tools = ["read_view"]`；`edit` / `write` / `apply_patch` 与语义引擎互相独立；A/B 结论"仅 read_view+diagnostics 有净收益"导致其余工具闲置。
- **方向（任选或组合）**：
  a. `semantic.preset` 档位（`lite` = read_view / `standard` = +blast_radius+diagnostics / `full` = +edit_batch+edit_transaction+verify_test）；
  b. 让 `edit` / `write` / `apply_patch` 在内部透明走 `edit_batch`（模型无感知，用户获得原子写+诊断增量+版本对账）；
  c. 编辑确认 UI 内联展示 `blast_radius` 影响面（affected_files / 入口 / 测试）。
- **验收**：默认配置下一次普通编辑写入具备原子性（失败自动回滚），GUI 编辑确认框展示影响面；档位切换有配置测试。
- **依赖**：无（能力已实现）。

## G2 — 主会话文件级 rewind（P0，高频痛点）

- **目标**：用户可撤销"上一次编辑事务"，效果等价 Claude Code 的 `/rewind` + fileHistory 快照。
- **现状**：`edit_transaction` 有 journal 崩溃恢复（服务端粒度），但无用户视角的 undo UI/命令；主会话无文件快照机制；backlog P0-3 只覆盖子代理 checkpoint。
- **验收**：GUI/TUI 提供"撤销上次编辑事务"操作（列出受影响文件、恢复前内容）；与 journal 对齐（崩溃后仍可恢复）；有单测覆盖部分失败回滚。
- **依赖**：G1-b（若编辑走 edit_batch/transaction 则天然可用）。

## G3 — 敏感信息拦截（P0，多代理安全底线）

- **目标**：阻止密钥/凭据经 shell 命令、`agent_send`、`blackboard` 泄露（对照 Claude Code `bashPermissions.ts:402` 的敏感变量保护）。
- **现状**：shell 工具无敏感变量拦截；子代理消息与黑板无内容检查。
- **验收**：命令参数/消息/黑板值命中 `sk-*`、`ANTHROPIC_*`、`AWS_*KEY*` 等模式时警告或拒绝；有 bypass 开关；测试覆盖。
- **依赖**：无。

## G4 — 系统上下文可见性（P1）

- **目标**：暴露 `CONTEXT.md` 设计的运行态（Context Source 列表、当前 Epoch、last admitted、Unavailable 状态、上次 mid-conversation 更新）。
- **现状**：Registry/Epoch/Reconciliation 机制完整但无任何只读出口（对比 Claude Code `/context`）。
- **验收**：只读命令/面板（TUI 命令 + GUI 面板）展示上述数据；不触发重渲染副作用；有快照测试。
- **依赖**：无。

## G5 — verify_test 的 UI 集成（P1）

- **目标**：测试执行结果面板化：结果树、失败用例跳转、单测重跑。
- **现状**：服务端六框架解析已实现，工具可被模型调用，但无 UI 呈现。
- **验收**：GUI 测试结果卡片（通过/失败/跳过、耗时、失败堆栈跳转）；TUI 有对应渲染；fixtures 覆盖。
- **依赖**：G1（工具默认可用性）。

## G6 — 图片输入侧产品化（P1）

- **目标**：用户粘贴图片时给出可用路径（DeepSeek 无视觉输入）。
- **现状**：`markdown-image` 只解决"渲染侧显示本地图片"；输入侧无策略。
- **验收**：粘贴图片时明确提示"当前模型不支持图片输入"，提供可选旁路（OCR/视觉模型转文字描述）；不影响已有附件流程。
- **依赖**：provider 能力探测（vision 支持标记）。

## G7 — 多会话并行与远程访问（P2）

- **目标**：GUI 多主会话标签；远程/手机浏览器访问（PWA + 认证 + HTTPS）。
- **现状**：Agent Teams 只管理树内子会话；app/server 架构具备条件但未产品化远程访问。
- **验收**：GUI 可同时打开多个主会话并切换；远程访问有认证与只读/可写模式；文档说明安全边界。
- **依赖**：无（架构已支持）。

## G8 — 全局成本仪表盘（P2）

- **目标**：会话/团队/周期维度的成本视图（backlog P0-4 只覆盖 per-member）。
- **现状**：SQLite 中 provider cost 数据现成（usage 已记录），无聚合视图。
- **验收**：面板/命令展示今日/本会话/本团队成本与 token；按模型拆分；数据来源可审计。
- **依赖**：P0-4（per-member cost）。

## G9 — 语义引擎健康引导（P2）

- **目标**：首次使用/异常时的产品化引导：IDE 未安装、授权无效、项目语言不支持、索引失败。
- **现状**：有 warnings 字段、预热条、`reinstall or repair` 错误文案（W6），但无检测→提示→跳转安装的完整流程。
- **验收**：检测到不可用时展示原因 + 一键跳转安装/修复指引；不阻塞主流程；覆盖 Java/Python/JS-TS 三语言。
- **依赖**：无。

## G10 — Desktop Shell 来源切换（P1，备忘）

- **目标**：Windows 桌面端提供全局 Shell 来源选择，可在 Git Bash 与 PowerShell 之间切换；设置一次后对 agent 的 shell 工具、终端/PTY 和后续新会话统一生效。
- **现状**：未实现；当前 shell 解析分散在 shell 工具与 PTY，缺少用户可见的统一来源设置。
- **方向**：
  a. Desktop 设置增加“Shell 来源”：Auto / Git Bash / PowerShell；持久化到全局 desktop 设置，不按项目覆盖；
  b. 统一解析可执行文件与参数：Git Bash 优先 `bash.exe`，PowerShell 优先 `pwsh.exe`、回退 `powershell.exe`；Auto 按可用性检测；
  c. 设置页展示实际解析路径与版本；检测失败时明确报错并回退，不静默换 shell；
  d. 新进程使用新来源；已运行 PTY 保持原 shell，重启 terminal 后生效。
- **验收**：设置切换后新开的 shell 工具/PTY 使用所选来源；路径缺失有可读错误与回退；Unix/macOS 不受影响；有设置持久化、解析与回退测试。
- **依赖**：无。

---

## 建议执行顺序

G1 → G2 → G3 → G4 → G5 → G9 → G6 → G8 → G7。
