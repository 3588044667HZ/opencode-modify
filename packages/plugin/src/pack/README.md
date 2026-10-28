# Pack Host

Pack Host 是插件业务层与核心之间的隔离层：

```text
Pack manifest
  -> PackStore（安装 / 项目启用 / 配置 / 数据）
  -> ContributionLedger（工具、Agent、Prompt、RPC、UI）
  -> PackRuntime（子进程插件，走自有 IPC）
  -> PackHost（mount / unmount / uninstall）
```

核心只读取 Ledger 快照，不 import 插件代码。

## 使用

```ts
import { PackHost } from "@opencode-ai/plugin/pack/host"
import { FilePackStore } from "@opencode-ai/plugin/pack/file-store"
import { ProcessPackRuntime } from "@opencode-ai/plugin/pack/runtime"
import { parsePackManifest } from "@opencode-ai/plugin/pack"

const manifest = parsePackManifest({
  id: "review",
  version: "1.0.0",
  entry: "plugin.js",
  contributes: {
    tools: [{ id: "review.diff", description: "Review a diff" }],
    prompts: [{ id: "review.style", content: "Be precise." }],
  },
})

const host = new PackHost({
  store: new FilePackStore("/path/to/pack-state"),
  runtime: new ProcessPackRuntime(),
  scope: "project:<project-id>",
  project: { id: "<project-id>", directory: "/repo" },
})

await host.install({ manifest, source: "file", target: "/path/to/pack", installedAt: Date.now() })
await host.enable("review")
await host.mount()

host.contributions("tool")
host.contributions("prompt")

await host.disable("review") // 释放运行时资源，保留安装和启用数据
await host.uninstall("review") // onUnmount + onDelete + 删除命名空间数据
```

## 生命周期

- `mount()`：启动所有 enabled pack，调用插件的 `onMount`
- `unmount()`：撤销 Ledger，然后调用插件的 `onUnmount`
- `disable(id)`：卸载运行时，移除项目启用状态，不删除安装数据
- `uninstall(id)`：撤销 Ledger，调用 `onUnmount` + `onDelete`，删除安装记录和命名空间数据

`ProcessPackRuntime` 通过 `@opencode-ai/plugin/ipc/process` 启动插件，所以：

- 进程崩溃不会留下已注册贡献
- `onUnmount` 失败也会强杀进程；Host 注入 `OPENCODE_PACK_TOKEN`，插件 helper 默认校验
- `onDelete` 失败时 Host 仍然删除安装记录和命名空间数据
- 已卸载的工具调用由核心的 fallback renderer 处理，不改历史

## Store

- `MemoryPackStore`：测试、嵌入式
- `FilePackStore`：v1 简单持久化
  - `state.json`：安装、启用、配置
  - `data/<pack>/<scope>/<key>.json`：插件命名空间数据

生产环境建议把 `packs`、`pack_project`、`plugin_data` 放到核心 SQLite；`FilePackStore` 证明接口和清理语义，不替代数据库事务。

## Scope key

建议：

- 正常 git 项目：`project:<ProjectV2.ID>`
- 非 git / 无法解析项目：`dir:<absolute-directory>`

不要直接使用 `global` 或 `worktree=/` 作为项目作用域，否则所有非 git 目录会共享启用状态。

## 当前边界

- `ContributionLedger` 已提供工具、Agent、Prompt、RPC、UI 五类贡献
- 核心 ToolRegistry、Agent、SystemPrompt 的 adapter 还未接入；当前 `contributions()` 是待消费的快照
- 第三方 pack 必须走子进程；进程内插件没有安全隔离
- 卸载不会删除 session 历史或用户通过工具主动修改的文件
