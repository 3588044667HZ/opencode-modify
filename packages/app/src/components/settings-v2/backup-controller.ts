import type {
  BackupConfigureInput,
  BackupRunResult,
  BackupSnapshotSummary,
  BackupStatus,
} from "@opencode-ai/sdk/v2/client"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"

export interface BackupApi {
  status: () => Promise<BackupStatus>
  run: () => Promise<BackupRunResult>
  snapshots: (input?: { limit?: number }) => Promise<readonly BackupSnapshotSummary[]>
  configure: (input: BackupConfigureInput) => Promise<BackupStatus>
}

export interface BackupSettingsControllerOptions {
  api: BackupApi
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  pollAttempts?: number
}

export interface BackupForm {
  server: string
  username: string
  token: string
  schedule: string
  enabled: boolean
}

export type BackupActionResult = { ok: true } | { ok: false; message?: string }

interface BackupSettingsState {
  status: BackupStatus | undefined
  snapshots: readonly BackupSnapshotSummary[]
  form: BackupForm
  statusError: string | undefined
  snapshotsError: string | undefined
  loading: boolean
  loadingSnapshots: boolean
  saving: boolean
  running: boolean
}

const DEFAULT_SCHEDULE = "30 3 * * *"
const SNAPSHOT_LIMIT = 20

export function createBackupSettingsController(options: BackupSettingsControllerOptions) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const pollAttempts = options.pollAttempts ?? 120

  const [state, setState] = createStore<BackupSettingsState>({
    status: undefined,
    snapshots: [],
    form: {
      server: "",
      username: "",
      token: "",
      schedule: DEFAULT_SCHEDULE,
      enabled: false,
    },
    statusError: undefined,
    snapshotsError: undefined,
    loading: false,
    loadingSnapshots: false,
    saving: false,
    running: false,
  })

  const applyStatus = (next: BackupStatus, resetToken: boolean) => {
    setState("status", next)
    setState("running", next.running)
    setState("form", {
      server: next.server ?? "",
      username: next.username ?? "",
      schedule: next.schedule || DEFAULT_SCHEDULE,
      enabled: next.enabled,
      token: resetToken ? "" : state.form.token,
    })
  }

  const reloadStatus = async () => {
    setState("loading", true)
    setState("statusError", undefined)
    try {
      const next = await options.api.status()
      applyStatus(next, true)
      return next
    } catch (error) {
      setState("statusError", errorMessage(error))
      return undefined
    } finally {
      setState("loading", false)
    }
  }

  const reloadSnapshots = async () => {
    setState("loadingSnapshots", true)
    setState("snapshotsError", undefined)
    try {
      setState("snapshots", await options.api.snapshots({ limit: SNAPSHOT_LIMIT }))
    } catch (error) {
      setState("snapshotsError", errorMessage(error))
    } finally {
      setState("loadingSnapshots", false)
    }
  }

  const refresh = async () => {
    const next = await reloadStatus()
    if (next?.configured) await reloadSnapshots()
    return next
  }

  const setField = <K extends keyof BackupForm>(key: K, value: BackupForm[K]) => {
    setState("form", key, value)
  }

  const save = async (): Promise<BackupActionResult> => {
    if (state.saving) return { ok: false }
    setState("saving", true)
    setState("statusError", undefined)
    try {
      const input: BackupConfigureInput = {
        enabled: state.form.enabled,
        server: state.form.server.trim(),
        username: state.form.username.trim(),
        schedule: state.form.schedule.trim(),
      }
      if (state.form.token.length) input.token = state.form.token
      const next = await options.api.configure(input)
      applyStatus(next, true)
      if (next.configured) await reloadSnapshots()
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      setState("statusError", message)
      return { ok: false, message }
    } finally {
      setState("saving", false)
    }
  }

  const run = async (): Promise<BackupActionResult> => {
    if (state.running || !state.status?.configured) return { ok: false }
    setState("running", true)
    setState("statusError", undefined)
    try {
      await options.api.run()
      let inactive = 0
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        const current = await options.api.status()
        applyStatus(current, false)
        if (current.running) {
          inactive = 0
          continue
        }
        inactive += 1
        if (inactive >= 2) break
        await sleep(pollIntervalMs)
      }
      if (state.status?.configured) await reloadSnapshots()
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      setState("running", false)
      setState("statusError", message)
      return { ok: false, message }
    }
  }

  const canRun = createMemo(() => Boolean(state.status?.configured) && !state.running && !state.saving)

  return {
    state,
    canRun,
    refresh,
    reloadStatus,
    reloadSnapshots,
    setField,
    save,
    run,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const

export function formatByteSize(value: number | undefined, locale: string) {
  if (value === undefined) return "—"
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })
  return `${formatter.format(size)} ${BYTE_UNITS[unit]}`
}