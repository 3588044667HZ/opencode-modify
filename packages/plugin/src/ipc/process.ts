import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { isRecord, IPC_PROTOCOL_VERSION } from "./protocol.js"
import { createPeer, type Peer } from "./peer.js"
import type { LifecycleReason } from "./lifecycle.js"
import { createStdioTransport } from "./stdio.js"

export type SpawnPluginOptions = {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  pluginId?: string
  token?: string
  handshakeTimeoutMs?: number
  lifecycleTimeoutMs?: number
  stopTimeoutMs?: number
  maxMessageBytes?: number
  onStderr?: (chunk: string) => void
}

export type PluginLifecycle = "created" | "mounted" | "unmounted" | "deleted"

export type PluginMountInput = {
  scope?: string
  project?: { id?: string; directory?: string }
  config?: unknown
  capabilities?: string[]
}

export type PluginProcess = {
  pid: number | undefined
  child: ChildProcess
  peer: Peer
  token: string
  lifecycle: PluginLifecycle
  exited: Promise<void>
  mount(input?: PluginMountInput): Promise<void>
  unmount(reason?: LifecycleReason): Promise<void>
  remove(): Promise<void>
  stop(options?: { force?: boolean }): Promise<void>
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.on("error", () => undefined)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process already exited.
    }
  }
}

function waitExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      child.off("exit", done)
      child.off("error", done)
      resolve()
    }
    child.once("exit", done)
    child.once("error", done)
  })
}

export async function spawnPlugin(options: SpawnPluginOptions): Promise<PluginProcess> {
  const token = options.token ?? randomBytes(16).toString("hex")
  const child = await new Promise<ChildProcess>((resolve, reject) => {
    const spawned = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), OPENCODE_PACK_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    spawned.once("spawn", () => resolve(spawned))
    spawned.once("error", reject)
  })
  if (!child.stdin || !child.stdout) {
    child.kill()
    throw new Error("IPC plugin process requires stdin and stdout pipes")
  }
  if (options.onStderr && child.stderr) {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk))
  }
  const peer = createPeer(
    createStdioTransport({
      input: child.stdout,
      output: child.stdin,
      maxMessageBytes: options.maxMessageBytes,
    }),
  )
  const exited = waitExit(child)
  let stopping = false
  child.once("close", (code, signal) => {
    if (!stopping) void peer.close(new Error(`IPC plugin exited (${code ?? "signal"}${signal ? `:${signal}` : ""})`))
  })

  let lifecycle: PluginLifecycle = "created"
  let mountedInput: PluginMountInput | undefined
  let terminatePromise: Promise<void> | undefined
  const lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 10_000

  const terminate = (force = false) => {
    terminatePromise ??= (async () => {
      stopping = true
      const timeoutMs = options.stopTimeoutMs ?? 1_000
      await peer.close()
      const exitedInTime = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)])
      if (force || !exitedInTime) {
        signalTree(child, "SIGTERM")
        const termInTime = await Promise.race([exited.then(() => true), delay(force ? 100 : 500).then(() => false)])
        if (force || !termInTime) {
          signalTree(child, "SIGKILL")
          await exited
        }
      }
    })()
    return terminatePromise
  }

  const stop = (stopOptions: { force?: boolean } = {}) => {
    if (stopOptions.force || lifecycle !== "mounted") return terminate(stopOptions.force)
    return (async () => {
      await unmount("shutdown").catch(() => undefined)
      await terminate()
    })()
  }

  const mount = async (input: PluginMountInput = {}) => {
    if (lifecycle === "deleted") throw new Error("Plugin has been deleted")
    if (lifecycle === "mounted") return
    try {
      await peer.request(
        "onMount",
        {
          protocol: IPC_PROTOCOL_VERSION,
          pluginId: options.pluginId ?? "plugin",
          ...input,
        },
        { timeoutMs: lifecycleTimeoutMs },
      )
      mountedInput = input
      lifecycle = "mounted"
    } catch (error) {
      lifecycle = "unmounted"
      await terminate(true)
      throw error
    }
  }

  const unmount = async (reason: LifecycleReason = "disable") => {
    if (lifecycle === "deleted" || lifecycle === "unmounted" || lifecycle === "created") {
      lifecycle = lifecycle === "deleted" ? "deleted" : "unmounted"
      return
    }
    try {
      await peer.request(
        "onUnmount",
        {
          ...mountedInput,
          protocol: IPC_PROTOCOL_VERSION,
          pluginId: options.pluginId ?? "plugin",
          reason,
        },
        { timeoutMs: lifecycleTimeoutMs },
      )
      lifecycle = "unmounted"
    } catch (error) {
      lifecycle = "unmounted"
      await terminate(true)
      throw error
    }
  }

  const remove = async () => {
    if (lifecycle === "deleted") return
    let failure: unknown
    if (lifecycle === "mounted") {
      await unmount("uninstall").catch((error: unknown) => {
        failure = error
      })
    }
    if (!failure) {
      await peer
        .request(
          "onDelete",
          {
            ...mountedInput,
            protocol: IPC_PROTOCOL_VERSION,
            pluginId: options.pluginId ?? "plugin",
            reason: "uninstall",
          },
          { timeoutMs: lifecycleTimeoutMs },
        )
        .catch((error: unknown) => {
          failure = error
        })
    }
    lifecycle = "deleted"
    await terminate(true)
    if (failure) throw failure
  }

  try {
    const response = await peer.request(
      "initialize",
      {
        protocol: IPC_PROTOCOL_VERSION,
        pluginId: options.pluginId ?? "plugin",
        token,
        capabilities: [],
      },
      { timeoutMs: options.handshakeTimeoutMs ?? 5_000 },
    )
    if (!isRecord(response) || response.protocol !== IPC_PROTOCOL_VERSION) {
      throw new Error("IPC plugin protocol version mismatch")
    }
  } catch (error) {
    await terminate(true)
    throw error
  }

  return {
    pid: child.pid,
    child,
    peer,
    token,
    get lifecycle() {
      return lifecycle
    },
    exited,
    mount,
    unmount,
    remove,
    stop,
  }
}
