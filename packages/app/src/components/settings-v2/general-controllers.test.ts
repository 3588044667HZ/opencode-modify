import { beforeAll, describe, expect, mock, test, vi } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createPermissionScopeState,
  createShellOptions,
  createSoundPreviewController,
} from "./general-controller-behavior"

function createFakePermission() {
  const [directories, setDirectories] = createSignal(new Set<string>())
  const [sessions, setSessions] = createSignal(new Set<string>())
  const calls: string[] = []
  const key = (sessionID: string, directory: string) => `${directory}\u0000${sessionID}`

  return {
    directories,
    sessions,
    calls,
    api: {
      isAutoAccepting(sessionID: string, directory?: string) {
        if (directory && sessions().has(key(sessionID, directory))) return true
        return !!directory && directories().has(directory)
      },
      isAutoAcceptingDirectory(directory: string) {
        return directories().has(directory)
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
        enableAutoAccept: () => undefined,
        disableAutoAccept: () => undefined,
        toggleAutoAcceptDirectory: (directory) => calls.push(directory),
      },
    })

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
        enableAutoAccept: (sessionID, directory) => calls.push(`enable:${sessionID}:${directory}`),
        disableAutoAccept: (sessionID, directory) => calls.push(`disable:${sessionID}:${directory}`),
        toggleAutoAcceptDirectory: (directory) => calls.push(`toggle-directory:${directory}`),
      },
    })

    expect(state.accepting()).toBe(true)
    state.set(true)
    state.set(false)
    expect(calls).toEqual(["enable:ses_1:/repo", "disable:ses_1:/repo"])
  })

  test("stays disabled without a directory", () => {
    const state = createPermissionScopeState({
      sessionID: () => "ses_1",
      directory: () => undefined,
      permission: {
        isAutoAccepting: () => true,
        isAutoAcceptingDirectory: () => true,
        enableAutoAccept: () => undefined,
        disableAutoAccept: () => undefined,
        toggleAutoAcceptDirectory: () => undefined,
      },
    })

    expect(state.enabled()).toBe(false)
    expect(state.accepting()).toBe(false)
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

  test("stays disabled when neither the route nor lineage has a directory", () => {
    permission = createFakePermission()
    setLineage({})
    createRoot((dispose) => {
      const scope = createPermissionScopeController(() => "ses_1")

      expect(scope.enabled()).toBe(false)
      scope.set(true)
      expect(permission.calls).toEqual([])
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
