# OpenCode / Cockpit 插件（Pack）开发指南

> 目标读者：要在本仓库里开发、调试、集成插件（Pack）的开发者和其他 agent。
> 基准：`packages/plugin/src/ipc`、`packages/plugin/src/pack` 的当前源码与 `packages/plugin/package.json` 的 exports。本文不描述尚未实现的 API；实现与 README 的已知差异集中列在附录 A。

本文说的 **Pack** 是 `packages/plugin/src/pack` 这一套“清单 + 子进程 + 贡献账本”的插件形态。它不同于旧的 `@opencode-ai/plugin`（进程内 `Hooks`）插件，也不同于 TUI 插件。Pack 的运行时由 `ProcessPackRuntime` 启动独立子进程，通过自有 IPC 通信。

---

## 1. 当前状态与范围

### 1.1 已经实现的能力

| 能力 | 状态 | 代码入口 |
| --- | --- | --- |
| 自有 IPC：JSON-RPC 2.0、换行分隔 stdio | 已实现 | `src/ipc/protocol.ts`、`src/ipc/stdio.ts`、`src/ipc/peer.ts` |
| Worker/iframe 的 MessagePort 传输 | 已实现（传输层） | `src/ipc/message-port.ts` |
| 子进程插件宿主：握手、生命周期、超时、杀进程树 | 已实现 | `src/ipc/process.ts` |
| 插件侧生命周期：`onMount`/`onUnmount`/`onDelete`、`ctx.effect` | 已实现 | `src/ipc/lifecycle.ts` |
| Pack manifest 解析与贡献声明 | 已实现 | `src/pack/manifest.ts` |
| 安装/启用/配置/命名空间数据存储 | 已实现 | `src/pack/store.ts`、`src/pack/file-store.ts` |
| 贡献账本（tool/agent/prompt/rpc/ui） | 已实现 | `src/pack/ledger.ts` |
| Pack Host 生命周期 API | 已实现 | `src/pack/host.ts` |
| 子进程 Pack Runtime | 已实现 | `src/pack/runtime.ts` |
| 产品内发现 `packs/*/pack.json` | 部分接入 | `packages/opencode/src/pack/pack.ts:31` |
| Prompt 贡献拼进会话 system 数组 | 部分接入 | `packages/opencode/src/session/prompt.ts:1281` / `1296` |

### 1.2 尚未接入的部分

- **ToolRegistry adapter 未接入**：`tool` 贡献只是账本条目，没有注册到核心工具注册表。模型看不到这些工具，核心也无法按工具名执行它们。
- **Agent adapter 未接入**：`agent` 贡献没有进入核心 Agent 注册流程。
- **SystemPrompt Service adapter 未接入**：`SystemPrompt.Service` 没有读取 Pack。当前只有 `Pack.Service.prompts()` 的结果在 `packages/opencode/src/session/prompt.ts:1281` / `1296` 被直接拼进 `system` 数组，属于最小接线，不是完整适配器。
- **Web RPC 未接入**：`rpc` 贡献没有服务器路由暴露，也没有前端调用链。
- **UI slots 未接入**：`ui` 贡献没有渲染器、没有 slot 注册表，也没有路径校验消费方。
- **Pack 管理 UI 未实现**：没有产品内的安装/启用/禁用/卸载界面。
- **持久化未接入产品**：`packages/opencode/src/pack/pack.ts` 使用 `MemoryPackStore`，进程重启后安装/启用状态不保留。
- **`api` 与 `permissions` 未执行**：manifest 会解析这两个字段，但 Host 和 Runtime 都不检查它们。

### 1.3 不要做出的错误假设

- 不要把 pack 放进目录后就宣称“产品 UI 会自动出现工具/Agent/设置页”。**目前不会。** 工具和 Agent 贡献不会被核心消费，UI 贡献没有渲染器。
- 当前产品发现逻辑会扫描配置目录下的 `packs/*/pack.json`，并**自动 `install` + `enable` 每个发现的 pack**（`packages/opencode/src/pack/pack.ts:88-91`，enable 失败被忽略）。`enable` 会启动子进程。因此只应把可信 pack 放进这些目录；这不是一个带信任确认的安装流程。
- 不要假设 `packages/plugin` 的 README 示例之外的字段会生效。manifest 顶层是 Zod 对象，未知字段默认被剥离，不会报错。
- `onUnmount`/`onDelete` 现在会收到 mount 时的 `scope`/`project`/`config`；但不要依赖它们一定执行（进程可能崩溃或被强杀）。

---

## 2. 快速开始

> 本节先给可运行的最小结构；Manifest 细节见 §3，生命周期见 §5。

### 2.1 最小 pack 目录

```text
my-pack/
  pack.json        # 必需，Pack 服务发现时要求文件名恰好是 pack.json
  plugin.ts        # entry；由宿主进程执行（本仓库通常是 Bun）
  ui.js            # 可选；当前没有消费方
```

`target` 是 pack 根目录。使用产品内发现时，目录必须是 `<config-directory>/packs/<name>/pack.json`；手动嵌入 `PackHost` 时，`target` 可以指向任意绝对路径，不要求目录名。

### 2.2 最小 `pack.json`

```json
{
  "id": "review",
  "version": "1.0.0",
  "api": 1,
  "entry": "plugin.ts",
  "contributes": {
    "tools": [
      { "id": "review.diff", "description": "Review a diff" }
    ],
    "rpc": [
      { "id": "review.status", "method": "review.status" }
    ],
    "prompts": [
      { "id": "review.style", "priority": 10, "content": "Be precise." }
    ]
  }
}
```

说明：

- `entry: "plugin.ts"` 只在 `manifest.command` 不存在时使用，执行器默认是宿主进程的 `process.execPath`。本仓库的 opencode 由 Bun 运行，所以 `.ts` 能跑；要分发给普通 Node 宿主，用 `.js`，或显式声明 `"command": ["bun", "plugin.ts"]`。
- `tools[].id` 和 `rpc[].id` 允许点号（点号在 id 正则内）。manifest 里的工具条目**没有**“执行方法名”字段；本文示例自行约定 method 与工具 id 相同，这不是平台保证。
- `prompts[].slot` 是自由字符串；当前没有任何内置 slot 注册表。

### 2.3 最小 entry

```ts
// plugin.ts
import { createPluginPeer } from "@opencode-ai/plugin/ipc/lifecycle"
import { createStdioTransport } from "@opencode-ai/plugin/ipc/stdio"

const plugin = createPluginPeer(
  createStdioTransport({ input: process.stdin, output: process.stdout }),
  {
    onMount(context) {
      // 用 context.effect 注册的清理函数会在 onUnmount/onDelete 时自动执行
      context.effect(() => {
        // close watcher / clearInterval / abort fetch ...
      })
    },
    async onUnmount() {
      // 释放运行时资源；不要删除持久数据
    },
    async onDelete() {
      // 删除本 pack 自己的持久数据/缓存/临时文件
    },
  },
  { pluginId: "review", version: "1.0.0" },
)

plugin.peer.onRequest("review.status", () => ({ ok: true }))

plugin.peer.onRequest("review.diff", async (params, context) => {
  // context.signal 会在调用方超时/取消时 abort
  return { ok: true, params, aborted: context.signal.aborted }
})
```

约束：

- **stdout 只能写协议帧**。`console.log` 会污染协议，导致 Host 解析失败并关闭 peer。
- 日志写 `process.stderr.write(...)`。Host 只有在你显式传 `onStderr` 时才转发 stderr。
- 不要在构造 `createPluginPeer` 之前做长时间阻塞的初始化；Host 有握手超时（默认 5 秒）。

### 2.4 手动用 `PackHost` 安装/启用/挂载/卸载

```ts
// host-demo.ts
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parsePackManifest, MemoryPackStore } from "@opencode-ai/plugin/pack"
import { PackHost } from "@opencode-ai/plugin/pack/host"
import { ProcessPackRuntime } from "@opencode-ai/plugin/pack/runtime"

const target = "/absolute/path/to/my-pack"
const manifest = parsePackManifest(JSON.parse(await readFile(join(target, "pack.json"), "utf8")))

const host = new PackHost({
  store: new MemoryPackStore(),
  runtime: new ProcessPackRuntime({
    onStderr: (chunk) => process.stderr.write(chunk),
  }),
  scope: "dir:/absolute/path/to/repo",
  project: { directory: "/absolute/path/to/repo" },
  onError: (packId, error) => console.error(`[pack:${packId}]`, error.message),
})

// 1. 安装：只写 store，不启动进程、不校验 target 是否存在
await host.install({ manifest, source: "file", target, installedAt: Date.now() })

// 2. 启用：写配置（可选）-> 启动子进程 -> onMount -> 账本登记 -> 加入 enabled
await host.enable("review")

// 3. enable 已经挂载；host.mount() 只挂载其余“已启用但未挂载”的 pack
await host.mount()

console.log(host.contributions("tool"))
console.log(await host.call("review", "review.status"))

// 4. 禁用：撤销账本 -> onUnmount -> 杀进程 -> 从 enabled 移除；保留安装、配置、数据
await host.disable("review")

// 5. 卸载：撤销账本 -> onUnmount("uninstall") -> onDelete -> 杀进程 -> 删除安装记录和命名空间数据
await host.uninstall("review")
```

