# MVP Spec：IntelliJ 语义引擎 + OC 渲染层

# OpenCode 语义引擎：项目总领

## 一句话

为 OpenCode 补上类 IDE 的代码智能能力：剥离 IntelliJ 的语义引擎作为无头守护，通过
AI 原生的渲染层，把代码空间渲染成 LLM 可导航的 token 语义视图。

## 核心判断

1. **人类和 AI 工具需求同源，分歧只在交互状态。** 不发明新功能，只把人类 IDE
   的功能翻译成有状态、token 语义的交互状态。
2. **LLM 缺失的是空间认知，不是工具。** grep
   不是不够强，是模型不知道符号在哪、文件多大、改了什么。核心是给它一个可导航的代码空间。
3. **人类软件可改造为 AI 原生，关键是重写交互模型。** IntelliJ
   剥离的不是功能，是交互假设——从交互式探索变成批量语义查询，从常驻 UI
   变成无头守护，从视觉反馈变成 token 渲染。

## 架构全景

```
人类侧（只观察，不写代码）
  ↕ 对话（结束 + 提示音 / 自然语言指令）
OC 进程（AI 原生外壳）
  ├─ 渲染层：token 语义视图
  ├─ 状态层：会话工作集、位置感、覆盖（状态全在 OC）
  ├─ 原语层：read / edit_batch / verify / map / blast_radius
  ├─ 一致性层：版本戳、写前校验、源文件纯度、路径保护
  ├─ Blackboard：多 agent 共享状态
  └─ 通知出口：主 agent 压缩 → 响铃
  ↕ JSON-RPC over TCP loopback
IntelliJ 无头守护（语义引擎，无状态）
  ├─ 适配层：blast_radius / read_view / edit_transaction / verify_*
  └─ 语义引擎：PSI / Stub 索引 / VFS / Daemon Analyzer / Refactoring API / LSP 客户端
  ↕
源文件层（磁盘真实代码，纯净，不含元语）
```

## 分层（规范性）

- **渲染层**：token 语义视图（内容 + 诊断 + 锚点 + 位置感 + 覆盖）
- **状态层**：会话级工作集、位置感、覆盖、阅读路径
- **索引层**：符号索引、项目地图、依赖、热度
- **一致性层**：版本戳、失效、源文件纯度校验
- **源文件层**：磁盘真实代码

单向依赖，不可跨层。 **状态全在 OC，IntelliJ 无状态。**

## 已定决策

| 领域          | 决定                                                                              |
|---------------|-----------------------------------------------------------------------------------|
| IntelliJ 保留 | PSI、Stub 索引、VFS、Daemon Analyzer、Refactoring API、LSP 客户端、项目模型       |
| IntelliJ 放弃 | 全部 UI 模块                                                                      |
| IntelliJ 改造 | 交互式 → 批量语义查询；无状态；索引期间等待                                       |
| 连接          | JSON-RPC over TCP loopback                                                         |
| 生命周期      | 常驻 + 自动拉起，单项目，空闲 30 分钟退出                                         |
| 工具暴露      | 新工具可见；旧工具隐藏但注册表保留；`map()` 内置只读按需揭示；**绝不转发**        |
| map 返回      | 坦白（一直存在，被隐藏）→ 定义 → 标签（简单粗暴）                                 |
| edit_batch    | 单文件多区域，文本锚点，失败数据驱动升级                                          |
| 跨文件事务    | 不做，第一版单文件                                                                |
| verify_syntax | 嵌入 read，行内诊断                                                               |
| verify_test   | bash 透传 + 结果解析                                                              |
| verify_smoke  | 第一版不做                                                                        |
| 路径保护      | .venv 等硬拒绝，定义在写路径入口                                                  |
| 通知          | 子 agent post 黑板 → 主 agent 推理 → 响铃；主 agent 唯一出口                      |
| 预热          | 进度条类似 IDEA“正在分析项目...”，完成后消失；可提问并排队；失败降级文本层 + 响铃 |
| 打包          | 完整 JBR，不带 UI 模块，语言服务器按需加载；总体积 1–1.2GB                        |

## 文件索引

| 文件                   | 内容                     |
|------------------------|--------------------------|
| `main.md`              | 本文件，总领             |
| `intellij-headless.md` | IntelliJ 无头守护骨架    |
| `adapter-layer.md`     | 适配层，`read_view` 实现 |
| `jsonrpc-channel.md`   | JSON-RPC 通道            |
| `oc-render-layer.md`   | OC 渲染层                |
| `warmup-progress.md`   | 预热进度条               |

## 实现顺序

```
1. intellij-headless 骨架 + ping
2. jsonrpc-channel（OC 客户端 + IntelliJ server）
3. adapter-layer 的 read_view    ← 核心验证点
4. oc-render-layer
5. warmup-progress
```

**MVP 验收**：OC 启动 IntelliJ 守护 → 进度条 → 预热完成 → 调 `read_view` → 得到
token 语义视图。

跑通 `read_view` 是关键——它验证 IntelliJ
语义引擎、适配层、JSON-RPC、渲染层四层。跑通了，其他原语都是同一模式的复制。

## 留口未做

并发写、回滚撤销、权限边界（网络/系统命令/敏感文件）、会话边界、成本预算、人类主动叫停、审计日志。

## 关键约束

- **源文件纯度**：元语（诊断标记、锚点、位置感）绝不进源文件；写路径校验内容纯度
- **一致性**：读带版本戳，写前校验，不匹配则拒绝并回注最新内容；不做文件系统主动监听
- **降级路径**：语义层优先，文本层兜底；降级由引擎判断，不由模型判断
- **缓存友好**：system prompt 和 tools/list 不变；`map()` 按需揭示定义，进对话历史不改进
  system prompt

## 设计溯源

本架构源于一次从“工具调用是 AI 的点击”出发的讨论，逐步收敛到三条核心判断，并以
OpenCode 全量对话数据（52,600 次调用 / 366 会话）为验证依据。关键数据发现：

- read 占 58% 结果字符，37.4% 被截断，42.6% 花在翻页链上
- search pattern 97.4% 一次性，试探性探索为主
- edit 链 5,960 对，同文件 disjoint 76.8%
- bash 占 35.2%，其中 29.1% 是可用语义原语吸收的容器开销

**MVP 验收标准**：OC 能启动 IntelliJ 守护进程，看到进度条，预热完成后调用
`read_view`，得到 token 语义视图。
