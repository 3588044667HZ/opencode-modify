import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Backup } from "@opencode-ai/core/backup/backup"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/tmpdir"

async function fixture() {
  const tmp = await tmpdir()
  const roots = {
    data: path.join(tmp.path, "data"),
    config: path.join(tmp.path, "config"),
    state: path.join(tmp.path, "state"),
    cache: path.join(tmp.path, "cache"),
  }
  await fs.mkdir(roots.data, { recursive: true })
  await fs.mkdir(roots.config, { recursive: true })
  return { tmp, roots }
}

function layer(roots: { data: string; config: string; state: string; cache: string }) {
  return AppNodeBuilder.build(LayerNode.group([Backup.node]), [[Global.node, Global.layerWith(roots)]])
}

function configure(
  roots: { data: string; config: string; state: string; cache: string },
  input: Backup.ConfigureInput,
) {
  return Effect.gen(function* () {
    const backup = yield* Backup.Service
    yield* backup.configure(input)
  }).pipe(Effect.provide(layer(roots)), Effect.runPromise)
}

async function config(roots: { config: string }) {
  const text = await fs.readFile(path.join(roots.config, "opencode.jsonc"), "utf8")
  return JSON.parse(text) as { backup?: Record<string, unknown> }
}

describe("backup configure", () => {
  test("writes global config and stores the token in the state directory", async () => {
    const { tmp, roots } = await fixture()
    try {
      await configure(roots, {
        enabled: true,
        server: "https://backup.example.com",
        username: "alice",
        token: "secret-token",
        schedule: "15 4 * * *",
      })

      expect(await config(roots)).toMatchObject({
        backup: {
          enabled: true,
          server: "https://backup.example.com",
          username: "alice",
          schedule: "15 4 * * *",
        },
      })
      const auth = await BackupSettings.readAuth(roots.state)
      expect(auth).toMatchObject({
        server: "https://backup.example.com",
        username: "alice",
        method: "token",
        secret: "secret-token",
      })
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("an empty token does not overwrite the stored token", async () => {
    const { tmp, roots } = await fixture()
    try {
      await configure(roots, {
        server: "https://backup.example.com",
        username: "alice",
        token: "secret-token",
      })
      await configure(roots, { token: "", schedule: "0 5 * * *" })

      expect((await BackupSettings.readAuth(roots.state))?.secret).toBe("secret-token")
      expect(await config(roots)).toMatchObject({ backup: { schedule: "0 5 * * *" } })
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects changing server or username without a new token", async () => {
    const { tmp, roots } = await fixture()
    try {
      await configure(roots, {
        server: "https://backup.example.com",
        username: "alice",
        token: "secret-token",
      })
      await expect(
        configure(roots, { server: "https://other.example.com" }),
      ).rejects.toThrow(/different server or username/)
      await expect(configure(roots, { username: "bob" })).rejects.toThrow(/different server or username/)
      expect(await config(roots)).toMatchObject({
        backup: { server: "https://backup.example.com", username: "alice" },
      })
      expect(await BackupSettings.readAuth(roots.state)).toMatchObject({
        server: "https://backup.example.com",
        username: "alice",
      })
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("stores a password and prefers token when both are provided", async () => {
    const { tmp, roots } = await fixture()
    try {
      await configure(roots, {
        server: "https://backup.example.com",
        username: "alice",
        password: "secret-password",
      })
      expect(await BackupSettings.readAuth(roots.state)).toMatchObject({
        method: "password",
        secret: "secret-password",
      })

      await configure(roots, {
        server: "https://backup.example.com",
        username: "alice",
        token: "secret-token",
        password: "ignored-password",
      })
      const auth = await BackupSettings.readAuth(roots.state)
      expect(auth).toMatchObject({ method: "token", secret: "secret-token" })
      expect(JSON.stringify(auth)).not.toContain("ignored-password")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects an invalid schedule without writing configuration", async () => {
    const { tmp, roots } = await fixture()
    try {
      await expect(
        configure(roots, { server: "https://backup.example.com", username: "alice", schedule: "not a cron" }),
      ).rejects.toBeDefined()
      await expect(fs.stat(path.join(roots.config, "opencode.jsonc"))).rejects.toBeDefined()
      expect(await BackupSettings.readAuth(roots.state)).toBeUndefined()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("requires a server and username when storing a token", async () => {
    const { tmp, roots } = await fixture()
    try {
      await expect(configure(roots, { token: "secret-token" })).rejects.toBeDefined()
      expect(await BackupSettings.readAuth(roots.state)).toBeUndefined()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})