区分几组操作：

| 操作 | 是否改 enabled | 是否启动/停止进程 | 是否删安装记录 | 是否删命名空间数据 |
| --- | --- | --- | --- | --- |
| `install(pack)` | 否 | 否 | 否（写入/覆盖记录） | 否 |
| `enable(id, config?)` | 加入 | 启动 + `onMount` | 否 | 否 |
| `disable(id)` | 移除 | `onUnmount` + 杀进程 | 否 | 否 |
| `mount()` | 否 | 启动所有 enabled 且未挂载的 pack | 否 | 否 |
| `unmount()` | 否 | 停止所有已挂载 pack | 否 | 否 |
| `reload()` | 否 | 先全部停止，再挂载 enabled | 否 | 否 |
| `uninstall(id)` | 移除 | `onUnmount` + `onDelete` + 杀进程 | 是 | 是 |

`uninstall` **不会删除** `target` 目录里的文件，也不会删除 session 历史或用户文件（见 §9）。

### 2.5 在产品内验证的现状

`packages/opencode/src/pack/pack.ts` 会在配置目录中扫描 `packs/*/pack.json`，解析 manifest，使用 `MemoryPackStore` 安装并启用所有发现的 pack。`Pack.Service` 暴露：

```ts
interface Interface {
  readonly prompts: () => Effect.Effect<string[]>
  readonly contributions: (kind?: ContributionKind) => Effect.Effect<readonly Contribution[]>
  readonly reload: () => Effect.Effect<void>
}
```

其中只有 `prompts()` 被 `session/prompt.ts` 消费；不要把 `contributions()` 的返回误认为已经注册到核心。工具与 Agent 仍然要等适配器。

### 2.6 产品内最小接入（当前）

配置目录由 `Config.Service.directories()` 提供，通常包括全局 `~/.config/opencode` 和项目 `.opencode`。Pack 必须放在：

```text
<config-directory>/packs/<pack-name>/pack.json
```

最小的 **prompt-only** pack 不需要进程入口：

```json
{
  "id": "project-rules",
  "version": "1.0.0",
  "contributes": {
    "prompts": [
      {
        "id": "project-rules",
        "priority": 10,
        "content": "This repository uses tabs. Run the package tests before claiming success."
      }
    ]
  }
}
```

启动下一轮会话时，`Pack.Service.prompts()` 会把它包成：

```text
<pack_instructions pack="project-rules">
This repository uses tabs. Run the package tests before claiming success.
</pack_instructions>
```

当前发现逻辑会：

1. 扫描每个配置目录的 `packs/*/pack.json`；
2. 用 `MemoryPackStore` 自动 `install`；
3. 自动 `enable`（失败只记 warning，不阻塞会话）；
4. 对 prompt-only pack 使用 no-op runtime，对带 `entry`/`command` 的 pack 启动子进程；
5. 在实例 dispose 时 `host.unmount()`。

限制：

- 没有产品内 enable/disable/uninstall API 或 UI；删除目录后需要实例重建才会消失。
- 全局目录中的 pack 会对使用该全局配置的所有项目生效。
- 当前只有 prompt 被核心消费；工具/Agent/UI 仍需适配器。
- 自动启用意味着 **只把可信 pack 放进这些目录**。

---

## 3. Manifest 参考

### 3.1 顶层字段

源码：`src/pack/manifest.ts`。Zod schema 名为 `PackManifest`，解析函数为 `parsePackManifest(value: unknown): PackManifest`。

| 字段 | 类型 | 必需 | 规则与语义 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | `min(1)`，正则 `^[A-Za-z0-9._-]+$`。不能有 `/`、`:`、空白、Unicode。用于安装记录、账本、数据路径 |
| `version` | `string` | 是 | `min(1)`；不校验 semver |
| `api` | `number` | 否 | 正整数；**当前不校验、不协商** |
| `entry` | `string` | 否 | `min(1)`；相对 `target` 的入口；只在没有 `command` 时使用。声明 `tools` 或 `rpc` 时三者至少有一个 |
| `command` | `string[]` | 否 | `min(1)` 个非空字符串；`command[0]` 是可执行文件，其余是参数；不是 shell 字符串，没有 shell 解析。声明 `tools` 或 `rpc` 时必须提供 entry 或 command |
| `permissions` | `Record<string, unknown>` | 否 | 自由形状；**当前不执行** |
| `contributes` | `PackContributions` | 否 | 五类贡献；空对象/缺省合法 |

补充规则：

- 顶层未知字段会被 Zod 默认剥离（不报错）。写错字段名会静默失效，例如把 `inputSchema` 写成 `input_schema`。
- `api` 没有与 `IPC_PROTOCOL_VERSION` 关联；协议版本只在 IPC `initialize` 中校验。
- 没有 `main`、`exports`、`activationEvents`、`engines` 等字段；不要按 npm 包的直觉填写。
- `PackAgent` 是 `.passthrough()`，Agent 贡献里的额外字段会保留；其他贡献对象默认剥离未知字段。

### 3.2 贡献类型

#### tools

```ts
type PackTool = {
  id: string
  description: string
  inputSchema?: unknown
  outputSchema?: unknown
}
```

- `id`：贡献 id，规则同上。
- `description`：`min(1)`，必填。
- `inputSchema` / `outputSchema`：任意 JSON 值，不做校验；适配器自行决定如何转成核心 schema。
- **没有 `method` 字段**。当前核心未接入工具适配器；如果自行实现适配器，需要自己约定“工具 id -> IPC method”的映射。不要假设平台会自动把 `review.diff` 路由到同名方法。

#### agents

```ts
type PackAgent = {
  id: string
  description?: string
  mode?: "primary" | "subagent" | "all"
  model?: string
  prompt?: string
  [key: string]: unknown   // passthrough
}
```

- `id` 必填；其余可选。
- `.passthrough()` 会保留额外字段，但当前没有 Agent 适配器消费它们。

#### prompts

```ts
type PackPrompt = {
  id: string
  slot?: string
  priority?: number   // 整数
  content: string     // min(1)
}
```

- `content` 必填且非空。
- `slot` 是自由字符串，没有内置枚举。
- 当前产品内 `packages/opencode/src/pack/pack.ts` 的 `prompts()` 把每个 prompt 包装成：

```text
<pack_instructions pack="<packId>">
<content>
</pack_instructions>
```

并按 `priority` 降序排序（缺省 0）。它不检查 `slot`。

#### rpc

```ts
type PackRpc = {
  id: string
  method: string   // min(1)
}
```

- `method` 是插件 peer 上注册的精确 JSON-RPC 方法名。
- 账本不会自动注册或暴露方法；`host.call(packId, method)` 也不会检查该 `method` 是否在 `rpc` 贡献里。调用方/适配器需要自己校验。

#### ui

```ts
type PackUi = {
  id: string
  slot: string   // min(1)
  entry: string  // min(1)
}
```

- `slot`、`entry` 只有非空校验；**当前没有消费方**。
- `ui.entry` 没有做 `target` 逃逸检查。未来实现渲染器时必须自行做路径校验和隔离（见 §9）。

### 3.3 id 与重复规则

1. **格式**：pack id 与所有贡献 id 共用同一个正则：`^[A-Za-z0-9._-]+$`。例如 `review.diff` 合法，`review/diff`、`review:diff`、`我的工具` 非法。
2. **同一个 manifest 内、同一贡献类型内**重复 id 会在 `parsePackManifest` 抛错：
   - `Duplicate tool contribution: <id>`
   - `Duplicate agent contribution: <id>`
   - `Duplicate prompt contribution: <id>`
   - `Duplicate RPC contribution: <id>`
   - `Duplicate UI contribution: <id>`
3. **跨贡献类型**允许同名，例如 `tool: "review"` 与 `prompt: "review"` 可以共存；账本 key 包含 `kind`。
4. **跨 pack、同 scope、同 kind、同 id** 会在 `ContributionLedger.add` 冲突（见 §8），不是 manifest 解析错误。
5. **同 pack 重复 add 同一个 key** 是替换，不冲突；旧 disposer 只会在“当前条目仍是它注册的那个对象”时才删除。

### 3.4 解析示例

```ts
import { parsePackManifest } from "@opencode-ai/plugin/pack"

const manifest = parsePackManifest({
  id: "review",
  version: "1.0.0",
  entry: "plugin.ts",
  contributes: {
    tools: [{ id: "review.diff", description: "Review a diff" }],
  },
})
```

解析失败会抛 Zod 错误（字段问题）或普通 `Error`（重复 id）。产品内发现逻辑会捕获并记录 warning，跳过该 pack。

---

## 4. 插件进程开发

### 4.1 Host 侧：`spawnPlugin`

源码：`src/ipc/process.ts`。

