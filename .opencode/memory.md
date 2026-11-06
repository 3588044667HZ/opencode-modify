# Project Memory

<!-- 手工维护的长期纪律。OpenCode 不会覆盖此文件。 -->

## 沟通

- 默认使用中文回复；代码注释用中文，标识符和技术术语保留英文。
- 默认简洁直接；涉及设计取舍、迁移影响或风险时展开说明。
- 未明确要求时，不自动提交、不推送、不创建 PR。

## 模型

- 使用单一强 reasoning 模型；禁止按任务分层、路由或静默降级到弱模型。
- `Max` 表示该模型最高推理预算，不是切换到另一个模型。
- 简单问答可使用 DeepSeek 网页；编码任务不因此自动降级。

## 产品与架构

- 目标是 server-first：无头工作站常驻 OpenCode server，系统浏览器访问 GUI；Desktop 可选。
- 轻薄本通过 MCP over Tailscale 暴露客户端工具；server 名用 `laptop`，工具自动形成 `laptop_*` 前缀；工作站本地内置工具仍是 `shell`。
- 远程通用 shell 是主能力，首选 `DesktopCommanderMCP + supergateway + tailscale serve`；adb 等设备命令通过通用 shell 执行，不做 adb 专用工具。只有需要持久 PTY/流式 I/O 的交互式终端才考虑独立终端能力。
- 远程 MCP 只允许 Tailscale/TLS/token 访问，禁止公网裸奔；危险命令必须确认并审计。
- MCP 工具只操作 `opencode.json` 中已配置的 server，不新增 server，不执行模型提供的任意 URL/命令；启动宿主应用由模型调用现有 `shell` 工具完成。
- 安装保持解压即用；开机自启默认关闭；权限模型保持现状，不新增 MCP 权限 key。
- 自动项目记忆只做确定性生成，不调用模型；不覆盖已有 `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md`。

## 工程

- 不直接 merge upstream；保持源码可控，改动以可审查的小步提交为主。
- 测试从包目录运行，不在仓库根运行；类型检查使用 `bun typecheck`。
- 遵循仓库现有代码风格和构建方式；提交使用 conventional commits。
- 代码变更后按需更新 `BUILD.md` 构建标记。
- 不把密钥、密码、token 或部署凭据写入 memory、源码或提交历史。
