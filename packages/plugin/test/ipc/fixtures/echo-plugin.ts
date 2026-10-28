import { createPluginPeer } from "../../../src/ipc/lifecycle"
import { createStdioTransport } from "../../../src/ipc/stdio"

const trace: string[] = []

const plugin = createPluginPeer(
  createStdioTransport({ input: process.stdin, output: process.stdout }),
  {
    onMount(context) {
      trace.push("mount")
      context.effect(() => {
        trace.push("cleanup")
      })
    },
    onUnmount(context) {
      trace.push(`unmount:${context.reason}`)
    },
    async onDelete() {
      trace.push("delete")
      await plugin.peer.request("report", { trace: [...trace] })
    },
  },
  { pluginId: "echo", version: "1.0.0", token: process.env.OPENCODE_PACK_TOKEN },
)

plugin.peer.onRequest("echo", (params) => params)
plugin.peer.onRequest("trace", () => trace)