```ts
import { randomBytes } from "node:crypto"
import { spawnPlugin } from "@opencode-ai/plugin/ipc/process"

const target = "/absolute/path/to/my-pack"
const token = randomBytes(16).toString("hex")

const plugin = await spawnPlugin({
  command: process.execPath,
  args: ["plugin.ts"],
  cwd: target,
  pluginId: "review",
  token,
  // 显式给最小环境；不要默认把宿主的全部环境变量传给第三方
  env: { PATH: process.env.PATH }, // spawnPlugin 会自动注入 OPENCODE_PACK_TOKEN
  handshakeTimeoutMs: 5_000,
  lifecycleTimeoutMs: 10_000,
  stopTimeoutMs: 1_000,
  onStderr: (chunk) => process.stderr.write(chunk),
})

await plugin.mount({
  scope: "project:abc",
  project: { id: "abc", directory: "/repo" },
  config: {},
})

const result = await plugin.peer.request("review.status", {})
await plugin.unmount("disable")
await plugin.mount()
await plugin.remove()
```

`SpawnPluginOptions` 全部字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `command` | 无（必填） | 可执行文件 |
| `args` | `[]` | 参数数组 |
| `cwd` | 当前进程 cwd | 工作目录 |
| `env` | `process.env` | **不给就是完整继承宿主环境** |
| `pluginId` | `"plugin"` | 注入 initialize/onMount 等参数 |
| `token` | `randomBytes(16).toString("hex")` | 握手 token；同时注入子进程 `OPENCODE_PACK_TOKEN` |
| `handshakeTimeoutMs` | `5_000` | `initialize` 超时 |
| `lifecycleTimeoutMs` | `10_000` | `onMount`/`onUnmount`/`onDelete` 超时 |
| `stopTimeoutMs` | `1_000` | 关闭 peer 后等待退出；超时则杀进程树 |
| `maxMessageBytes` | `8 * 1024 * 1024` | 传给 stdio transport |
| `onStderr` | 无 | 只有提供时才读取并转发 stderr |

返回的 `PluginProcess`：

```ts
type PluginProcess = {
  pid: number | undefined
  child: ChildProcess
  peer: Peer
  token: string
  lifecycle: "created" | "mounted" | "unmounted" | "deleted"
  exited: Promise<void>
  mount(input?: PluginMountInput): Promise<void>
  unmount(reason?: LifecycleReason): Promise<void>
  remove(): Promise<void>
  stop(options?: { force?: boolean }): Promise<void>
}

type PluginMountInput = {
  scope?: string
  project?: { id?: string; directory?: string }
  config?: unknown
  capabilities?: string[]
}
```

#### 自动 initialize 握手

`spawnPlugin` 返回前会自动执行：

```text
Host -> Plugin
{"jsonrpc":"2.0","id":"<host>-1","method":"initialize",
 "params":{"protocol":1,"pluginId":"review","token":"<hex>","capabilities":[]}}

Plugin -> Host
{"jsonrpc":"2.0","id":"<host>-1","result":{"protocol":1,"pluginId":"review","version":"1.0.0"}}
```

- Host 只校验响应里的 `protocol === IPC_PROTOCOL_VERSION`（当前为 `1`）；响应里的 `pluginId`/`version` 不参与校验。
- 插件侧由 `createPluginPeer` 自动注册 `initialize` handler；只要在握手超时前构造好 peer 即可，不需要手写握手代码。
- 握手失败会强制终止进程并让 `spawnPlugin` reject。
- `PluginMountInput.capabilities` 会被发送，但当前 `LifecycleContext` 不包含它，插件拿不到。

#### mount

`mount(input)` 发送：

```text
onMount {
  protocol: 1,
  pluginId,
  scope?, project?, config?, capabilities?
}
```

成功后 `lifecycle = "mounted"`。失败时 `lifecycle = "unmounted"`，并**强制终止进程**；因此 mount 失败后不能复用该进程，必须重新 spawn。

#### unmount / remove / stop

- `unmount(reason = "disable")`：只在 `mounted` 时发 `onUnmount`；`created`、`unmounted` 直接返回（状态归一到 `unmounted`），`deleted` 保持 deleted。
- `remove()`：只在当前 `mounted` 时先 `unmount("uninstall")`；如果 unmount 失败，**不会调用 `onDelete`**，但仍然标记 deleted 并强杀进程。`onDelete` 失败也会强杀并抛错。
- `stop({ force })`：`force` 或非 mounted 时直接终止；否则先 `unmount("shutdown")`，忽略失败，再终止。
- 终止流程：`peer.close()` -> 等待 `stopTimeoutMs` -> 杀进程树（Windows 用 `taskkill /pid <pid> /t /f`；非 Windows 先 SIGTERM，再 SIGKILL）。非 Windows 使用 detached 进程组，以便杀树。

### 4.2 插件侧：`createPluginPeer`

源码：`src/ipc/lifecycle.ts`。

```ts
import { createPluginPeer } from "@opencode-ai/plugin/ipc/lifecycle"
import { createStdioTransport } from "@opencode-ai/plugin/ipc/stdio"

const plugin = createPluginPeer(
  createStdioTransport({ input: process.stdin, output: process.stdout }),
  {
    onMount(context) {
      // 可选返回一个 cleanup；也可以用 context.effect(...)
    },
    onUnmount(context) {},
    onDelete(context) {},
  },
  {
    pluginId: "review",
    version: "1.0.0",
    token: process.env.OPENCODE_PACK_TOKEN, // 默认由 Host 注入；不设置时不校验
  },
)
```

`PluginPeerOptions` = `PeerOptions & { protocol?: number; pluginId?: string; version?: string; token?: string }`。

- `protocol`：默认 `1`；必须与 Host 的 `IPC_PROTOCOL_VERSION` 相等，否则 `initialize` 抛 `IpcError(InvalidRequest, "IPC protocol version mismatch")`。
- `pluginId`：只用于 `initialize` 响应；默认 `"plugin"`。Host 不从响应校验它。
- `version`：只用于 `initialize` 响应。
- `token`：显式配置优先；未配置时读取 `process.env.OPENCODE_PACK_TOKEN`。只要得到非空 token，`initialize` 的 `params.token` 必须严格相等，否则抛 `IpcError(InvalidRequest, "Invalid IPC token")`。
- 其余是 `PeerOptions`：`defaultTimeoutMs`（默认 30 秒）、`maxPendingRequests`（默认 1000）、`onError`。

返回：

```ts
type PluginPeer = {
  peer: Peer
  readonly mounted: boolean
  readonly deleted: boolean
}
```

#### token 的实际可用性

- `spawnPlugin` 默认生成随机 token，并把同一个 token 放进 `initialize` 参数和子进程的 `OPENCODE_PACK_TOKEN` 环境变量。
- `createPluginPeer` 未显式传 `token` 时读取 `process.env.OPENCODE_PACK_TOKEN`；因此通过 `ProcessPackRuntime` 启动的插件默认会校验 Host token。
- 显式 `token` 优先于环境变量。MessagePort/浏览器环境没有 `process.env`，需要显式传 token，或省略校验。
- token 是防误连的握手标记，不是安全边界；它不能替代进程隔离、权限检查和 sandbox。

### 4.3 stdout/stderr 约束

- stdout：**只能出现换行分隔的 JSON-RPC 帧**。`parseMessage` 遇到非法 JSON 会抛 `ParseError`，`createPeer` 会关闭 peer；Host 侧表现为插件退出/请求全部失败。
- stderr：日志通道。`spawnPlugin` 只有提供 `onStderr` 时才读取；不提供时 stderr 仍是 pipe，长期大量输出可能填满缓冲区并阻塞子进程。生产接入应始终传 `onStderr`。
- 换行：每帧一条，`\n` 分隔；`\r\n` 会被去掉 `\r`。UTF-8。
- 帧大小：stdio transport 的 `maxMessageBytes` 默认 8 MiB。当前检查只在“缓冲区超限且还没有换行”时触发；已经带换行的超长帧不会被这一步拒绝。不要把大对象一次性塞进单个帧。
- 退出：stdin 结束（父进程关闭）会触发 transport close；插件应把未完成的工作取消掉，而不是无限等待。

### 4.4 JSON-RPC 方法命名

协议是 JSON-RPC 2.0。保留方法：

| 方法 | 方向 | 说明 |
| --- | --- | --- |
| `initialize` | Host -> Plugin | 握手；自动发送 |
| `onMount` | Host -> Plugin | 挂载 |
| `onUnmount` | Host -> Plugin | 卸载运行时资源 |
| `onDelete` | Host -> Plugin | 删除插件数据 |
| `$/cancelRequest` | 双向 notification | 参数 `{ id }`；收到后 abort 对应请求的 `context.signal` |

其他方法名没有命名空间强制，但建议：

- 用 `<packId>.<name>`，例如 `review.diff`、`review.status`；
- 与 manifest 的 `rpc[].method` 保持一致（适配器/调用方可以据此展示和调用）；
- 工具贡献目前没有 method 字段，若要自行映射，建议同样使用工具 id 作为 method，但这是约定，不是 API 保证。

请求与通知：

