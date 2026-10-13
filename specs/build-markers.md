# 构建标记（Build Markers）：固定位置记录 + GUI/服务端双标记

> 状态：待实现（2026-10-13）
> 动机：多次出现"跑了老客户端/老服务端导致改动不生效"。需要每次修改后可核对：改了什么、当前 GUI/服务端是不是同一次构建。

## 1. 固定位置

- **仓库根 `BUILD.md`**：唯一权威构建记录，表格追加。列：
  `| 时间 | Build ID | 提交 | 本次更改 | 服务端标记 | GUI 标记 |`
  - `Build ID`：`<yyMMdd-HHmm>-<git short sha>[-dirty]`；
  - `服务端标记`/`GUI 标记`：均写入同一 Build ID（构建产物内嵌，运行时可见）；二者不一致 = 有一端是陈旧构建；
  - `本次更改`：自上一行记录的提交以来 `git log --oneline` 的主题拼接（无新提交时记"未提交改动"或"—"）。
- 行策略：同一 `提交 + dirty 状态` 只保留一行（重复构建只更新时间戳），避免刷屏。

## 2. 双端内嵌与可见位置

### 服务端
- 构建时注入全局 `OPENCODE_BUILD_ID`（`packages/opencode/script/build-node.ts` 的 `define`，取值 `process.env.OPENCODE_BUILD_ID`，缺省 `"local"`），参照现有 `OPENCODE_VERSION` 模式（`packages/core/src/installation/version.ts` 增加 `InstallationBuild`）。
- 可见位置：
  1. `GET /global/health` 响应增加 `build` 字段（`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`）；
  2. 服务端启动日志一行 `build=<id>`。

### GUI
- 构建时注入 `import.meta.env.OPENCODE_BUILD_ID`（`packages/desktop/electron.vite.config.ts` 的 main 与 renderer `define`，与 `OPENCODE_CHANNEL` 同模式）。
- 可见位置：
  1. Agent Teams 窗口页头显示弱化文本 `build <id>`（`packages/app/src/pages/agent-teams.tsx`）；
  2. 若 GUI Build ID 与服务端 `build` 不一致，页头显示警示条（提示 `bun run build:local` 重新构建）——这是"防误用老客户端"的核心检查；
  3. 桌面主进程启动日志一行 `gui build=<id>`。

## 3. 脚本行为（`script/build-local.ts`）

1. 计算 Build ID（时间 + git 短 sha + dirty 标记），导出 `OPENCODE_BUILD_ID` 给两次子构建；
2. 构建服务端 → 构建 GUI（现有防陈旧校验保留）；
3. 按 §1 规则更新 `BUILD.md`；
4. 不改动构建顺序与现有 `--package`/`--deploy` 行为。

## 4. 约定（写入根 AGENTS.md）

- 每次修改代码后必须运行 `bun run build:local`（自动追加 BUILD.md 行）或手工在 `BUILD.md` 追加一行说明本次更改；
- GUI 与服务端标记必须来自同一次构建；发现不一致先重新构建再验证。

## 5. 验收

- `bun run build:local` 成功后：`BUILD.md` 出现/更新对应行；`packages/opencode/dist/node/node.js` 与 `packages/desktop/out/main/chunks/node-*.js` 内均可 grep 到该 Build ID；
- 启动构建出的服务端（隔离临时数据目录 + 任意端口），`curl /global/health` 返回含 `build`；
- Agent Teams 页头可见 build 文本；两端 ID 不一致时显示警示（用 gui-only 的假 ID 或改一端 dist 验证一次即可）；
- `bun typecheck`（opencode/desktop/app）、相关 e2e 不回归；oxlint 0 error。
- 不 commit；不改动正在运行的桌面端。
