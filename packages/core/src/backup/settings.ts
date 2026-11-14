export * as BackupSettings from "./settings"

import path from "path"
import { randomBytes } from "crypto"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises"
import { Schema } from "effect"
import { ConfigBackup } from "../config/backup"
import { Flag } from "../flag/flag"
import type { ParseError } from "jsonc-parser"
import { applyEdits, modify, parse } from "jsonc-parser"

export const DEFAULT_SCHEDULE = "30 3 * * *"
export const DEFAULT_RETENTION = 7

export interface Settings {
  readonly enabled: boolean
  readonly server?: string
  readonly username?: string
  readonly schedule: string
  readonly retention: number
  readonly includeToolOutput: boolean
  readonly includeSnapshots: boolean
  readonly includeProjectConfig: boolean
}

export const defaults: Settings = {
  enabled: false,
  schedule: DEFAULT_SCHEDULE,
  retention: DEFAULT_RETENTION,
  includeToolOutput: true,
  includeSnapshots: false,
  includeProjectConfig: false,
}

export class SettingsError extends Schema.TaggedErrorClass<SettingsError>()("Backup.SettingsError", {
  message: Schema.String,
}) {}

export type AuthMethod = "token" | "password"

export interface Auth {
  readonly server: string
  readonly username: string
  readonly secret: string
  readonly method?: AuthMethod
  readonly savedAt: string
}

const AuthMethodSchema = Schema.Literals(["token", "password"])

const AuthJson = Schema.Struct({
  server: Schema.String,
  username: Schema.String,
  method: Schema.optional(AuthMethodSchema),
  secret: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  savedAt: Schema.String,
})

const decodeAuth = Schema.decodeUnknownOption(AuthJson)
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeSection = Schema.decodeUnknownOption(ConfigBackup.Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

export interface Loaded {
  readonly settings: Settings
  readonly configPath?: string
}

export function globalConfigCandidates(configDirectory: string) {
  return ["opencode.jsonc", "opencode.json", "config.json"].map((file) => path.join(configDirectory, file))
}

export function configFiles(configDirectory: string, extra: readonly string[] = []) {
  const files = globalConfigCandidates(configDirectory).toReversed()
  if (Flag.OPENCODE_CONFIG && !files.includes(Flag.OPENCODE_CONFIG)) files.push(Flag.OPENCODE_CONFIG)
  for (const file of extra) if (!files.includes(file)) files.push(file)
  return files
}

export async function load(input: {
  configDirectory: string
  files?: readonly string[]
}): Promise<Loaded> {
  const files = input.files ?? configFiles(input.configDirectory)
  let merged: ConfigBackup.Info | undefined
  let configPath: string | undefined

  for (const file of files) {
    const text = await readFile(file, "utf8").catch((error: unknown) => {
      if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
      throw error
    })
    if (text === undefined) continue

    const errors: ParseError[] = []
    const value: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length) throw new SettingsError({ message: `invalid JSONC in ${file}` })
    if (!isRecord(value) || value.backup === undefined) continue

    const decoded = decodeSection(value.backup)
    if (decoded._tag === "None") {
      throw new SettingsError({ message: `invalid backup configuration in ${file}` })
    }
    merged = mergeSection(merged, decoded.value)
    configPath = file
  }

  const enabled = merged?.enabled ?? defaults.enabled
  const schedule = merged?.schedule?.trim() || defaults.schedule
  if (!schedule) throw new SettingsError({ message: "backup schedule must not be empty" })

  return {
    configPath,
    settings: {
      enabled,
      server: merged?.server === undefined ? undefined : normalizeServer(merged.server),
      username: merged?.username === undefined ? undefined : validateUsername(merged.username),
      schedule,
      retention: merged?.retention ?? defaults.retention,
      includeToolOutput: merged?.include_tool_output ?? defaults.includeToolOutput,
      includeSnapshots: merged?.include_snapshots ?? defaults.includeSnapshots,
      includeProjectConfig: merged?.include_project_config ?? defaults.includeProjectConfig,
    },
  }
}

function mergeSection(base: ConfigBackup.Info | undefined, next: ConfigBackup.Info) {
  const keys = [
    "enabled",
    "server",
    "username",
    "schedule",
    "retention",
    "include_tool_output",
    "include_snapshots",
    "include_project_config",
  ] as const
  const result: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of keys) if (next[key] !== undefined) result[key] = next[key]
  return result as ConfigBackup.Info
}

export function normalizeServer(input: string) {
  const trimmed = input.trim()
  if (!trimmed) throw new SettingsError({ message: "backup server URL must not be empty" })
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new SettingsError({ message: "backup server URL is not a valid URL" })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SettingsError({ message: "backup server URL must use http or https" })
  }
  if (url.username || url.password) {
    throw new SettingsError({ message: "backup server URL must not contain credentials" })
  }
  if (url.search || url.hash) {
    throw new SettingsError({ message: "backup server URL must not contain a query or hash" })
  }
  return url.href.replace(/\/+$/, "")
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function validateUsername(input: string) {
  const value = input.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value === "." || value === "..") {
    throw new SettingsError({
      message: "backup username must match ^[A-Za-z0-9._-]{1,64}$ and must not be '.' or '..'",
    })
  }
  if (WINDOWS_RESERVED.test(value.split(".")[0])) {
    throw new SettingsError({ message: "backup username is reserved on Windows" })
  }
  return value
}