- `peer.request(method, params?, { timeoutMs?, signal? })`：有响应。
- `peer.notify(method, params?)`：无响应。
- 未知 **request** 返回 `MethodNotFound`（`-32601`）。
- 未知 **notification** 静默忽略。

错误码：

| 名称 | 值 | 场景 |
| --- | --- | --- |
| `ParseError` | `-32700` | JSON 解析失败 |
| `InvalidRequest` | `-32600` | 协议字段非法、版本/token 不匹配 |
| `MethodNotFound` | `-32601` | 没有注册的 request handler |
| `InvalidParams` | `-32602` | handler 主动抛 `IpcError` 时使用 |
| `InternalError` | `-32603` | handler 抛普通 Error，或 peer 已关闭 |
| `RequestCancelled` | `-32800` | 调用方 signal abort |
| `Timeout` | `-32000` | 请求超时（非 JSON-RPC 标准码） |

### 4.5 错误、超时与取消

```ts
import { ErrorCodes, IpcError } from "@opencode-ai/plugin/ipc"

plugin.peer.onRequest("review.diff", async (params, context) => {
  if (typeof params !== "object" || params === null || typeof (params as { patch?: unknown }).patch !== "string") {
    throw new IpcError(ErrorCodes.InvalidParams, "patch is required")
  }

  const response = await fetch("https://example.invalid/review", {
    method: "POST",
    body: (params as { patch: string }).patch,
    signal: context.signal,
  })
  return { status: response.status }
})
```

行为：

- `request` 默认超时 30 秒；`timeoutMs: null` 或 `0` 关闭超时；`signal` 可由调用方主动取消。
- 超时/取消时，调用方 reject，并发送 `$/cancelRequest` notification；远端 handler 的 `context.signal` 被 abort。
- handler 应在耗时操作里传 `context.signal`；即使不传，调用方也已经 settle，迟到的结果会被忽略（但远端仍可能继续占用资源）。
- handler 抛 `IpcError` 时，错误码和 `data` 透传；抛普通 `Error` 时映射为 `InternalError`。
- peer 关闭时，所有 pending 请求被 reject（`IPC peer is closed` 或关闭原因）。
- `maxPendingRequests` 超限时，新请求以 `InternalError` 拒绝（`Too many pending IPC requests`）。
- `host.call` 没有 timeout 参数，使用 peer 默认 30 秒；需要自定义超时就直接用 `spawnPlugin` 的 `peer.request`。

### 4.6 MessagePort（Worker/iframe）

```ts
import { createPluginPeer } from "@opencode-ai/plugin/ipc/lifecycle"
import { createMessagePortTransport } from "@opencode-ai/plugin/ipc/message-port"

const plugin = createPluginPeer(
  createMessagePortTransport(port),
  { onMount() {}, onUnmount() {}, onDelete() {} },
  { pluginId: "review" },
)
```

- 同一套 JSON-RPC；`MessagePortLike` 只接受字符串消息，非字符串会关闭 transport 并通知 close handler。
- 这是进程内线程/窗口通道，不是安全沙箱。第三方 pack 仍应使用子进程。
- Web 与 Server 之间仍走现有 HTTP/SSE，IPC 不替代远程协议。

---

## 5. 生命周期契约

源码：`src/ipc/lifecycle.ts`、`src/ipc/process.ts`。Host 侧由 `spawnPlugin` 驱动，插件侧由 `createPluginPeer` 响应。

### 5.1 调用顺序

```text
enable / mount
  spawn -> initialize -> onMount -> (mounted)

disable / unmount
  onUnmount(reason) -> 插件 effect/cleanup -> 杀进程 -> (unmounted)

uninstall / remove
  onUnmount("uninstall") -> onDelete -> 杀进程 -> Host 删除 store 记录和命名空间 -> (deleted)

stop
  onUnmount("shutdown") -> 杀进程
```

实际顺序受当前状态影响：

- `remove()` 只在 `mounted` 时先 `onUnmount`；如果已经是 `unmounted`/`created`，直接 `onDelete`。
- `onDelete` 内部也会调用一次 `unmount()`（插件侧兜底）；如果已经 unmounted，这次是 no-op。
- 如果 `onUnmount` 失败，`spawnPlugin.remove()` **不会**调用 `onDelete`，但仍会标记 deleted、强杀进程。`PackHost.uninstall` 仍会继续 `store.remove`。
- `PackHost.reload()` 通过 `handle.unmount("reload")` 发送 `reason: "reload"`；直接调用 `unmount()` 发送 `reason: "shutdown"`。

### 5.2 各方法精确语义

#### `onMount(context)`

`MountContext`：

```ts
type MountContext = {
  pluginId: string
  scope?: string
  project?: { id?: string; directory?: string }
  config?: unknown
  reason?: LifecycleReason
  effect(cleanup: () => void | Promise<void>): () => void
}
```

- 每个进程最多成功调用一次；重复 `onMount` 在已 mounted 时直接返回 `{ mounted: true }`，不会重复执行。
- `deleted` 后再次 `onMount` 会抛 `Plugin has been deleted`。
- 可以返回一个 cleanup，也可以用 `context.effect(...)` 注册多个。
- 抛错时：已注册的 cleanups 会按注册逆序执行（忽略清理错误），`mounted` 保持 false，Host 强杀进程。

#### `onUnmount(context)`

`LifecycleContext`：

```ts
type LifecycleContext = {
  pluginId: string
  scope?: string
  project?: { id?: string; directory?: string }
  config?: unknown
  reason?: "disable" | "reload" | "shutdown" | "uninstall"
}
```

- 只有 `mounted` 时执行；未 mounted 时 no-op。
- 执行顺序：先 `handlers.onUnmount`，再执行 cleanups（逆序）。**即使 `onUnmount` 抛错，cleanups 仍会执行**，然后 `mounted = false`，最后把原始错误抛回 Host。
- 如果某个 cleanup 抛错，后续 cleanup 不会执行，且该 cleanup 错误会覆盖 `onUnmount` 的原始错误。清理函数应自行捕获异常。
- **不删除持久数据**。这里只释放运行时资源：连接、watcher、timer、临时子进程等。
- 内置 `spawnPlugin` 只传 `pluginId` 和 `reason`，不传 `scope`/`project`/`config`。需要这些值时，在 `onMount` 里保存到模块变量。
- `onMount` 返回的 cleanup 会在 `onUnmount` handler 之后、`context.effect` 注册的 cleanups 之前执行（因为它在 mount 成功后才被 push 到 cleanups 末尾，逆序执行）。

#### `onDelete(context)`

- 如果已经 `deleted`，直接返回 `{ deleted: true }`，不重复执行。
- 否则先确保 unmount（`reason: "uninstall"`），再执行 `onDelete` handler，成功后 `deleted = true`。
- `reason` 缺省为 `"uninstall"`。
- 用于删除**本 pack 自己的**持久数据、配置、缓存、临时文件。
- 失败时：`deleted` 保持 false，错误抛回 Host；Host 仍会强杀进程，`PackHost.uninstall` 仍会删除 store 记录和命名空间数据。再次调用会重试 `onDelete`。
- 不能依赖 `onDelete` 成为唯一清理方；Host 有兜底（见 §5.4）。

### 5.3 `ctx.effect` 与清理顺序

```ts
onMount(context) {
  const timer = setInterval(() => {}, 1_000)
  context.effect(() => clearInterval(timer))

  const controller = new AbortController()
  context.effect(() => controller.abort())

  return () => {
    // 最后执行：在已注册 effect 之前
  }
}
```

- effect cleanup 按**注册逆序**执行（LIFO）。
- `onMount` 返回的 cleanup 在 mount 成功后才注册，因此它最先执行。
- `effect` 返回一个 disposer，可以提前移除指定 cleanup。
- 清理是串行 `await` 的；一个抛错会中断剩余清理。
- 在 `onMount` 抛错、`onUnmount` 抛错、`onDelete` 前，都会执行同一套清理。

### 5.4 幂等与失败清理

| 场景 | 插件侧 | Host 侧 |
| --- | --- | --- |
| 重复 `onMount` | 返回 `{ mounted: true }`，不重复执行 | `PluginProcess.mount` 在 mounted 时直接返回 |
| 重复 `onUnmount` | `mounted` 为 false 时 no-op | `unmount` 在 created/unmounted 时直接返回 |
| 重复 `onDelete` | `deleted` 为 true 时 no-op | `remove` 在 deleted 时直接返回 |
| `onMount` 失败 | 已注册 cleanups 逆序执行；`mounted=false` | `lifecycle=unmounted`，强杀进程；`PackHost` 回滚账本、不写 enabled |
| `onUnmount` 失败 | cleanups 仍执行；`mounted=false`；抛错 | 强杀进程；`PackHost.disable` 仍移除 enabled；`uninstall` 继续删 store |
| `onDelete` 失败 | cleanups 已在 unmount 执行；`deleted=false`；抛错 | 强杀进程；`PackHost.uninstall` 仍删安装记录和命名空间 |
| 生命周期超时 | 可能来不及清理 | 强杀进程 |

