export * as BackupManifest from "./manifest"

import { randomBytes } from "crypto"
import { Schema } from "effect"

export const VERSION = 1

export interface SourceInfo {
  readonly hostname: string
  readonly opencode_version: string
}

export interface FileEntry {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly chunks: readonly string[]
}

export interface Manifest {
  readonly version: 1
  readonly id: string
  readonly created_at: string
  readonly source: SourceInfo
  readonly files: readonly FileEntry[]
  readonly total_bytes: number
}

export class ManifestError extends Schema.TaggedErrorClass<ManifestError>()("Backup.ManifestError", {
  message: Schema.String,
}) {}

const SHA256 = /^[a-f0-9]{64}$/i
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,128}$/
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function newID(now = new Date()) {
  const value = now.toISOString()
  const stamp = `${value.slice(0, 10)}T${value.slice(11, 13)}-${value.slice(14, 16)}-${value.slice(17, 19)}Z`
  return `${stamp}-${randomBytes(4).toString("hex")}`
}

export function validateID(value: unknown) {
  if (typeof value !== "string" || !SNAPSHOT_ID.test(value) || value === "." || value === ".." || value.endsWith(".")) {
    throw new ManifestError({ message: "snapshot id must match ^[A-Za-z0-9._-]{1,128}$" })
  }
  return value
}

export function validatePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw new ManifestError({ message: "manifest file path must be a non-empty string" })
  }
  if (/[\x00-\x1f]/.test(value) || value.includes("\\")) {
    throw new ManifestError({ message: `manifest file path contains forbidden characters: ${value}` })
  }

  const candidates = [value]
  const decoded = decodePercentSequences(value)
  if (decoded !== value) candidates.push(decoded)

  for (const candidate of candidates) {
    if (/[\x00-\x1f]/.test(candidate)) {
      throw new ManifestError({ message: `manifest file path contains control characters: ${value}` })
    }
    if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
      throw new ManifestError({ message: `manifest file path must be relative: ${value}` })
    }
    const parts = candidate.split("/")
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new ManifestError({ message: `manifest file path must not contain empty, '.' or '..' segments: ${value}` })
    }
  }
  return value
}

function decodePercentSequences(value: string) {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (sequence) => {
    try {
      return decodeURIComponent(sequence)
    } catch {
      return sequence
    }
  })
}

export function assertUnique(files: readonly Pick<FileEntry, "path">[]) {
  const seen = new Map<string, string>()
  for (const file of files) {
    const path = validatePath(file.path)
    const key = path.toLowerCase()
    const previous = seen.get(key)
    if (previous !== undefined && previous !== path) {
      throw new ManifestError({ message: `manifest paths collide on Windows: ${previous} and ${path}` })
    }
    if (previous !== undefined) throw new ManifestError({ message: `duplicate manifest path: ${path}` })
    seen.set(key, path)
  }
}

export function create(input: {
  id?: string
  created_at?: string
  source: SourceInfo
  files: readonly FileEntry[]
}): Manifest {
  const id = validateID(input.id ?? newID())
  const created_at = input.created_at ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(created_at))) throw new ManifestError({ message: "created_at must be an ISO 8601 string" })
  if (!input.source.hostname || input.source.hostname.length > 256) {
    throw new ManifestError({ message: "source.hostname must be a string of at most 256 characters" })
  }
  if (!input.source.opencode_version || input.source.opencode_version.length > 256) {
    throw new ManifestError({ message: "source.opencode_version must be a string of at most 256 characters" })
  }
  assertUnique(input.files)

  const files = input.files
    .map((file) => canonicalFile(file))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    version: VERSION,
    id,
    created_at,
    source: { hostname: input.source.hostname, opencode_version: input.source.opencode_version },
    files,
    total_bytes: files.reduce((total, file) => total + file.size, 0),
  }
}

function canonicalFile(file: FileEntry): FileEntry {
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new ManifestError({ message: `file size must be a non-negative integer: ${file.path}` })
  }
  if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
    throw new ManifestError({ message: `file sha256 must be 64 hexadecimal characters: ${file.path}` })
  }
  if (!Array.isArray(file.chunks) || file.chunks.length > 1_000_000) {
    throw new ManifestError({ message: `file chunks must be an array: ${file.path}` })
  }
  const chunks = file.chunks.map((chunk) => {
    if (typeof chunk !== "string" || !SHA256.test(chunk)) {
      throw new ManifestError({ message: `chunk sha256 must be 64 hexadecimal characters: ${file.path}` })
    }
    return chunk.toLowerCase()
  })
  if (file.size === 0 && chunks.length !== 0) {
    throw new ManifestError({ message: `empty file must not reference chunks: ${file.path}` })
  }
  if (file.size > 0 && chunks.length === 0) {
    throw new ManifestError({ message: `non-empty file must reference chunks: ${file.path}` })
  }
  return {
    path: validatePath(file.path),
    size: file.size,
    sha256: file.sha256.toLowerCase(),
    chunks,
  }
}

export function encode(manifest: Manifest) {
  return JSON.stringify(parse(manifest), null, 2) + "\n"
}

export function parseJson(text: string) {
  const decoded = decodeJson(text)
  if (decoded._tag === "None") throw new ManifestError({ message: "manifest is not valid JSON" })
  return parse(decoded.value)
}

export function parse(input: unknown): Manifest {
  if (!isRecord(input)) throw new ManifestError({ message: "manifest must be a JSON object" })
  if (input.version !== VERSION) throw new ManifestError({ message: "manifest version must be 1" })
  if (typeof input.created_at !== "string" || Number.isNaN(Date.parse(input.created_at))) {
    throw new ManifestError({ message: "created_at must be an ISO 8601 string" })
  }
  if (!isRecord(input.source)) throw new ManifestError({ message: "manifest source must be an object" })
  if (typeof input.source.hostname !== "string" || input.source.hostname.length > 256) {
    throw new ManifestError({ message: "source.hostname must be a string of at most 256 characters" })
  }
  if (typeof input.source.opencode_version !== "string" || input.source.opencode_version.length > 256) {
    throw new ManifestError({ message: "source.opencode_version must be a string of at most 256 characters" })
  }
  if (!Array.isArray(input.files) || input.files.length > 100_000) {
    throw new ManifestError({ message: "manifest files must be an array" })
  }

  const files = input.files.map((file) => {
    if (!isRecord(file)) throw new ManifestError({ message: "each manifest file must be an object" })
    return canonicalFile({
      path: file.path as string,
      size: file.size as number,
      sha256: file.sha256 as string,
      chunks: file.chunks as string[],
    })
  })
  assertUnique(files)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (input.total_bytes !== total) {
    throw new ManifestError({ message: "total_bytes does not match file sizes" })
  }

  return {
    version: VERSION,
    id: validateID(input.id),
    created_at: input.created_at,
    source: { hostname: input.source.hostname, opencode_version: input.source.opencode_version },
    files: files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    total_bytes: total,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}