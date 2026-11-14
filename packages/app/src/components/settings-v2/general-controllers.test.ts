import { beforeAll, describe, expect, mock, test, vi } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createPermissionScopeState,
  createShellOptions,
  createSoundPreviewController,
} from "./general-controller-behavior"

function createFakePermission(initialGlobal = false) {
  const [directories, setDirectories] = createSignal(new Set<string>())
  const [sessions, setSessions] = createSignal(new Set<string>())
  const [global, setGlobal] = createSignal(initialGlobal)
  const calls: string[] = []
  const key = (sessionID: string, directory: string) => `${directory}\u0000${sessionID}`

  return {
    directories,
    sessions,
    global,
    calls,
    api: {
      isAutoAccepting(sessionID: string, directory?: string) {
        if (global()) return true
        if (directory && sessions().has(key(sessionID, directory))) return true
        return !!directory && directories().has(directory)
      },
      isAutoAcceptingDirectory(directory: string) {
        return global() || directories().has(directory)
      },
      isAutoAcceptingGlobal() {
        return global()
      },
      enableAutoAccept(sessionID: string, directory: string) {
        calls.push(`enable:${sessionID}:${directory}`)
        setSessions((current) => new Set(current).add(key(sessionID, directory)))
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        calls.push(`disable:${sessionID}:${directory ?? ""}`)
        setSessions((current) => {
          if (!directory) return current
          const next = new Set(current)
          next.delete(key(sessionID, directory))
          return next
        })
      },
      enableAutoAcceptGlobal() {
        calls.push("enable-global")
        setGlobal(true)
      },
      disableAutoAcceptGlobal() {
        calls.push("disable-global")
        setGlobal(false)
        setSessions(new Set<string>())
        setDirectories(new Set<string>())
      },
      toggleAutoAcceptDirectory(directory: string) {
        calls.push(`toggle-directory:${directory}`)
        setDirectories((current) => {
          const next = new Set(current)
          if (next.has(directory)) next.delete(directory)
          else next.add(directory)
          return next
        })
      },
    },
  }
}

let permission = createFakePermission()
const [lineage, setLineage] = createSignal<Record<string, { session: { directory: string } }>>({})
let createPermissionScopeController: (typeof import("./general-controllers"))["createPermissionScopeController"]

beforeAll(async () => {
  mock.module("@/context/permission", () => ({ usePermission: () => permission.api }))
  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        lineage: {
          peek: (id: string) => lineage()[id],
        },
      },
    }),
  }))
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({}) }))
  mock.module("@/context/settings", () => ({
    monoDefault: "",
    monoFontFamily: () => "",
    monoInput: (value: string) => value,
    sansDefault: "",
    sansFontFamily: () => "",
    sansInput: (value: string) => value,
    terminalDefault: "",
    terminalFontFamily: () => "",
    terminalInput: (value: string) => value,
    useSettings: () => ({}),
  }))
  mock.module("@opencode-ai/ui/theme/context", () => ({ useTheme: () => ({}) }))
  mock.module("@/utils/sound", () => ({ SOUND_OPTIONS: [], playSoundById: async () => undefined }))

  const mod = await import("./general-controllers")
  createPermissionScopeController = mod.createPermissionScopeController
})