**Host 兜底**：

- `PackHost.mountPack` 先启动运行时，再登记账本；登记冲突时撤销已登记的贡献并 `handle.unmount()`。
- `PackHost.disable/unmount/uninstall` 先撤销账本，再停止运行时；因此即使插件清理失败，贡献也不会残留。
- `PackHost.uninstall` 在运行时清理失败后仍执行 `store.remove()`，删除安装记录、启用状态、配置和命名空间数据。
- 进程崩溃时 `spawnPlugin` 通过 `close` 关闭 peer；`PackHost` 仍可继续执行 `unmount`/`uninstall`（handle 的 `unmount/remove` 是幂等的）。

### 5.5 生命周期里不要做的事

- 不要在 `onUnmount` 删除数据库/文件数据；那会让“禁用后重新启用”丢状态。用 `onDelete`。
- 不要在 `onUnmount` 里等待宿主的其他服务；Host 有 10 秒超时并会杀进程。
- 不要在 `onDelete` 里删除 session、消息、用户通过工具修改的文件；只删自己的命名空间/缓存/临时文件。
- 不要假设 `onUnmount` 一定会执行（进程可能崩溃或被强杀）；重要状态要在操作发生时持久化，而不是压在卸载时写盘。

---

## 6. Pack Host API

源码：`src/pack/host.ts`。

### 6.1 构造

```ts
type PackHostOptions = {
  store: PackStore
  runtime: PackRuntime
  scope: string
  project?: { id?: string; directory?: string }
  onError?: (packId: string, error: Error) => void
}

const host = new PackHost({ store, runtime, scope, project, onError })
```

- 一个 `PackHost` 实例对应一个 `scope`。账本、enabled、配置都按这个 scope 工作。
- `runtime` 可以是 `ProcessPackRuntime`，也可以是测试里的 fake（实现 `PackRuntime` 即可）。
- `onError` 只在 `fail()` 路径触发：`enable` 挂载失败、`mount()`/`reload()` 的单个 pack 挂载失败、`disable`/`unmount` 清理失败、`uninstall` 记录下的第一个失败。`install` 的 store 错误和 `setConfig` 的 remount 失败**不经过** `fail`，只通过 Promise rejection 暴露。

### 6.2 方法表

| 方法 | 返回 | 语义 | 失败行为 |
| --- | --- | --- | --- |
| `install(pack: InstalledPack)` | `Promise<void>` | 写入/覆盖 store 记录；不启动进程；不拷贝文件；不校验 target | 已 mounted 时抛 `Pack <id> is mounted` |
| `enable(packId, config?)` | `Promise<void>` | 可选写 config；未 mounted 则 `mountPack`；然后加入 enabled | 挂载失败：记录 error、抛错、不写 enabled；`setEnabled` 失败：卸载并抛错 |
| `disable(packId)` | `Promise<void>` | 撤销账本 -> `handle.unmount()` -> 从 enabled 移除；保留安装/配置/data | unmount 失败：仍移除 enabled，最后抛错 |
| `mount()` | `Promise<void>` | 遍历 enabled，挂载所有未挂载的 pack | 单个 pack 失败只记录 error 并继续，不抛出 |
| `unmount()` | `Promise<void>` | 以 `reason: "shutdown"` 停止所有已挂载 pack；保留 enabled | 收集第一个失败，处理完所有后抛出 |
| `reload()` | `Promise<void>` | 先以 `reason: "reload"` 卸载所有已挂载，再挂载所有 enabled | **卸载失败会立即中断**（没有 per-pack catch），不会继续挂载；挂载失败只记录并继续 |
| `uninstall(packId)` | `Promise<void>` | 从 enabled 移除 -> 账本撤销 -> `handle.remove()`（onUnmount+onDelete+杀进程）-> `store.remove()` | 若 `setEnabled` 失败会直接中断；否则运行时清理和 `store.remove` 会尽量都执行，抛第一个失败；最后清空该 pack 的 error |
| `setConfig(packId, config)` | `Promise<void>` | 若已挂载先卸载；写 config；如果本来 enabled 则重新挂载 | remount 失败会抛错，但**不写入 `errors`** |
| `contributions(kind?)` | `Contribution[]` | 同步读取当前 scope 的账本（可按 kind 过滤） | 不抛 |
| `snapshot()` | `ContributionSnapshot` | 同步读取账本快照：`{ version, contributions }` | 不抛 |
| `call(packId, method, params?)` | `Promise<T>` | 在已挂载 handle 上发 IPC request | 未挂载抛 `Pack not mounted: <id>`；handle 已关闭抛 `Pack <id> is not mounted` |
| `list()` | `Promise<PackStatus[]>` | 读取安装列表 + enabled + mounted + 最近一次 error | store 错误会抛出 |

`PackStatus`：

```ts
type PackStatus = {
  pack: InstalledPack
  enabled: boolean
  mounted: boolean
  error?: string
}
```

注意：

- `enable` 已经包含挂载；README 示例里的 `await host.enable("review"); await host.mount()` 中，第二个 `mount()` 通常是 no-op。
- `ProcessPackRuntime` 在 manifest 既没有 `command` 也没有 `entry` 时不会启动进程，但仍返回一个 handle；`mount`/`enable` 会成功、贡献也会登记，但 `call` 总是以 `Pack <id> has no runtime entry` 拒绝。
- `install` 会覆盖同 id 的安装记录（`store.put`），不会自动卸载旧运行时；已 mounted 时直接拒绝。
- `setConfig` 对未安装且未 enabled 的 id 也可能成功写入配置（store 不校验 pack 是否存在）；需要调用方先 `get`/`list`。
- `call` 不会检查目标方法是否在 `rpc` 贡献中，也不会检查 pack 是否 enabled；只检查是否有 handle。
- `uninstall` 末尾会 `errors.delete(packId)`，即使它因为清理失败而抛出；需要从 rejection 或 `onError` 获取错误，不能只看 `list().error`。

### 6.3 状态机

```text
未安装
  install
    -> 已安装 / disabled
  enable
    -> 已安装 / enabled / mounted        (mountPack 成功)
  enable 失败
    -> 已安装 / disabled / error          (运行时被强杀，账本回滚)

已安装 / enabled / mounted
  disable
    -> 已安装 / disabled                  (onUnmount + 杀进程)
  unmount()（Host 级）
    -> 已安装 / enabled / not mounted     (保留 enabled)
  mount()（Host 级）
    -> 已安装 / enabled / mounted
  reload()
    -> 先全部 unmount，再挂载 enabled；卸载失败会中断
  uninstall
    -> 未安装                             (onUnmount + onDelete + store.remove)

已安装 / disabled
  uninstall
    -> 未安装                             (如无 handle，只删 store)
```

补充：`enable` 失败时是否写入 enabled 取决于调用前状态。首次启用（未 enabled）失败后保持 disabled；如果 pack 之前已经 enabled（例如 `host.unmount()` 之后重新 `enable`）而这次挂载失败，store 中的 enabled 仍然是 true，只是 `mounted=false` 且记录了 error。遇到这种情况应显式 `disable` 再修复后重试，或调用 `unmount()`/`mount()` 处理。

`mounted` 是**内存状态**，不持久化。进程重启后即使 `enabled` 为 true，也必须重新 `mount()`。

### 6.4 Scope key

推荐：

- 正常 git 项目：`project:<ProjectV2.ID>`
- 非 git / 无法解析项目：`dir:<absolute-directory>`

产品内 `packages/opencode/src/pack/pack.ts:54` 的规则是：

```ts
const scope = ctx.project.id === "global" ? `dir:${ctx.directory}` : `project:${ctx.project.id}`
```

约束：

- 不要用 `global` 或 `worktree=/` 作为项目作用域；否则所有非 git 目录共享启用状态。
- `scope` 是账本 key、配置 key、enabled key 的一部分，也会进入 `FilePackStore` 数据路径；一旦上线要保持稳定。
- 不同 scope 需要不同的 `PackHost` 实例。账本冲突只在同一 `Host`/同一 scope 内检查；不同 scope 的同名贡献互不影响。
- 同一个 pack 在两个 scope 都启用会启动两个子进程；进程隔离是 per mount，不是 per pack。

### 6.5 并发串行化

`PackHost` 内部有一个 promise 链：

```ts
private run<T>(task: () => Promise<T>): Promise<T> {
  const next = this.pending.then(task, task)
  this.pending = next.then(() => undefined, () => undefined)
  return next
}
```

因此：

- `install`/`enable`/`disable`/`mount`/`unmount`/`reload`/`uninstall`/`setConfig`/`list` 串行执行，调用顺序即执行顺序。
- 前一个任务 reject 不会毒化队列；后续任务仍会执行。
- `call`、`contributions`、`snapshot` **不进入队列**：`call` 直接拿当前 handle，可能和 `uninstall`/`disable` 竞争；如果 handle 已被移除，会得到 `Pack not mounted` 或 handle 的 `is not mounted` 错误。
- 不要并发调用同一 pack 的 `enable`/`uninstall` 并依赖中间状态；虽然队列保序，但每一步的检查都是“当前状态”。
- 没有跨进程锁。两个进程/两个 `FilePackStore` 实例共享同一个 root 会互相覆盖 `state.json`；这是 `FilePackStore` 的已知限制。

