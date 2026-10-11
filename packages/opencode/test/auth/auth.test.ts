import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("addKey creates api auth and activates the first key", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.addKey("test-multi-key", { key: "sk-1234567890" })
      const info = yield* auth.get("test-multi-key")
      expect(info?.type).toBe("api")
      if (info?.type === "api") expect(info.key).toBe("sk-1234567890")
      const keys = yield* auth.listKeys("test-multi-key")
      expect(keys).toHaveLength(1)
      expect(keys[0].active).toBe(true)
      expect(keys[0].preview).not.toBe("sk-1234567890")
      yield* auth.remove("test-multi-key")
    }),
  )

  it.instance("addKey appends and activates the newest key", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.addKey("test-multi-key", { key: "sk-first-key", label: "first" })
      yield* auth.addKey("test-multi-key", { key: "sk-second-key", label: "second" })
      const info = yield* auth.get("test-multi-key")
      if (info?.type === "api") expect(info.key).toBe("sk-second-key")
      const keys = yield* auth.listKeys("test-multi-key")
      expect(keys.map((key) => key.label)).toEqual(["first", "second"])
      expect(keys.map((key) => key.active)).toEqual([false, true])
      yield* auth.remove("test-multi-key")
    }),
  )

  it.instance("activateKey switches the active key without dropping others", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.addKey("test-multi-key", { key: "sk-first-key" })
      yield* auth.addKey("test-multi-key", { key: "sk-second-key" })
      const keys = yield* auth.listKeys("test-multi-key")
      const first = keys.find((key) => !key.active)!
      yield* auth.activateKey("test-multi-key", first.id)
      const info = yield* auth.get("test-multi-key")
      if (info?.type === "api") expect(info.key).toBe("sk-first-key")
      const after = yield* auth.listKeys("test-multi-key")
      expect(after).toHaveLength(2)
      expect(after.find((key) => key.id === first.id)?.active).toBe(true)
      yield* auth.remove("test-multi-key")
    }),
  )

  it.instance("removeKey falls back to the remaining key when the active one is removed", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.addKey("test-multi-key", { key: "sk-first-key" })
      yield* auth.addKey("test-multi-key", { key: "sk-second-key" })
      const active = (yield* auth.listKeys("test-multi-key")).find((key) => key.active)!
      yield* auth.removeKey("test-multi-key", active.id)
      const info = yield* auth.get("test-multi-key")
      if (info?.type === "api") expect(info.key).toBe("sk-first-key")
      const keys = yield* auth.listKeys("test-multi-key")
      expect(keys).toHaveLength(1)
      expect(keys[0].active).toBe(true)
      yield* auth.remove("test-multi-key")
    }),
  )

  it.instance("removeKey removes auth entirely when the last key is removed", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.addKey("test-multi-key", { key: "sk-first-key" })
      const keys = yield* auth.listKeys("test-multi-key")
      yield* auth.removeKey("test-multi-key", keys[0].id)
      expect(yield* auth.get("test-multi-key")).toBeUndefined()
      expect(yield* auth.listKeys("test-multi-key")).toEqual([])
    }),
  )

  it.instance("addKey normalizes legacy single-key auth into the key list", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("test-multi-key", { type: "api", key: "sk-legacy-key" })
      yield* auth.addKey("test-multi-key", { key: "sk-new-key" })
      const keys = yield* auth.listKeys("test-multi-key")
      expect(keys).toHaveLength(2)
      expect(keys.map((key) => key.active)).toEqual([false, true])
      const info = yield* auth.get("test-multi-key")
      if (info?.type === "api") expect(info.keys?.map((key) => key.key)).toEqual(["sk-legacy-key", "sk-new-key"])
      yield* auth.remove("test-multi-key")
    }),
  )

  it.instance("addKey rejects providers authenticated with oauth", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("test-multi-key", {
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      })
      const error = yield* auth.addKey("test-multi-key", { key: "sk-test" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Auth.AuthError)
      yield* auth.remove("test-multi-key")
    }),
  )
})