describe("permission scope state", () => {
  test("falls back to directory auto-accept without a session", () => {
    const calls: string[] = []
    const state = createPermissionScopeState({
      sessionID: () => undefined,
      directory: () => "/repo",
      permission: {
        isAutoAccepting: () => false,
        isAutoAcceptingDirectory: (directory) => directory === "/on",
        isAutoAcceptingGlobal: () => false,
        enableAutoAccept: () => undefined,
        disableAutoAccept: () => undefined,
        enableAutoAcceptGlobal: () => undefined,
        disableAutoAcceptGlobal: () => undefined,
        toggleAutoAcceptDirectory: (directory) => calls.push(directory),
      },
    })

    expect(state.scope()).toBe("directory")
    expect(state.accepting()).toBe(false)
    state.set(true)
    expect(calls).toEqual(["/repo"])
  })

  test("keeps session scope when a session is present", () => {
    const calls: string[] = []
    const state = createPermissionScopeState({
      sessionID: () => "ses_1",
      directory: () => "/repo",
      permission: {
        isAutoAccepting: () => true,
        isAutoAcceptingDirectory: () => false,
        isAutoAcceptingGlobal: () => false,
        enableAutoAccept: (sessionID, directory) => calls.push(`enable:${sessionID}:${directory}`),
        disableAutoAccept: (sessionID, directory) => calls.push(`disable:${sessionID}:${directory}`),
        enableAutoAcceptGlobal: () => calls.push("enable-global"),
        disableAutoAcceptGlobal: () => calls.push("disable-global"),
        toggleAutoAcceptDirectory: (directory) => calls.push(`toggle-directory:${directory}`),
      },
    })

    expect(state.scope()).toBe("session")
    expect(state.accepting()).toBe(true)
    state.set(true)
    state.set(false)
    expect(calls).toEqual(["enable:ses_1:/repo", "disable:ses_1:/repo"])
  })

  test("uses global auto-accept without a directory", () => {
    const calls: string[] = []
    let global = false
    const state = createPermissionScopeState({
      sessionID: () => "ses_1",
      directory: () => undefined,
      permission: {
        isAutoAccepting: () => global,
        isAutoAcceptingDirectory: () => global,
        isAutoAcceptingGlobal: () => global,
        enableAutoAccept: () => undefined,
        disableAutoAccept: () => undefined,
        enableAutoAcceptGlobal: () => {
          global = true
          calls.push("enable-global")
        },
        disableAutoAcceptGlobal: () => {
          global = false
          calls.push("disable-global")
        },
        toggleAutoAcceptDirectory: () => undefined,
      },
    })

    expect(state.scope()).toBe("global")
    expect(state.enabled()).toBe(true)
    expect(state.accepting()).toBe(false)
    state.set(true)
    expect(calls).toEqual(["enable-global"])
    state.set(false)
    expect(calls).toEqual(["enable-global", "disable-global"])
  })

  test("global state wins with a directory and can be disabled", () => {
    const calls: string[] = []
    let global = true
    const state = createPermissionScopeState({
      sessionID: () => undefined,
      directory: () => "/repo",
      permission: {
        isAutoAccepting: () => global,
        isAutoAcceptingDirectory: () => global,
        isAutoAcceptingGlobal: () => global,
        enableAutoAccept: () => undefined,
        disableAutoAccept: () => undefined,
        enableAutoAcceptGlobal: () => {
          global = true
          calls.push("enable-global")
        },
        disableAutoAcceptGlobal: () => {
          global = false
          calls.push("disable-global")
        },
        toggleAutoAcceptDirectory: () => calls.push("toggle-directory"),
      },
    })

    expect(state.enabled()).toBe(true)
    expect(state.accepting()).toBe(true)
    state.set(false)
    expect(calls).toEqual(["disable-global"])
  })
})