---

## 7. 存储

源码：`src/pack/store.ts`、`src/pack/file-store.ts`。

### 7.1 `PackStore` 接口

```ts
type InstalledPack = {
  manifest: PackManifest
  source: string
  target: string
  installedAt: number
}

type PackStore = {
  list(): Promise<InstalledPack[]>
  get(id: string): Promise<InstalledPack | undefined>
  put(pack: InstalledPack): Promise<void>
  remove(id: string): Promise<void>

  enabled(scope: string): Promise<string[]>
  setEnabled(scope: string, ids: string[]): Promise<void>

  config(scope: string, id: string): Promise<unknown>
  setConfig(scope: string, id: string, config: unknown): Promise<void>

  data(packId: string, scope: string, key: string): Promise<unknown>
  setData(packId: string, scope: string, key: string, value: unknown): Promise<void>
  deleteData(packId: string, scope: string, key: string): Promise<void>
  clearData(packId: string): Promise<void>
}
```

`PackHost` 只直接使用 `list/get/put/remove/enabled/setEnabled/config/setConfig`。`data`/`setData`/`deleteData`/`clearData` 是给宿主/核心/插件数据通道实现用的；**PackHost 没有暴露 data 读写方法**，插件进程也没有内置的数据 IPC。

### 7.2 `MemoryPackStore`

- 全部状态在内存：`packs`、`scopes`、`configs`、`dataStore`。
- 适合测试、嵌入式 demo；进程退出即丢失。
- `remove(id)` 会删除安装记录、所有 scope 的 enabled 项、所有 scope 的配置、该 pack 的全部 data。
- `setEnabled(scope, ids)` 会去重、只保留已安装的 id、排序。
- 产品内 `packages/opencode/src/pack/pack.ts` 当前用的就是它。

### 7.3 `FilePackStore`

```ts
const store = new FilePackStore("/path/to/pack-state")
```

目录布局：

```text
<pack-state>/
  state.json
  data/
    <encoded-pack-id>/
      <encoded-scope>/
        <encoded-key>.json
```

`state.json` 形状：

```json
{
  "packs": {
    "review": {
      "manifest": { "id": "review", "version": "1.0.0", "entry": "plugin.ts" },
      "source": "file",
      "target": "/abs/path/my-pack",
      "installedAt": 1730000000000
    }
  },
  "enabled": {
    "project:abc": ["review"]
  },
  "config": {
    "project:abc": {
      "review": { "strict": true }
    }
  }
}
```

关键行为：

- 路径组件都经过 `encodeURIComponent`：`data/review/project%3Aabc/key.json`；scope 中的 `:` 会变成 `%3A`，key 中的 `/` 会变成 `%2F`。不要手工拼路径。
- `state.json` 在第一次访问时读入并**缓存在内存**（`statePromise`）；之后外部修改文件不会被重新读取。写入是整文件覆盖。
- `put`/`setEnabled`/`setConfig`/`remove` 会重写 `state.json`；`setData` 只写对应数据文件。
- `data()` 读不到文件返回 `undefined`；文件存在但不是合法 JSON 会抛错。
- `remove(id)`：
  1. 删 `packs[id]`；
  2. 遍历所有 scope，从 `enabled[scope]` 中过滤掉该 id；
  3. 遍历所有 scope，删除 `config[scope][id]`；
  4. 保存 `state.json`；
  5. `clearData(id)` 递归删除 `data/<encoded-id>`（所有 scope）。
- 没有原子 rename、没有文件锁、没有多进程并发保护。两个实例共享 root 时会丢更新。

### 7.4 卸载清理

`PackHost.uninstall` 的清理顺序：

```text
setEnabled(scope, enabled - id)
  -> disposePack(id, "remove")
       -> ledger.removePack(id, scope)
       -> handle.remove()
            -> 插件 onUnmount("uninstall")
            -> 插件 onDelete
            -> 强杀进程
  -> store.remove(id)
       -> 删安装记录/所有 scope 的 enabled/config
       -> clearData(id)
```

即使运行时清理失败，`store.remove` 仍会执行。`store.remove` 失败时，前面步骤已经完成，错误会抛给调用方。

### 7.5 生产建议

- 生产环境应实现 `PackStore` 的 SQLite 版本，把安装、项目启用、配置、命名空间数据放进核心数据库事务；README 建议的表名是 `packs`、`pack_project`、`plugin_data`，但以核心实际 schema 为准。
- 至少需要保证：
  - `uninstall` 的账本撤销、安装记录删除、数据清理在同一个事务边界内，或可重试；
  - `enabled` 与 `packs` 的外键/存在性一致；
  - 多进程/多窗口下用数据库事务而不是整文件覆盖。
- `FilePackStore` 只用于 v1 和测试；它证明接口和清理语义，不替代数据库事务。

---

## 8. Contribution Ledger

源码：`src/pack/ledger.ts`。

### 8.1 数据模型

```ts
type ContributionKind = "tool" | "agent" | "prompt" | "rpc" | "ui"

type Contribution = {
  packId: string
  scope: string
  kind: ContributionKind
  id: string
  value: unknown
}

type ContributionSnapshot = {
  version: number
  contributions: readonly Contribution[]
}
```

内部 key 是：

```text
<scope>\0<kind>\0<id>
```

`value` 是 manifest 中对应的原始贡献对象（例如 `PackTool`、`PackPrompt`），不是转换后的核心对象。

### 8.2 冲突规则

`add(contribution)`：

- 如果同 key 已存在且 `current.packId !== contribution.packId`，抛：

```text
Contribution conflict: <kind>:<id> is already owned by <packId>
```

- 如果同 key 已存在且是同一个 pack，允许替换；新对象成为当前值。
- 每次 `add` 都会 `revision++`，即使只是同 pack 替换。
- 返回 disposer；disposer 只在“当前条目仍是这次 add 的对象”时才删除，避免旧 disposer 误删新条目。

冲突发生在**挂载阶段**：`PackHost.mountPack` 先启动运行时，再逐条 `ledger.add`；一旦冲突，会撤销本次已添加的贡献并 `handle.unmount()`。因此第二个 pack 的进程会被短暂启动然后停止，最终不残留贡献，也不会写 enabled（`enable` 路径）。

### 8.3 作用域与快照

- `list(scope, kind?)`：返回指定 scope、可选 kind 的贡献，顺序来自 `snapshot()` 的排序。
- `snapshot()`：返回全部条目的只读快照，按 `scope`、`kind`、`id` 字典序排序，并带上当前 `version`。
- `version` 在以下情况递增：`add`、实际删除条目的 `removePack`/`removeScope`、非空 `clear`。
- 账本**不持久化**；Host 重启后由 `mount` 重新建立。持久化只覆盖安装/启用/配置/数据，不覆盖贡献。
- 不同 scope 的 key 不同，不会互相冲突；但同一个 Host 实例只注册自己 scope 的贡献。

### 8.4 移除顺序与竞态

- 挂载：`runtime.mount` 成功 -> `ledger.add` 全部贡献 -> 写入 `mounted` map。失败则反序 disposer -> `handle.unmount()`。
- 卸载/删除：`ledger.removePack(packId, scope)` **先于** `handle.unmount()`/`handle.remove()`。
- 影响：
  - 适配器看到贡献消失时，插件进程可能还在执行清理；不要再对刚消失的工具发起新调用。
  - `host.call` 直接查 `mounted` map，不查账本；在账本移除到 handle 移除之间的极短窗口里仍可能拿到 handle。适配器应以账本快照为准。
  - 进程崩溃时，Host 通过 `spawnPlugin` 的 close 关闭 peer；账本仍需上层调用 `disable`/`uninstall`/`unmount` 才会清理（或在 `mountPack` 失败时自动回滚）。

### 8.5 核心适配器应如何消费

当前没有事件流；适配器应采用**拉取快照**的方式：

```ts
const snapshot = host.snapshot()
const tools = host.contributions("tool")
const agents = host.contributions("agent")
const prompts = host.contributions("prompt")
const rpcs = host.contributions("rpc")
const uis = host.contributions("ui")
```

建议：

- 在 `install`/`enable`/`disable`/`mount`/`unmount`/`uninstall`/`setConfig`/`reload` 之后重新读取快照；用 `snapshot().version` 去重。
- 只信任 `Contribution.value` 的结构做防御性解析；不要在核心中 import pack 代码。
- Tool adapter：
  - 读取 `value.id`、`value.description`、`inputSchema`/`outputSchema`；
  - 执行时需要自己决定 IPC method 映射（manifest 没有 method 字段）；
  - 通过 `host.call(packId, method, params)` 调用；
  - 处理 `Pack not mounted`（禁用/卸载/崩溃）并返回可读错误。
