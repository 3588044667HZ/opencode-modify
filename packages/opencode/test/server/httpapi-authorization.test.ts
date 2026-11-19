import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  ServerAuthorization,
  serverAuthorizationLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"
import { ServerAuth as ServerTokenAuth } from "@opencode-ai/server/auth"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
    )
    .middleware(Authorization),
)

const ServerApi = HttpApi.make("test-server-authorization").add(
  HttpApiGroup.make("test.v2")
    .add(
      HttpApiEndpoint.get("probe", "/api/probe", {
        success: Schema.String,
      }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({}))),
)

const serverHandlers = HttpApiBuilder.group(ServerApi, "test.v2", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const v2ApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(serverHandlers), Layer.provide(serverAuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })
const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "opencode" })
const kitSecretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "kit" })

const it = testEffect(apiLayer.pipe(Layer.provide(noAuthLayer)))
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))
const itKitSecret = testEffect(apiLayer.pipe(Layer.provide(kitSecretLayer)))
const itV2Secret = testEffect(v2ApiLayer.pipe(Layer.provide(secretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")


const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware", () => {
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("opencode", "wrong") }),
          getProbe({ authorization: basic("opencode", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(good.status).toBe(200)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("opencode", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("prefers auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("opencode", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when auth token query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("accepts bearer access tokens and access_token query tokens", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-auth-http-")))
      const previous = process.env.OPENCODE_SERVER_AUTH_FILE
      process.env.OPENCODE_SERVER_AUTH_FILE = path.join(dir, "tokens.json")
      const pair = yield* Effect.promise(() =>
        ServerTokenAuth.tokens.issue({ username: "opencode", deviceName: "http-test" }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await ServerTokenAuth.tokens.revoke(pair.accessToken)
          if (previous === undefined) delete process.env.OPENCODE_SERVER_AUTH_FILE
          else process.env.OPENCODE_SERVER_AUTH_FILE = previous
          await rm(dir, { recursive: true, force: true })
        }),
      )

      const [byHeader, byQuery, invalid] = yield* Effect.all(
        [
          getProbe({ authorization: `Bearer ${pair.accessToken}` }),
          HttpClient.get(`/probe?access_token=${encodeURIComponent(pair.accessToken)}`),
          getProbe({ authorization: "Bearer invalid" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(byHeader.status).toBe(200)
      expect(byQuery.status).toBe(200)
      expect(invalid.status).toBe(401)
      expect(ServerTokenAuth.isPublicAuthPath("POST", ServerTokenAuth.AUTH_LOGIN_PATH)).toBe(true)
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-base64")

      expect(response.status).toBe(401)
    }),
  )

  itV2Secret.live("accepts bearer access tokens on the server API", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-auth-v2-")))
      const previous = process.env.OPENCODE_SERVER_AUTH_FILE
      process.env.OPENCODE_SERVER_AUTH_FILE = path.join(dir, "tokens.json")
      const pair = yield* Effect.promise(() =>
        ServerTokenAuth.tokens.issue({ username: "opencode", deviceName: "v2-http-test" }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await ServerTokenAuth.tokens.revoke(pair.accessToken)
          if (previous === undefined) delete process.env.OPENCODE_SERVER_AUTH_FILE
          else process.env.OPENCODE_SERVER_AUTH_FILE = previous
          await rm(dir, { recursive: true, force: true })
        }),
      )

      const response = yield* HttpClientRequest.get("/api/probe").pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${pair.accessToken}`),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
    }),
  )

  itV2Secret.live("returns bodyful v2 unauthorized errors", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      const body = yield* response.json

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(body).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    }),
  )
})