describe("permission scope controller", () => {
  test("prefers the route directory and keeps session scope", () => {
    permission = createFakePermission()
    setLineage({ ses_1: { session: { directory: "/lineage" } } })
    createRoot((dispose) => {
      const scope = createPermissionScopeController(
        () => "ses_1",
        () => "/route",
      )

      expect(scope.scope()).toBe("session")
      expect(scope.enabled()).toBe(true)
      scope.set(true)
      expect(permission.calls).toEqual(["enable:ses_1:/route"])
      dispose()
    })
  })

  test("uses directory auto-accept when the route has no session", () => {
    permission = createFakePermission()
    setLineage({})
    createRoot((dispose) => {
      const scope = createPermissionScopeController(
        () => undefined,
        () => "/route",
      )

      expect(scope.scope()).toBe("directory")
      expect(scope.enabled()).toBe(true)
      scope.set(true)
      expect(permission.calls).toEqual(["toggle-directory:/route"])
      scope.set(true)
      expect(permission.calls).toEqual(["toggle-directory:/route"])
      scope.set(false)
      expect(permission.calls).toEqual(["toggle-directory:/route", "toggle-directory:/route"])
      dispose()
    })
  })

  test("resolves the session directory from lineage when the route has none", () => {
    permission = createFakePermission()
    setLineage({ ses_1: { session: { directory: "/lineage" } } })
    createRoot((dispose) => {
      const scope = createPermissionScopeController(() => "ses_1")

      expect(scope.enabled()).toBe(true)
      scope.set(true)
      expect(permission.calls).toEqual(["enable:ses_1:/lineage"])
      dispose()
    })
  })

  test("falls back to global auto-accept when neither the route nor lineage has a directory", () => {
    permission = createFakePermission()
    setLineage({})
    createRoot((dispose) => {
      const scope = createPermissionScopeController(
        () => undefined,
        () => undefined,
      )

      expect(scope.scope()).toBe("global")
      expect(scope.enabled()).toBe(true)
      expect(scope.accepting()).toBe(false)
      scope.set(true)
      expect(permission.calls).toEqual(["enable-global"])
      expect(permission.global()).toBe(true)
      scope.set(false)
      expect(permission.calls).toEqual(["enable-global", "disable-global"])
      expect(permission.global()).toBe(false)
      dispose()
    })
  })

  test("shows global auto-accept with a directory and disables it", () => {
    permission = createFakePermission(true)
    setLineage({ ses_1: { session: { directory: "/lineage" } } })
    createRoot((dispose) => {
      const scope = createPermissionScopeController(
        () => "ses_1",
        () => "/route",
      )

      expect(scope.scope()).toBe("session")
      expect(scope.enabled()).toBe(true)
      expect(scope.accepting()).toBe(true)
      scope.set(false)
      expect(permission.calls).toEqual(["disable-global"])
      dispose()
    })
  })

  test("turning global off clears session auto-accept", () => {
    permission = createFakePermission(true)
    setLineage({ ses_1: { session: { directory: "/route" } } })
    permission.api.enableAutoAccept("ses_1", "/route")
    createRoot((dispose) => {
      const scope = createPermissionScopeController(
        () => "ses_1",
        () => "/route",
      )

      expect(scope.accepting()).toBe(true)
      scope.set(false)
      expect(permission.calls).toEqual(["enable:ses_1:/route", "disable-global"])
      expect(permission.api.isAutoAccepting("ses_1", "/route")).toBe(false)
      dispose()
    })
  })
})

describe("settings v2 controllers", () => {
  test("normalizes shell names and preserves an unavailable configured shell", () => {
    expect(
      createShellOptions({
        shells: [
          { path: "/bin/bash", name: "bash", acceptable: true },
          { path: "/opt/bash", name: "bash", acceptable: false },
          { path: "/bin/zsh", name: "zsh", acceptable: true },
        ],
        current: "fish",
      }),
    ).toEqual([
      { id: "auto", value: "", name: "", terminalOnly: false },
      { id: "/bin/bash", value: "/bin/bash", name: "/bin/bash", terminalOnly: false },
      { id: "/opt/bash", value: "/opt/bash", name: "/opt/bash", terminalOnly: true },
      { id: "/bin/zsh", value: "zsh", name: "zsh", terminalOnly: false },
      { id: "fish", value: "fish", name: "fish", terminalOnly: false },
    ])
  })

  test("debounces previews and stops owned audio on disposal", async () => {
    vi.useFakeTimers()
    try {
      const played: string[] = []
      const stopped: string[] = []
      const owned = createRoot((dispose) => ({
        dispose,
        preview: createSoundPreviewController(async (id) => {
          played.push(id ?? "")
          return () => stopped.push(id ?? "")
        }),
      }))

      owned.preview.play("first")
      vi.advanceTimersByTime(99)
      expect(played).toEqual([])

      owned.preview.play("second")
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(played).toEqual(["second"])

      owned.dispose()
      expect(stopped).toEqual(["second"])
    } finally {
      vi.useRealTimers()
    }
  })
})
