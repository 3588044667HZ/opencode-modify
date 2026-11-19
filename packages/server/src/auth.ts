export * as ServerAuth from "./auth"

import { Global } from "@opencode-ai/core/global"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
          }),
        )
      }),
    )
  }
}

function safeText(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    safeText(credentials.username, config.username) &&
    safeText(Redacted.value(credentials.password), config.password.value)
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

export const AUTH_LOGIN_PATH = "/global/auth/login"
export const AUTH_REFRESH_PATH = "/global/auth/refresh"
export const AUTH_LOGOUT_PATH = "/global/auth/logout"
export const AUTH_SESSION_PATH = "/global/auth/session"

export function isPublicAuthPath(method: string, pathname: string) {
  if (method === "OPTIONS") return pathname === AUTH_LOGIN_PATH || pathname === AUTH_REFRESH_PATH
  return method === "POST" && (pathname === AUTH_LOGIN_PATH || pathname === AUTH_REFRESH_PATH)
}

export function accessTokenFromRequest(input: { authorization?: string; url?: URL }) {
  const bearer = /^Bearer\s+(.+)$/i.exec(input.authorization ?? "")?.[1]?.trim()
  if (bearer) return bearer
  return input.url?.searchParams.get("access_token") ?? undefined
}

export type IssueInput = {
  readonly username: string
  readonly deviceName?: string
}

export type TokenSession = {
  readonly id: string
  readonly username: string
  readonly deviceName: string
  readonly createdAt: number
  readonly accessExpiresAt: number
  readonly refreshExpiresAt: number
}

export type TokenPair = {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: number
  readonly refreshExpiresAt: number
  readonly session: TokenSession
}

type StoredSession = TokenSession & {
  readonly accessHash: string
  readonly refreshHash: string
}

type FileState = {
  readonly version: 1
  readonly sessions: StoredSession[]
}

export type TokenStoreOptions = {
  readonly file?: string | (() => string)
  readonly accessTtlMs?: number
  readonly refreshTtlMs?: number
  readonly maxSessions?: number
  readonly now?: () => number
}

const ACCESS_TTL_MS = 15 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 50
const ACCESS_PREFIX = "oc_at_"
const REFRESH_PREFIX = "oc_rt_"

function token(prefix: string) {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function sameHash(left: string, right: string) {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function emptyState(): FileState {
  return { version: 1, sessions: [] }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    typeof item.username === "string" &&
    typeof item.deviceName === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.accessExpiresAt === "number" &&
    typeof item.refreshExpiresAt === "number" &&
    typeof item.accessHash === "string" &&
    typeof item.refreshHash === "string"
  )
}

function isFileState(value: unknown): value is FileState {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return item.version === 1 && Array.isArray(item.sessions) && item.sessions.every(isStoredSession)
}

function publicSession(session: StoredSession): TokenSession {
  return {
    id: session.id,
    username: session.username,
    deviceName: session.deviceName,
    createdAt: session.createdAt,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
  }
}

function pair(session: StoredSession, accessToken: string, refreshToken: string): TokenPair {
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
    session: publicSession(session),
  }
}

export class TokenStore {
  private readonly file: () => string
  private readonly accessTtlMs: number
  private readonly refreshTtlMs: number
  private readonly maxSessions: number
  private readonly now: () => number
  private memory: FileState | undefined
  private loading: Promise<FileState> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(input: TokenStoreOptions = {}) {
    const file = input.file
    this.file =
      typeof file === "function"
        ? file
        : () => file ?? path.join(Global.Path.state, "server-auth.json")
    this.accessTtlMs = input.accessTtlMs ?? ACCESS_TTL_MS
    this.refreshTtlMs = input.refreshTtlMs ?? REFRESH_TTL_MS
    this.maxSessions = input.maxSessions ?? MAX_SESSIONS
    this.now = input.now ?? Date.now
  }

  async issue(input: IssueInput): Promise<TokenPair> {
    return this.serialize(async () => {
      const state = await this.load()
      const now = this.now()
      const accessToken = token(ACCESS_PREFIX)
      const refreshToken = token(REFRESH_PREFIX)
      const session: StoredSession = {
        id: `session_${randomBytes(12).toString("base64url")}`,
        username: input.username,
        deviceName: normalizeDeviceName(input.deviceName),
        createdAt: now,
        accessExpiresAt: now + this.accessTtlMs,
        refreshExpiresAt: now + this.refreshTtlMs,
        accessHash: hash(accessToken),
        refreshHash: hash(refreshToken),
      }
      const next: FileState = {
        version: 1,
        sessions: [session, ...this.prune(state).sessions].slice(0, this.maxSessions),
      }
      this.memory = next
      await this.save(next)
      return pair(session, accessToken, refreshToken)
    })
  }

  async verifyAccess(value: string): Promise<boolean> {
    return this.serialize(async () => {
      const state = await this.load()
      const current = hash(value)
      const now = this.now()
      return state.sessions.some((session) => sameHash(session.accessHash, current) && session.accessExpiresAt > now)
    })
  }

  async session(value: string): Promise<TokenSession | undefined> {
    return this.serialize(async () => {
      const state = await this.load()
      const current = hash(value)
      const now = this.now()
      const session = state.sessions.find(
        (item) => sameHash(item.accessHash, current) && item.accessExpiresAt > now,
      )
      return session ? publicSession(session) : undefined
    })
  }

  async refresh(value: string): Promise<TokenPair | undefined> {
    return this.serialize(async () => {
      const state = await this.load()
      const current = hash(value)
      const now = this.now()
      const session = state.sessions.find(
        (item) => sameHash(item.refreshHash, current) && item.refreshExpiresAt > now,
      )
      if (!session) return undefined

      const accessToken = token(ACCESS_PREFIX)
      const refreshToken = token(REFRESH_PREFIX)
      const nextSession: StoredSession = {
        ...session,
        accessExpiresAt: now + this.accessTtlMs,
        refreshExpiresAt: now + this.refreshTtlMs,
        accessHash: hash(accessToken),
        refreshHash: hash(refreshToken),
      }
      const next: FileState = {
        version: 1,
        sessions: state.sessions.map((item) => (item.id === session.id ? nextSession : item)),
      }
      this.memory = next
      await this.save(next)
      return pair(nextSession, accessToken, refreshToken)
    })
  }

  async revoke(value: string): Promise<boolean> {
    return this.serialize(async () => {
      const state = await this.load()
      const current = hash(value)
      const nextSessions = state.sessions.filter(
        (item) => !sameHash(item.accessHash, current) && !sameHash(item.refreshHash, current),
      )
      if (nextSessions.length === state.sessions.length) return false
      const next: FileState = { version: 1, sessions: nextSessions }
      this.memory = next
      await this.save(next)
      return true
    })
  }

  private serialize<A>(task: () => Promise<A>): Promise<A> {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async load(): Promise<FileState> {
    if (this.memory) return this.memory
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await readFile(this.file(), "utf8")
          const parsed: unknown = JSON.parse(raw)
          if (!isFileState(parsed)) throw new Error("Invalid server auth token store")
          this.memory = this.prune(parsed)
          return this.memory
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
          this.memory = emptyState()
          return this.memory
        } finally {
          this.loading = undefined
        }
      })()
    }
    return this.loading
  }

  private prune(state: FileState): FileState {
    const now = this.now()
    return {
      version: 1,
      sessions: state.sessions
        .filter((session) => session.refreshExpiresAt > now)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, this.maxSessions),
    }
  }

  private async save(state: FileState) {
    const file = this.file()
    await mkdir(path.dirname(file), { recursive: true })
    const serialized = JSON.stringify(state)
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(temporary, serialized, { mode: 0o600 })
    try {
      await rename(temporary, file)
    } catch {
      await writeFile(file, serialized, { mode: 0o600 })
      await rm(temporary, { force: true })
    }
  }
}

function normalizeDeviceName(value?: string) {
  const name = value?.trim().slice(0, 80)
  return name || "Unknown device"
}

export const tokens = new TokenStore({
  file: () => process.env.OPENCODE_SERVER_AUTH_FILE ?? path.join(Global.Path.state, "server-auth.json"),
})