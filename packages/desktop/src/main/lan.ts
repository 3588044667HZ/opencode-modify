import { safeStorage } from "electron"
import type { LanAccessInput, LanAccessStatus } from "@opencode-ai/app"

import { lanUrls, startLanProxy, type LanProxy, type LanProxyTarget } from "./lan-proxy"
import { getStore } from "./store"
import { generatePassword, normalizeTarget, passwordError, sameTarget } from "./lan-settings"
import { parseProjectDirectories } from "./lan-projects"
import { LAN_ACCESS_ENABLED_KEY, LAN_ACCESS_PASSWORD_KEY, LAN_ACCESS_PORT_KEY } from "./store-keys"

const HOSTNAME = "0.0.0.0"
const DEFAULT_PORT = 4096
const ENCRYPTED_PREFIX = "encrypted:"
const PLAIN_PREFIX = "plain:"
const GLOBAL_STORE = "opencode.global.dat"

type LanAccessLogger = {
  log: (message: string, meta?: unknown) => void
  warn: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

export type LanAccessController = ReturnType<typeof createLanAccess>

export function createLanAccess(log: LanAccessLogger, staticRoot?: string) {
  let target: LanProxyTarget | undefined
  let proxy: LanProxy | undefined
  let activeTarget: LanProxyTarget | undefined
  let activePassword: string | undefined
  let lastError: string | undefined
  let plainPasswordWarning = false
  let decryptErrorLogged = false
  let pending: Promise<unknown> = Promise.resolve()

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = pending.then(task, task)
    pending = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const encryptionAvailable = () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  const readPassword = (raw: unknown) => {
    if (typeof raw !== "string" || raw.length === 0) return ""
    if (raw.startsWith(PLAIN_PREFIX)) return raw.slice(PLAIN_PREFIX.length)
    if (!raw.startsWith(ENCRYPTED_PREFIX)) return raw
    if (!encryptionAvailable()) {
      log.error("lan access password is encrypted but OS encryption is unavailable")
      return ""
    }
    try {
      return safeStorage.decryptString(Buffer.from(raw.slice(ENCRYPTED_PREFIX.length), "base64"))
    } catch (error) {
      if (!decryptErrorLogged) {
        decryptErrorLogged = true
        log.error("failed to decrypt lan access password", { error: describe(error) })
      }
      return ""
    }
  }

  const writePassword = (password: string) => {
    const store = getStore()
    if (!password) {
      store.set(LAN_ACCESS_PASSWORD_KEY, "")
      return
    }
    if (encryptionAvailable()) {
      try {
        store.set(LAN_ACCESS_PASSWORD_KEY, ENCRYPTED_PREFIX + safeStorage.encryptString(password).toString("base64"))
        return
      } catch (error) {
        log.warn("failed to encrypt lan access password", { error: describe(error) })
      }
    }
    if (!plainPasswordWarning) {
      plainPasswordWarning = true
      log.warn("lan access password stored without OS encryption because safeStorage is unavailable")
    }
    store.set(LAN_ACCESS_PASSWORD_KEY, PLAIN_PREFIX + password)
  }

  const readPort = () => {
    const value = getStore().get(LAN_ACCESS_PORT_KEY)
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined
  }

  const writePort = (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return
    getStore().set(LAN_ACCESS_PORT_KEY, port)
  }

  const readState = () => {
    const store = getStore()
    return {
      enabled: store.get(LAN_ACCESS_ENABLED_KEY) === true,
      password: readPassword(store.get(LAN_ACCESS_PASSWORD_KEY)),
    }
  }

  const writeState = (enabled: boolean, password: string) => {
    const store = getStore()
    store.set(LAN_ACCESS_ENABLED_KEY, enabled)
    writePassword(password)
  }

  const ensurePassword = (enabled: boolean, password: string) => {
    if (!enabled || password) return password
    if (activePassword) return activePassword
    const generated = generatePassword()
    writePassword(generated)
    return generated
  }

  const status = (enabled: boolean, password: string, error = lastError): LanAccessStatus => {
    const port = proxy?.port
    return {
      enabled,
      password,
      running: proxy !== undefined,
      ...(port === undefined ? {} : { port }),
      urls: port === undefined ? [] : lanUrls(port),
      ...(error ? { error } : {}),
    }
  }

  const stopProxy = async () => {
    const current = proxy
    proxy = undefined
    activeTarget = undefined
    activePassword = undefined
    if (current) await current.stop()
  }

  const startProxy = async (nextTarget: LanProxyTarget, password: string) => {
    const options = { target: nextTarget, hostname: HOSTNAME, password, staticRoot, projectList: readProjectDirectories }
    const preferred = readPort()
    const ports = [...new Set([preferred, DEFAULT_PORT, 0].filter((port): port is number => port !== undefined))]
    let last: unknown
    for (const port of ports) {
      try {
        const proxy = await startLanProxy({ ...options, port })
        writePort(proxy.port)
        return proxy
      } catch (error) {
        last = error
        log.warn("lan access proxy port unavailable", { port, error: describe(error) })
      }
    }
    throw last
  }

  const apply = async (enabled: boolean, password: string) => {
    if (!enabled) {
      await stopProxy()
      lastError = undefined
      return status(false, password)
    }
    if (!target) {
      lastError = undefined
      return status(true, password)
    }
    if (proxy && activePassword === password && sameTarget(activeTarget, target)) {
      lastError = undefined
      return status(true, password)
    }
    await stopProxy()
    try {
      proxy = await startProxy(target, password)
      activeTarget = target
      activePassword = password
      lastError = undefined
      log.log("lan access proxy started", { port: proxy.port })
    } catch (error) {
      lastError = describe(error)
      log.error("failed to start lan access proxy", { error: lastError })
    }
    return status(enabled, password)
  }

  const attach = (input: LanProxyTarget) =>
    serial(async () => {
      target = normalizeTarget(input)
      const state = readState()
      return apply(state.enabled, ensurePassword(state.enabled, state.password))
    })

  const get = () =>
    serial(async () => {
      const state = readState()
      return status(state.enabled, ensurePassword(state.enabled, state.password))
    })

  const set = (input: LanAccessInput) =>
    serial(async () => {
      const state = readState()
      if (!input || typeof input.enabled !== "boolean" || typeof input.password !== "string") {
        return status(state.enabled, state.password, "Invalid LAN access settings")
      }
      const password = input.enabled && !input.password ? generatePassword() : input.password
      if (input.enabled) {
        const error = passwordError(password)
        if (error) return status(state.enabled, state.password, error)
      }
      writeState(input.enabled, password)
      return apply(input.enabled, password)
    })

  const stop = () =>
    serial(async () => {
      target = undefined
      lastError = undefined
      await stopProxy()
    })

  return { attach, get, set, stop }
}


function readProjectDirectories() {
  try {
    return parseProjectDirectories(getStore(GLOBAL_STORE).get("server"))
  } catch {
    return { directories: [] }
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
