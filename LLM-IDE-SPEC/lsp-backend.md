# LSP 后端（契约占位，暂不实现）

## 定位

`multilang.md` 闸门表触发的备选路线：用 pyright / typescript-language-server 等开源语言服务器
替代重型 IDE 后端，用于 ① 恢复被降级的 TS 语义（W3 后 read_view 的 diagnostics/anchors 对
JS/TS 为空）；② 分发友好（MIT/Apache，无 JetBrains 授权纠缠）。本文件冻结接口与 bake-off
指标；是否实现、何时实现由数据决定。

## 原则

- **协议不变**：TCP `127.0.0.1` + `hello` 握手 + 现有方法语义（见 `tcp-transport.md`）。
  backend 是守护内部实现选择，不是新协议。
- 每语言一个语言服务器进程；生命周期由守护统一管理（stderr 日志、就绪探测、空闲回收）。
- IDE 后端保留为可选，配置形如 `semantic.backend: ide | lsp | auto`（实现时定默认策略；
  Java/Kotlin 暂留 IDE，TS/Py 候选 LSP）。
- 不打包任何 JetBrains 组件；语言服务器为开源件（pyright=MIT、tsserver/LS=Apache/MIT，
  JDT LS=EPL 备选）。

## 能力映射（初稿）

| 现有方法 | LSP 路径 | 质量预期 |
|---|---|---|
| read_view 诊断 | `publishDiagnostics`（等待 push 或 pull 模型） | 好（pyright/tsserver 原生） |
| read_view 锚点 | `textDocument/definition` 逐位置批量 | 好 |
| read_view 符号结构 | `documentSymbol` | 好 |
| blast_radius | `references` / `callHierarchy` + 入口启发式 | 中（entry/risk 降为启发式） |
| project_map | 文件/import 扫描为主（现实现本就是启发式） | 持平 |
| edit_batch / edit_transaction | 不变；锚点校验改走 definition/range | 持平 |
| verify_test | 不变 | — |

## bake-off 指标（对 `<repo>` + 本机 Python 项目）

- read_view：p50/p95 延迟（5 文件 ×3 轮）、锚点命中率（与 IDE 后端对照）、无卡死（>30s = 0）
- blast_radius：定义/callers 命中率、entry 分类可用性
- project_map：模块/依赖质量抽样对比
- 运行成本：冷启动时间、常驻内存、进程稳定性
- 前提核对：pyright（MIT）、typescript-language-server（MIT）、可选 JDT LS（EPL）

## 非目标 / 暂不决定

- 不做协议变更；不把编排前移到 OC 侧；不引入付费组件。
- 语言服务器的获取策略（随包分发 vs 用户自带 vs 首次运行下载）留到实现批次决定。
- Kotlin/Java 是否迁往 JDT LS / 官方 Kotlin LSP：待 bake-off 数据。

## 验收（实现批次，占位）

- [ ] backend 选择配置 + 能力探测（服务器缺失时清晰报错并列出候选）
- [ ] TS/Py 在 bake-off 指标上 ≥ 门槛（阈值在实现批次冻结）
- [ ] IDE/LSP 双后端可切换；协议一致性测试与 manager 测试全绿
