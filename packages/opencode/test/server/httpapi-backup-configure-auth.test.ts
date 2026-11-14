import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ServerAuth } from "@opencode-ai/server/auth"
import { afterAll, describe, expect } from "bun:test"
import { Config, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

const configDir = mkdtempSync(path.join(os.tmpdir(), "opencode-backup-auth-"))
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
process.env.OPENCODE_CONFIG_DIR = configDir

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.createRoutes(
    undefined,
    ServerAuth.Config.configLayer({ username: "opencode", password: Option.some("secret") }),
  ),
  { disableListenLog: true, disableLogger: true },
)

const routes = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(routes)

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe("backup configure auth wiring", () => {
  it.live("allows authenticated non-loopback configure requests", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/api/backup/configure").pipe(
        HttpClientRequest.setHeaders({
          authorization: ServerAuth.header({ username: "opencode", password: "secret" }) ?? "",
          "x-forwarded-for": "203.0.113.10",
        }),
        HttpClientRequest.bodyJsonUnsafe({ schedule: "not a cron" }),
        HttpClient.execute,
      )

      expect(response.status).not.toBe(403)
      expect(response.status).toBe(400)
    }),
  )
})