- Agent adapter：
  - `value` 是 passthrough 对象；核心要自行校验 `mode`/`model`/`prompt` 等字段；
  - 目前没有注册入口，需要新增适配器。
- Prompt adapter：
  - 读取 `content`、`priority`、`slot`；
  - 当前 `packages/opencode/src/pack/pack.ts` 的 `prompts()` 已给出一种最小实现：包装 `<pack_instructions pack="...">`，按 priority 降序；
  - 它忽略 `slot`，也不经过 `SystemPrompt.Service`。
- RPC adapter：
  - `value.method` 是建议的 IPC method；调用前先 `host.call`；
  - 当前没有 HTTP 路由或前端调用链，需要新增。
- UI adapter：
  - `value.slot`/`value.entry` 只是声明；
  - 没有 slot 枚举、没有路径解析、没有渲染器。实现时必须自行做 `target` 内的安全路径解析和沙箱隔离。

---

## 9. 安全边界

### 9.1 子进程不是完整沙箱

- Pack 子进程以当前用户权限运行，能访问文件系统、网络、环境变量；`ProcessPackRuntime` 不提供 CPU/内存/文件系统限制。
- 人能做的事它都能做。第三方 pack 应按不受信任代码对待；需要更强隔离时用容器/独立 OS 用户，而不是依赖 IPC 边界。
- MessagePort/Worker 只是通信通道，进程内仍然没有安全隔离。

### 9.2 环境变量

- `spawnPlugin` 的 `env` 默认是 `process.env`，即**完整继承**。README 的“不要传不必要环境变量”是建议，不是默认行为。
- 传 `env` 时显式构造最小集合；不要把 API key、token、代理凭据透传给不信任的 pack。
- `config` 会原样传给 `onMount`，可能包含敏感值；不要把它写进日志或错误消息。
- token 不是自动安全机制：见 §4.2。需要时用显式 env 传递，并只通过 `initialize` 校验。

### 9.3 入口路径与命令

- `ProcessPackRuntime` 对 `entry` 做词法检查（`src/pack/runtime.ts:104`）：
  - `root = resolve(pack.target)`
  - `entry = resolve(root, manifest.entry)`
  - 计算 `relative(root, entry)`，拒绝空字符串、以 `..` 开头、绝对路径。
- 该检查**不是** `realpath`：`target` 内的符号链接可以指向 `target` 外，检查会通过。需要强隔离时在启动前对入口做 `realpath` 并再次校验，或禁止符号链接。
- 该检查也会误伤：目标内以 `..` 开头的正常文件名/目录（如 `..cache/plugin.js`）会被拒绝。
- **如果 manifest 有 `command`，`entry` 完全被忽略**：`command[0]` 可以是任意可执行文件，`args` 任意，`cwd` 固定为 `target`。`manifest.permissions` 和 `api` 都不执行。安装第三方 pack 等同于允许它执行任意命令；生产上应有显式信任/审批。
- `ProcessPackRuntime({ command })` 也会覆盖 `command[0]`；manifest 的 args 仍会保留。

### 9.4 UI 代码不可信

- 当前没有任何代码读取/执行 `ui.entry`；这只意味着“尚未实现”，不是“安全”。
- 未来实现 UI 渲染时：
  - 不要把 `ui.entry` 直接 `eval`/`import` 到主窗口；
  - 在 sandboxed iframe/worker 中加载，设置 CSP，禁止 Node 集成；
  - 对 `entry` 做 `target` 内解析和 `realpath` 校验；
  - 把 slot 当作显式白名单，而不是任意字符串。
- `ui.slot` 现在没有内置枚举；不要声称已有“设置页/侧栏”等 slot。

### 9.5 删除边界

- `PackHost.uninstall` 只删：
  - enabled 中的 id；
  - 账本中该 pack 的贡献；
  - 安装记录；
  - 配置；
  - `PackStore` 中该 pack 的 data 命名空间（`FilePackStore` 的 `data/<encoded-id>`）。
- **不会删除**：
  - `target` 目录/安装源文件；
  - session 历史、消息、工具调用记录；
  - 用户通过工具修改的文件；
  - 插件在 `target` 外自行创建的文件（除非插件在 `onDelete` 自己删）。
- 插件 `onDelete` 只应删自己的缓存/临时文件/数据库命名空间；不要删用户项目文件或会话数据。
- Host 兜底清理只覆盖自己管理的 store，不覆盖插件私有目录。

### 9.6 其他资源边界

- `maxPendingRequests` 默认 1000；超出后新请求被拒绝。
- stdio 单帧建议远小于 8 MiB；大结果应分页或落盘后传路径。
- 生命周期超时（默认 10 秒）是唯一的“卡死保护”之一；超时后强杀进程。
- 没有速率限制、没有审计日志、没有权限模型；需要这些能力时在核心/宿主层实现。

---

## 10. 测试与调试

### 10.1 命令

```bash
# 在 packages/plugin 下（不要在仓库根跑测试）
cd packages/plugin
bun run test                 # bun test test/ipc test/pack
bun test test/ipc/peer.test.ts

bun typecheck                # tsgo --noEmit
bun run build                # tsc（按 package.json 脚本）

# 仓库根
bun run lint                 # oxlint
bun run typecheck            # turbo typecheck（全仓，较慢）
```

本次核对时，`bun test test/ipc test/pack` 的结果是 **30 pass / 0 fail / 10 files**。

完整的应用构建（会更新 `BUILD.md`）是仓库根的 `bun run build:local`；只做插件层验证不需要它。

### 10.2 测试文件地图

| 文件 | 覆盖内容 |
| --- | --- |
| `test/ipc/peer.test.ts` | 请求/通知、MethodNotFound、handler 错误、超时取消、调用方 abort、关闭拒绝 pending |
| `test/ipc/stdio.test.ts` | 换行分隔 JSON、分片/粘包 |
| `test/ipc/message-port.test.ts` | 两个 MessagePort 之间请求 |
| `test/ipc/lifecycle.test.ts` | mount/unmount/delete 顺序、effect 自动清理、mount 失败清理、onUnmount 失败仍清理 |
| `test/ipc/process.test.ts` | 真子进程 spawn、握手、mount/unmount/remove、trace |
| `test/ipc/fixtures/echo-plugin.ts` | 插件侧 fixture，展示 `createPluginPeer` + `ctx.effect` |
| `test/pack/manifest.test.ts` | 解析贡献、重复 id、非法 pack id |
| `test/pack/ledger.test.ts` | add/list/dispose、跨 pack 冲突、同 pack 替换、按 pack/scope 移除 |
| `test/pack/file-store.test.ts` | 持久化、重新实例化读取、remove 清理 |
| `test/pack/host.test.ts` | install/enable/disable/remount/uninstall、冲突回滚、mount 失败、清理失败仍删 store、setConfig 重挂载 |
| `test/pack/runtime.test.ts` | 真子进程 runtime、幂等 unmount、入口逃逸拒绝 |

### 10.3 常见失败与排查

#### mount 失败

表现：`host.enable(id)` reject；`list().error` 有值；pack 未 enabled；进程已被杀。

排查顺序：

1. stderr 是否有输出？没有传 `onStderr` 时先补上。
2. 握手是否超时？检查插件是否在 5 秒内构造好 peer，是否在构造前做了阻塞 IO。
3. 协议版本是否等于 `IPC_PROTOCOL_VERSION`（1）？
4. 插件是否配置了 token，但环境里没有 `OPENCODE_PACK_TOKEN`？（使用 `spawnPlugin` 时 Host 会自动注入；自定义 runtime 需要自己传。）
5. `onMount` 是否抛错？看 Host 侧错误消息。
6. 是否 stdout 被 `console.log` 污染，导致 `Invalid JSON-RPC payload`？

注意：mount 失败会强杀进程；修复后需要重新 `enable`（重新 spawn），不能复用旧进程。

#### 贡献冲突

表现：

```text
Contribution conflict: tool:shared is already owned by a
```

特征：第二个 pack 的 `enable` reject；它保持 installed 但 enabled=false；第一个 pack 不受影响；第二个 pack 的进程会被挂载后立刻卸载。

处理：改 id、改 scope、或先 `disable`/`uninstall` 原来的 owner。不要通过删除账本内存来绕过；Host 没有暴露删除接口。

#### 入口逃逸

表现：

```text
Pack <id> entry escapes its target directory
```

触发条件：

- `entry` 解析后等于 `target` 本身（例如 `entry: "."`）；
- `entry` 指向 `target` 外（`../...`、绝对路径）；
- `entry` 以 `..` 开头（包括目标内合法的 `..cache/...`，属于误伤）。

另外：

- 符号链接不在检查范围内，仍可能逃逸；
- 有 `command` 时不检查 `entry`。

修复：把入口放在 `target` 内，使用正常文件名；需要命令入口时显式写 `command` 并自行保证安全。

#### unmount 失败

表现：`disable`/`uninstall`/`unmount()` reject，但账本已撤销、enabled 已移除（`disable` 路径）；进程已被强杀。

排查：

