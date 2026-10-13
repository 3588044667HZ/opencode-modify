# 独立维护：切断与官方 opencode 的运行时/构建时联系

> 状态：已审计，待实现（2026-10-13）
> 背景：桌面端实测发现"代码改了但行为不变"，根因是本仓库存在多条会用官方产物覆盖本地构建的通道：
> 1. `packages/desktop/scripts/predev.ts` / `prebuild.ts` 调用 `downloadCliToResources()`，联网下载固定版本官方 CLI（`@opencode-ai/cli-*/0.0.0-next-16350`）写入 `resources/opencode-cli*`；
> 2. 直接跑 `electron-builder` 会复用陈旧的 `packages/opencode/dist/node` 与 `packages/desktop/out`（已由 `script/build-local.ts` + `build:local` 解决）；
> 3. CLI 的 `Installation.latest()/upgrade()` 会查询 npm/GitHub 官方仓库，`opencode upgrade` 会全局安装官方 `opencode-ai` 包或 curl 执行 `https://opencode.ai/install`；
> 4. electron-builder 的 beta/prod `publish` 指向 `anomalyco/opencode(-beta)`，存在被自动更新覆盖的通道（桌面更新器本身已 `UPDATER_ENABLED = false`）；
> 5. 大量上游发布/部署 workflow 与发布脚本（npm、ghcr、VS Code marketplace、Discord、docs 同步等）保留在仓库中。

## 目标

本仓库独立维护：不下载、不安装、不探测、不发布任何官方 opencode 产物；一切代码只来自本仓库构建。

## 决策

### D1 桌面端不再下载官方 CLI
- 删除 `predev.ts` / `prebuild.ts` 中的 `downloadCliToResources()` 调用；
- 删除 `scripts/utils.ts` 中 `downloadCliToResources`、`CLI_VERSION`、`CLI_BINARIES`、`getCurrentCli`、`nativeTarget`（保留 `RUST_TARGET`、`resolveChannel` 及其他仍被引用的导出）。
- 桌面端本地服务端始终来自 `packages/opencode/dist/node`（内嵌 chunk），本地构建由 `bun run build:local` 完成。

### D2 关闭官方更新通道（纵深防御）
- `electron-builder.config.ts` 删除 beta/prod 的 `publish` 配置（不生成指向官方仓库的 update feed）；
- 更新器保持 `UPDATER_ENABLED = false`（现状），并确认菜单/定时器不会触发网络检查。

### D3 CLI 升级机制本地化
- `packages/opencode/src/installation/index.ts`：
  - `latest()` 直接返回 `InstallationVersion`，不再访问 npm registry、GitHub releases、brew/choco/scoop 源；
  - `upgrade()` 一律返回 `UpgradeFailedError`，提示"这是独立维护分支，官方升级已禁用，请从源码重新构建"；
  - 删除随之失效的 schema/helper/import；保留 `method()`（仅本地命令探测）与公开导出形状。
- `src/cli/upgrade.ts` 自动升级检查因此天然失效；`opencode upgrade` 命令输出禁用原因。

### D4 切断发布/部署自动化
- 删除只服务于上游发布的 workflow（publish*/release*/deploy/containers/notify-discord/docs-*/models-snapshot/nix-*/stats/storybook 及上游 issue 机器人等），仅保留本地 CI（`test.yml`、`typecheck.yml`、`generate.yml`）；
- 删除上游发布脚本（root `script/` 与 `packages/*/script/` 中 publish/release/changelog/beta 等），并清理引用；
- 元数据 URL（repository/bugs/homepage）指向本仓库或删除。

### D5 链接与文案
- `packages/app/src/desktop-menu.ts` 的 issue/feature 链接、`packages/desktop/scripts/copy-metainfo.ts` 的 bugtracker/vcs/远程截图 URL 指向本仓库或移除；
- `packages/opencode/src/cli/cmd/github.handler.ts` 生成的 workflow 不再引用 `anomalyco/opencode/github@latest`，改为本仓库路径（并注明该 action 需由本仓库自行发布）。

### 报告但不改（需单独决策）
- `packages/app/package.json`：`ghostty-web` 来自 `github:anomalyco/ghostty-web#<commit>`（上游组织下的第三方库，需 vendor 才能完全脱钩）；`@opencode-ai/client` 使用本地 vendored tarball（`file:vendor/...tgz`，无网络）；
- `packages/console`、`packages/enterprise`、`packages/containers` 等上游云服务/发布包（不在桌面/CLI 运行路径）；
- workspace 包名 `@opencode-ai/*`、数据目录 `opencode*`（改名影响大，非"覆盖本地代码"风险）；
- `packages/opencode/src/account`、share 等指向官方控制台的功能（按需另行决策）。

## 实施拆分

| 成员 | 范围 | 文件 |
| --- | --- | --- |
| `desktop-detach` | D1、D2、D5（desktop/app 侧） | `packages/desktop/scripts/{predev,prebuild,utils,copy-metainfo}.ts`、`packages/desktop/electron-builder.config.ts`、`packages/app/src/desktop-menu.ts`、更新器确认 |
| `cli-detach` | D3、D5（CLI 侧） | `packages/opencode/src/installation/index.ts`、`src/cli/upgrade.ts`、`src/cli/cmd/upgrade.ts`、`src/cli/cmd/github.handler.ts`、`test/installation/installation.test.ts` |
| `repo-detach` | D4 | `.github/workflows/*`、root `script/*`、`packages/{opencode,cli,containers}/script/*`、相关 `package.json` 元数据 |

验收：`packages/opencode` 与 `packages/desktop` typecheck 通过（opencode 仅允许既有 `provider.ts(1467,65)`）；installation 测试更新后通过；`grep` 确认运行时/构建时路径不再引用 `anomalyco`/`opencode.ai/install`/官方 releases；`bun run build:local` 仍可完整构建。
