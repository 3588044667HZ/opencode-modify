import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Identifier } from "@/id/id"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class ApiKey extends Schema.Class<ApiKey>("ApiKey")({
  id: Schema.String,
  key: Schema.String,
  label: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // 同一 provider 可以保存多把 key，key 字段始终镜像当前生效的那把
  keys: Schema.optional(Schema.Array(ApiKey)),
  activeKeyID: Schema.optional(Schema.String),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const KeyInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  preview: Schema.String,
  active: Schema.Boolean,
})
export type KeyInfo = Schema.Schema.Type<typeof KeyInfo>

export const KeyList = Schema.Struct({
  keys: Schema.Array(KeyInfo),
})

export const AddKeyInput = Schema.Struct({
  key: Schema.String,
  label: Schema.optional(Schema.String),
})

const legacyKeyID = "legacy"

// 兼容旧数据：没有 keys 字段时把单个 key 当作唯一一把
function keyEntries(info: Api) {
  const keys = info.keys?.length ? [...info.keys] : [new ApiKey({ id: legacyKeyID, key: info.key })]
  const active =
    keys.find((item) => item.id === info.activeKeyID) ?? keys.find((item) => item.key === info.key) ?? keys[0]
  return { keys, activeID: active.id }
}

function maskKey(key: string) {
  if (key.length <= 8) return "*".repeat(key.length)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly listKeys: (providerID: string) => Effect.Effect<KeyInfo[], AuthError>
  readonly addKey: (providerID: string, input: { key: string; label?: string }) => Effect.Effect<void, AuthError>
  readonly activateKey: (providerID: string, keyID: string) => Effect.Effect<void, AuthError>
  readonly removeKey: (providerID: string, keyID: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const listKeys = Effect.fn("Auth.listKeys")(function* (providerID: string) {
      const info = yield* get(providerID)
      if (info?.type !== "api") return [] as KeyInfo[]
      const entries = keyEntries(info)
      return entries.keys.map(
        (item): KeyInfo => ({
          id: item.id,
          label: item.label,
          preview: maskKey(item.key),
          active: item.id === entries.activeID,
        }),
      )
    })

    const addKey = Effect.fn("Auth.addKey")(function* (providerID: string, input: { key: string; label?: string }) {
      const value = input.key.trim()
      if (!value) return yield* new AuthError({ message: "API key is required" })
      const existing = yield* get(providerID)
      if (existing && existing.type !== "api")
        return yield* new AuthError({ message: `Provider ${providerID} is authenticated with ${existing.type}` })
      const current = existing?.type === "api" ? keyEntries(existing) : undefined
      const added = new ApiKey({ id: Identifier.create("key", "ascending"), key: value, label: input.label })
      // 新增的 key 直接设为生效 key，连接/添加后无需再手动切换
      yield* set(providerID, {
        type: "api",
        key: value,
        metadata: existing?.type === "api" ? existing.metadata : undefined,
        keys: [...(current?.keys ?? []), added],
        activeKeyID: added.id,
      })
    })

    const activateKey = Effect.fn("Auth.activateKey")(function* (providerID: string, keyID: string) {
      const existing = yield* get(providerID)
      if (existing?.type !== "api") return yield* new AuthError({ message: `Provider ${providerID} has no API keys` })
      const current = keyEntries(existing)
      const target = current.keys.find((item) => item.id === keyID)
      if (!target) return yield* new AuthError({ message: `API key ${keyID} was not found` })
      yield* set(providerID, { ...existing, key: target.key, keys: current.keys, activeKeyID: target.id })
    })

    const removeKey = Effect.fn("Auth.removeKey")(function* (providerID: string, keyID: string) {
      const existing = yield* get(providerID)
      if (existing?.type !== "api") return yield* new AuthError({ message: `Provider ${providerID} has no API keys` })
      const current = keyEntries(existing)
      if (!current.keys.some((item) => item.id === keyID))
        return yield* new AuthError({ message: `API key ${keyID} was not found` })
      const remaining = current.keys.filter((item) => item.id !== keyID)
      if (remaining.length === 0) {
        yield* remove(providerID)
        return
      }
      // 删除生效 key 后回退到最近添加的一把
      const next =
        current.activeID === keyID
          ? remaining[remaining.length - 1]
          : (remaining.find((item) => item.id === current.activeID) ?? remaining[0])
      yield* set(providerID, { ...existing, key: next.key, keys: remaining, activeKeyID: next.id })
    })

    return Service.of({ get, all, set, remove, listKeys, addKey, activateKey, removeKey })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