- 插件 `onUnmount` 是否超时（默认 10 秒）？
- 是否在 `onUnmount` 里等待网络/其他服务？
- cleanup 是否抛错？一个 cleanup 抛错会中断后续 cleanup。

由于 Host 有兜底，失败通常不阻塞重新 `enable`；但插件自己的持久状态可能没清理干净，需要在下次 `onMount` 里补偿。

#### 其他常见错误

| 现象 | 原因 |
| --- | --- |
| `Pack not mounted: <id>` | `host.call` 时没有 handle；未 enable/mount，或已 disable/uninstall |
| `Pack <id> is not mounted` | handle 已关闭（进程被杀/已 unmount） |
| `Pack not installed: <id>` | `enable` 前没有 `install`，或已被 `uninstall` |
| `Pack <id> has no runtime entry` | manifest 既没有 `command` 也没有 `entry`；`mount` 会成功，但 `call` 总是失败 |
| `Pack <id> is mounted` | 已挂载时再次 `install`；先 `disable`/`unmount`/`uninstall` |
| `Too many pending IPC requests` | 超过 `maxPendingRequests`（默认 1000） |
| `IPC input closed` | 父进程关闭 stdin 或子进程退出 |
| `IPC request timed out: <method>` | 默认 30 秒超时；检查插件是否处理该 method |
| 配置没生效 | `setConfig` 在 disabled 时只写不挂载；重新 `enable` 或再次 `setConfig` 触发重挂载 |
| `list().error` 为空但操作失败 | `setConfig` remount 失败不写 errors；`uninstall` 末尾会清 errors；看 rejection/`onError` |

---

## 11. 文件地图与下一步

### 11.1 IPC 文件

| 文件 | 职责 |
| --- | --- |
| `src/ipc/protocol.ts` | `IPC_PROTOCOL_VERSION`、JSON-RPC 类型、`parseMessage`、`ErrorCodes`、`IpcError` |
| `src/ipc/transport.ts` | `Transport` 接口（send/onMessage/onClose/close） |
| `src/ipc/peer.ts` | `createPeer`、请求/通知、超时、abort、`$/cancelRequest`、关闭 |
| `src/ipc/stdio.ts` | `createStdioTransport`：换行分隔、分片/粘包、帧大小保护 |
| `src/ipc/message-port.ts` | `createMessagePortTransport`：Worker/iframe 字符串消息 |
| `src/ipc/lifecycle.ts` | `createPluginPeer`：initialize、onMount/onUnmount/onDelete、effect 清理 |
| `src/ipc/process.ts` | `spawnPlugin`：spawn、握手、mount/unmount/remove/stop、杀进程树 |
| `src/ipc/index.ts` | 导出 lifecycle/peer/protocol/transport（stdio/process/message-port 走子路径） |
| `src/ipc/README.md` | 设计说明；与实现的差异见附录 A |

### 11.2 Pack 文件

| 文件 | 职责 |
| --- | --- |
| `src/pack/manifest.ts` | Zod schema、`parsePackManifest`、重复 id 校验 |
| `src/pack/ledger.ts` | `ContributionLedger`、冲突、scope、快照、移除 |
| `src/pack/store.ts` | `PackStore` 接口、`MemoryPackStore`、`InstalledPack` |
| `src/pack/file-store.ts` | `FilePackStore`：`state.json` + `data/` |
| `src/pack/runtime.ts` | `PackRuntime`/`PackRuntimeHandle`、`ProcessPackRuntime`、入口逃逸检查 |
| `src/pack/host.ts` | `PackHost`：install/enable/disable/mount/unmount/reload/uninstall/setConfig/contributions/call/list |
| `src/pack/index.ts` | 导出 ledger/manifest/store |
| `src/pack/README.md` | 设计说明；与实现的差异见附录 A |

### 11.3 package exports

`packages/plugin/package.json` 当前导出：

```text
@opencode-ai/plugin
@opencode-ai/plugin/tool
@opencode-ai/plugin/tui
@opencode-ai/plugin/v2/effect
@opencode-ai/plugin/v2/effect/integration
@opencode-ai/plugin/v2/effect/plugin
@opencode-ai/plugin/v2/promise
@opencode-ai/plugin/ipc              -> src/ipc/index.ts
@opencode-ai/plugin/ipc/stdio        -> src/ipc/stdio.ts
@opencode-ai/plugin/ipc/process      -> src/ipc/process.ts
@opencode-ai/plugin/ipc/message-port -> src/ipc/message-port.ts
@opencode-ai/plugin/ipc/lifecycle    -> src/ipc/lifecycle.ts
@opencode-ai/plugin/pack             -> src/pack/index.ts
@opencode-ai/plugin/pack/host        -> src/pack/host.ts
@opencode-ai/plugin/pack/runtime     -> src/pack/runtime.ts
@opencode-ai/plugin/pack/file-store  -> src/pack/file-store.ts
```

注意：

- `createPeer`/`IpcError`/`ErrorCodes` 从 `@opencode-ai/plugin/ipc` 导入；没有 `./ipc/peer` 或 `./ipc/protocol` 的导出子路径。
- `ContributionLedger`、`PackStore`、`MemoryPackStore`、`parsePackManifest` 从 `@opencode-ai/plugin/pack` 导入；没有 `./pack/ledger` 或 `./pack/store` 的导出子路径。

### 11.4 已存在的核心接线

| 位置 | 作用 |
| --- | --- |
| `packages/opencode/src/pack/pack.ts:31` | 扫描配置目录下的 `packs/*/pack.json` |
| `packages/opencode/src/pack/pack.ts:54` | scope 规则：`project:<id>` 或 `dir:<directory>` |
| `packages/opencode/src/pack/pack.ts:69` | `prompts()`：包装 `<pack_instructions>`、按 priority 降序 |
| `packages/opencode/src/pack/pack.ts:82` | 创建 `PackHost`（`MemoryPackStore` + `ProcessPackRuntime`） |
| `packages/opencode/src/pack/pack.ts:88` | 发现后自动 install + enable |
| `packages/opencode/src/session/prompt.ts:128` | 注入 `Pack.Service` |
| `packages/opencode/src/session/prompt.ts:1281` / `1296` | 把 `packs.prompts()` 拼进 system 数组 |
| `packages/opencode/src/session/prompt.ts:1648` | `Pack.node` 依赖 |

### 11.5 待接的核心适配器

1. **ToolRegistry adapter**：把 `host.contributions("tool")` 转成核心工具定义；解决“工具 id -> IPC method”的映射（manifest 当前没有该字段）；处理禁用/卸载/崩溃后的调用错误。
2. **Agent adapter**：把 `agent` 贡献注册到现有 Agent 注册流程；`PackAgent` 是 passthrough，需要防御性校验。
3. **SystemPrompt adapter**：让 prompt 贡献通过 `SystemPrompt.Service` 组装，而不是在 `session/prompt.ts` 手工拼接；明确 `slot` 的语义（当前没有枚举）。
4. **Web RPC**：为 `rpc` 贡献增加服务器路由/权限校验，前端通过现有 HTTP/SSE 链路调用；不要用 MessagePort 替代 Web 协议。
5. **UI slots**：定义 slot 白名单、`ui.entry` 的安全解析/加载、iframe/worker 沙箱和 CSP；当前 `ui` 完全没有消费方。
6. **持久化**：把 `MemoryPackStore` 换成核心 SQLite 的 `PackStore` 实现；否则产品重启后 pack 状态丢失。
7. **安装/信任流程**：当前发现即 install+enable，没有用户确认；上线前需要安装审批、签名/来源校验（如需要）和错误可见的 UI。

---

## 附录 A：README 与源码差异

以下差异按“可能影响开发判断”排序：

1. **`remove()` 不总是先 `onUnmount` 再 `onDelete`**。`src/ipc/process.ts` 只在 `lifecycle === "mounted"` 时先 `unmount("uninstall")`；如果已经 unmounted/created，直接发 `onDelete`。如果 `onUnmount` 失败，`onDelete` 会被跳过，但进程仍被强杀。
2. **onUnmount 失败时 Host 的兜底范围**。代码会强杀进程，`PackHost.uninstall` 会继续 `store.remove`，但插件侧的 `onDelete` 不会被调用；持久数据只能由 Host 命名空间清理兜底。
3. **`FilePackStore` 路径经过 `encodeURIComponent`**。README 写的是 `data/<pack>/<scope>/<key>.json`；实际 scope 的 `:` 会变成 `%3A`，key 的 `/` 会变成 `%2F`。
4. **pack README 的“核心 adapter 未接入”需要更精确**。ToolRegistry/Agent/SystemPrompt Service 确实未接入；但 `packages/opencode/src/pack/pack.ts` 已经做了发现和 prompt 最小接线，prompt 贡献会进入 system 数组。这不等于工具/Agent/UI 可用。
5. **`api`/`permissions` 只解析不执行**。README 没有声称执行，但开发者容易误以为 manifest 的 permissions 是强制边界；当前不是。
6. **产品发现会自动启用**。README 没有描述 `packs/*/pack.json` 的自动 install+enable 行为；这是当前的实现事实，也是安全上必须知道的点。