export function validateToken(input: string) {
  if (!input || input.length > 512 || /[^\x21-\x7e]/.test(input)) {
    throw new SettingsError({
      message: "backup token must be 1-512 printable ASCII characters without whitespace",
    })
  }
  return input
}

export function validatePassword(input: string) {
  if (!input || input.length > 1024) {
    throw new SettingsError({ message: "backup password must be 1-1024 characters" })
  }
  return input
}

export function resolveToken(env: NodeJS.ProcessEnv = process.env) {
  const value = env.OPENCODE_BACKUP_TOKEN
  return value ? validateToken(value) : undefined
}

export type Credential =
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "basic"; readonly username: string; readonly password: string }
  | { readonly type: "unknown"; readonly secret: string }

export interface Connection {
  readonly server: string
  readonly username: string
  readonly credential: Credential
  readonly tokenSource?: "env" | "state"
}

export function authMatches(
  auth: Auth | undefined,
  server: string | undefined,
  username: string | undefined,
) {
  if (!auth || !server || !username) return false
  try {
    return auth.server === normalizeServer(server) && auth.username === validateUsername(username)
  } catch {
    return false
  }
}

export function resolveConnection(input: {
  settings: Settings
  auth?: Auth
  env?: NodeJS.ProcessEnv
}): Connection {
  const auth = input.auth
  const envToken = resolveToken(input.env)
  const serverInput = input.settings.server ?? auth?.server
  const usernameInput = input.settings.username ?? auth?.username

  if (!serverInput) throw new SettingsError({ message: "backup server is not configured" })
  if (!usernameInput) throw new SettingsError({ message: "backup username is not configured" })
  const server = normalizeServer(serverInput)
  const username = validateUsername(usernameInput)
  const stateSecret = auth && auth.server === server && auth.username === username ? auth.secret : undefined
  const secret = envToken ?? stateSecret

  if (!secret) {
    if (auth?.secret && !envToken) {
      throw new SettingsError({
        message:
          "stored backup token or password belongs to a different server or username; run `opencode backup setup` again",
      })
    }
    throw new SettingsError({
      message:
        "backup token or password is not configured; run `opencode backup setup --token ...` or `--password-stdin`",
    })
  }

  const credential: Credential = envToken
    ? { type: "bearer", token: validateToken(envToken) }
    : auth?.method === "password"
      ? { type: "basic", username, password: validatePassword(auth.secret) }
      : auth?.method === "token"
        ? { type: "bearer", token: validateToken(auth.secret) }
        : { type: "unknown", secret: auth!.secret }

  return {
    server,
    username,
    credential,
    tokenSource: envToken ? "env" : "state",
  }
}

export function resolveBasicConnection(input: {
  server: string
  username: string
  password: string
}): Connection {
  if (!input.password) throw new SettingsError({ message: "password must not be empty" })
  return {
    server: normalizeServer(input.server),
    username: validateUsername(input.username),
    credential: { type: "basic", username: validateUsername(input.username), password: input.password },
  }
}

export function backupDirectory(stateDirectory: string) {
  return path.join(stateDirectory, "backup")
}

export function authFile(stateDirectory: string) {
  return path.join(backupDirectory(stateDirectory), "auth.json")
}

export function statusFile(stateDirectory: string) {
  return path.join(backupDirectory(stateDirectory), "status.json")
}

export async function readAuth(stateDirectory: string): Promise<Auth | undefined> {
  const text = await readFile(authFile(stateDirectory), "utf8").catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  })
  if (text === undefined) return undefined

  const parsed = decodeJson(text)
  if (parsed._tag === "None") return undefined
  const decoded = decodeAuth(parsed.value)
  if (decoded._tag === "None") return undefined
  const value = decoded.value
  const secret =
    value.secret ??
    (value.method === "password" ? (value.password ?? value.token) : (value.token ?? value.password))
  if (!secret) return undefined
  return {
    server: value.server,
    username: value.username,
    secret,
    method: value.method,
    savedAt: value.savedAt,
  } satisfies Auth
}

export async function writeAuth(
  stateDirectory: string,
  input: { server: string; username: string; method: AuthMethod; secret: string; savedAt?: string },
) {
  const file = authFile(stateDirectory)
  const secret = input.method === "token" ? validateToken(input.secret) : validatePassword(input.secret)
  const content =
    JSON.stringify(
      {
        server: normalizeServer(input.server),
        username: validateUsername(input.username),
        method: input.method,
        secret,
        savedAt: input.savedAt ?? new Date().toISOString(),
      },
      null,
      2,
    ) + "\n"
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => undefined)
    await replace(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return file
}

export async function writeGlobalConfig(configDirectory: string, patch: Record<string, unknown>) {
  const candidates = globalConfigCandidates(configDirectory)
  let file = Flag.OPENCODE_CONFIG
  if (!file) {
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        file = candidate
        break
      }
    }
  }
  file ??= candidates[0]
  let text = (await exists(file))
    ? await readFile(file, "utf8")
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}'
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    text = applyEdits(
      text,
      modify(text, ["backup", key], value, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      }),
    )
  }

  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => undefined)
    await replace(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return file
}

async function exists(file: string) {
  const info = await stat(file).catch(() => undefined)
  return info?.isFile() === true
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
