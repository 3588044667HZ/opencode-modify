import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"

const secret = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "opencode" })

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(secret),
)

const it = testEffect(apiLayer)


describe("global auth HttpApi", () => {
  it.live("logs in, reads the session, rotates tokens, and logs out", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-auth-api-")))
      const previous = process.env.OPENCODE_SERVER_AUTH_FILE
      process.env.OPENCODE_SERVER_AUTH_FILE = path.join(dir, "tokens.json")
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (previous === undefined) delete process.env.OPENCODE_SERVER_AUTH_FILE
          else process.env.OPENCODE_SERVER_AUTH_FILE = previous
          await rm(dir, { recursive: true, force: true })
        }),
      )

      const login = yield* HttpClientRequest.post(GlobalPaths.authLogin).pipe(
        HttpClientRequest.bodyJsonUnsafe({ username: "opencode", password: "secret", deviceName: "phone" }),
        HttpClient.execute,
      )
      expect(login.status).toBe(200)
      const first = (yield* login.json) as { accessToken: string; refreshToken: string }

      const session = yield* HttpClientRequest.get(GlobalPaths.authSession).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${first.accessToken}`),
        HttpClient.execute,
      )
      expect(session.status).toBe(200)
      expect(yield* session.json).toMatchObject({ username: "opencode", deviceName: "phone" })

      const refresh = yield* HttpClientRequest.post(GlobalPaths.authRefresh).pipe(
        HttpClientRequest.bodyJsonUnsafe({ refreshToken: first.refreshToken }),
        HttpClient.execute,
      )
      expect(refresh.status).toBe(200)
      const second = (yield* refresh.json) as { accessToken: string; refreshToken: string }
      expect(second.accessToken).not.toBe(first.accessToken)

      const oldSession = yield* HttpClientRequest.get(GlobalPaths.authSession).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${first.accessToken}`),
        HttpClient.execute,
      )
      expect(oldSession.status).toBe(401)

      const logout = yield* HttpClientRequest.post(GlobalPaths.authLogout).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${second.accessToken}`),
        HttpClient.execute,
      )
      expect(logout.status).toBe(200)
      expect(yield* logout.json).toBe(true)

      const after = yield* HttpClientRequest.get(GlobalPaths.authSession).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${second.accessToken}`),
        HttpClient.execute,
      )
      expect(after.status).toBe(401)
    }),
  )

  it.live("rejects invalid credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.authLogin).pipe(
        HttpClientRequest.bodyJsonUnsafe({ username: "opencode", password: "wrong" }),
        HttpClient.execute,
      )
      expect(response.status).toBe(401)
    }),
  )
})
