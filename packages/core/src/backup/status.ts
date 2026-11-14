export * as BackupStatus from "./status"

import path from "path"
import { randomBytes } from "crypto"
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises"
import { Schema } from "effect"
import { BackupSettings } from "./settings"

export interface Status {
  readonly lastRunAt?: string
  readonly lastSuccessAt?: string
  readonly lastError?: string
  readonly lastSnapshotID?: string
  readonly lastLogicalBytes?: number
  readonly lastUploadedBytes?: number
  readonly lastDurationMs?: number
  readonly running: boolean
}

export const empty: Status = { running: false }
export const RUNNING_STALE_MS = 24 * 60 * 60 * 1000

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export async function read(stateDirectory: string): Promise<Status> {
  const text = await readFile(BackupSettings.statusFile(stateDirectory), "utf8").catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  })
  if (text === undefined) return empty
  const parsed = decodeJson(text)
  if (parsed._tag === "None" || !isRecord(parsed.value)) return empty

  const value = parsed.value
  const status: Status = {
    running: value.running === true,
    lastRunAt: stringValue(value.lastRunAt),
    lastSuccessAt: stringValue(value.lastSuccessAt),
    lastError: stringValue(value.lastError),
    lastSnapshotID: stringValue(value.lastSnapshotID),
    lastLogicalBytes: numberValue(value.lastLogicalBytes),
    lastUploadedBytes: numberValue(value.lastUploadedBytes),
    lastDurationMs: numberValue(value.lastDurationMs),
  }
  return normalize(prune(status))
}

export function normalize(status: Status, now = Date.now()): Status {
  if (!status.running) return status
  const started = status.lastRunAt ? Date.parse(status.lastRunAt) : Number.NaN
  if (Number.isNaN(started) || now - started > RUNNING_STALE_MS) return { ...status, running: false }
  return status
}

export async function write(stateDirectory: string, status: Status) {
  const file = BackupSettings.statusFile(stateDirectory)
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`
  const content = JSON.stringify(prune(status), null, 2) + "\n"
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await replace(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/\s+/g, " ").slice(0, 2_000)
}

function prune(status: Status): Status {
  return {
    running: status.running,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    lastSnapshotID: status.lastSnapshotID,
    lastLogicalBytes: status.lastLogicalBytes,
    lastUploadedBytes: status.lastUploadedBytes,
    lastDurationMs: status.lastDurationMs,
  }
}

async function replace(source: string, target: string) {
  try {
    await rename(source, target)
  } catch (error) {
    if (!isCode(error, "EEXIST") && !isCode(error, "EPERM") && !isCode(error, "EACCES")) throw error
    await rm(target, { force: true })
    await rename(source, target)
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}