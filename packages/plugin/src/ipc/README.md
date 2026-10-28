# Plugin IPC

这是 cockpit 自有的插件 IPC 通道，不依赖上游 OpenCode 或 DSH。

它解决两个边界：

- Host ↔ 插件子进程：stdio 上的换行分隔 JSON-RPC
- Host/Web ↔ 插件 Worker/iframe：MessagePort 上的同一套 JSON-RPC

Web ↔ Server 本身继续使用现有 HTTP/SSE；本包不重新发明远程协议，只提供插件运行时的进程/线程通道。

## Host 侧

```ts
import { spawnPlugin } from "@opencode-ai/plugin/ipc/process"

const plugin = await spawnPlugin({
  command: process.execPath,
  args: ["my-plugin.js"],
  pluginId: "my-plugin",
})

await plugin.mount({
  project: { directory: "/repo" },
  config: { /* pack config */ },
})

const result = await plugin.peer.request("my.tool", { value: 1 })

await plugin.unmount("disable") // 保留数据，释放运行时资源
await plugin.mount()            // 可以再次启用
await plugin.remove()           // 卸载：onUnmount + onDelete + 杀进程
```

生命周期方法走 JSON-RPC：

- `initialize`：握手，校验协议版本和 token
- `onMount`：注册工具、监听器、定时器、子进程等
- `onUnmount`：释放运行时资源，**不要删除持久数据**
- `onDelete`：删除插件自己的持久数据、配置、缓存、临时文件

Host 的 `remove()` 会先调用 `onUnmount`，再调用 `onDelete`，最后终止进程。即使插件清理失败，Host 也必须继续杀掉进程并清理命名空间；插件不能成为残留资源的唯一负责方。

## 插件侧

```ts
import { createPluginPeer } from "@opencode-ai/plugin/ipc/lifecycle"
import { createStdioTransport } from "@opencode-ai/plugin/ipc/stdio"

const plugin = createPluginPeer(
  createStdioTransport({ input: process.stdin, output: process.stdout }),
  {
    onMount(context) {
      context.effect(() => {
        // 自动在卸载时执行
      })
    },
    async onUnmount(context) {
      // 释放连接、watch、timer
      // 不要删除持久数据
    },
    async onDelete(context) {
      // 删除插件命名空间下的持久数据
    },
  },
)

plugin.peer.onRequest("my.tool", (params) => {
  return { ok: true, params }
})
```

`context.effect(cleanup)` 会被 Host 的生命周期调用自动执行，即使 `onMount` 后半段抛错也会清理已经注册的 effect。`onUnmount` 抛错时，已注册的 effect 仍会执行。

## 协议

JSON-RPC 2.0，换行分隔，UTF-8：

```json
{"jsonrpc":"2.0","id":"abc-1","method":"my.tool","params":{"value":1}}
{"jsonrpc":"2.0","id":"abc-1","result":{"ok":true}}
```

支持：

- request / response / notification
- `$/cancelRequest`
- 超时
- AbortSignal
- 方法未找到
- 错误码
- 最大帧大小
- 关闭时拒绝所有 pending 请求

## 安全边界

- 子进程插件必须只使用 `stdin/stdout` 传输协议；日志写 `stderr`
- Host 通过 `plugin.peer.onRequest()` 注册的每个方法就是白名单
- 不要给子进程传递不必要环境变量；需要时显式传 `env`
- `token` 在 initialize 中传递，并自动注入子进程的 `OPENCODE_PACK_TOKEN`；`createPluginPeer` 默认读取该 env 并校验
- 进程内插件无法做到安全隔离；第三方必须使用子进程/worker
- `remove()` 后 Host 仍应清理插件命名空间，不能只依赖 `onDelete`

## 约束

- `onMount` / `onUnmount` / `onDelete` 必须幂等
- `onUnmount` 不删除持久数据
- `onDelete` 执行前 Host 已执行 `onUnmount`
- 生命周期超时后 Host 会终止进程
- 插件崩溃时 Host 负责移除贡献和清理命名空间
- 历史 session 记录不因删除插件而删除
