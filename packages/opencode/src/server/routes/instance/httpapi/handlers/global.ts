import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationBuild, InstallationVersion } from "@opencode-ai/core/installation/version"
import { device } from "@opencode-ai/server/device"
import { Effect, Queue, Redacted } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { ServerAuth as ServerTokenAuth } from "@opencode-ai/server/auth"
import { ServerAuth } from "@/server/auth"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { AuthLoginInput, GlobalUpgradeInput } from "../groups/global"

function toSession(session: ServerTokenAuth.TokenSession) {
  return {
    id: session.id,
    username: session.username,
    deviceName: session.deviceName,
    createdAt: new Date(session.createdAt).toISOString(),
    accessExpiresAt: new Date(session.accessExpiresAt).toISOString(),
    refreshExpiresAt: new Date(session.refreshExpiresAt).toISOString(),
  }
}

function toTokens(pair: ServerTokenAuth.TokenPair) {
  return {
    tokenType: "Bearer" as const,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: Math.max(0, Math.floor((pair.accessExpiresAt - Date.now()) / 1000)),
    refreshExpiresIn: Math.max(0, Math.floor((pair.refreshExpiresAt - Date.now()) / 1000)),
    session: toSession(pair.session),
  }
}

function requestToken(request: HttpServerRequest.HttpServerRequest) {
  return ServerTokenAuth.accessTokenFromRequest({
    authorization: request.headers.authorization,
    url: new URL(request.url, "http://localhost"),
  })
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const authLogin = Effect.fn("GlobalHttpApi.authLogin")(function* (ctx: { payload: typeof AuthLoginInput.Type }) {
      const auth = yield* ServerAuth.Config
      if (!ServerAuth.required(auth)) return yield* new HttpApiError.Unauthorized({})
      const username = ctx.payload.username ?? auth.username
      if (
        !ServerAuth.authorized(
          { username, password: Redacted.make(ctx.payload.password) },
          auth,
        )
      ) {
        return yield* new HttpApiError.Unauthorized({})
      }
      const pair = yield* Effect.promise(() =>
        ServerTokenAuth.tokens.issue({ username, deviceName: ctx.payload.deviceName }),
      )
      return toTokens(pair)
    })

    const authRefresh = Effect.fn("GlobalHttpApi.authRefresh")(function* (ctx: { payload: { refreshToken: string } }) {
      const auth = yield* ServerAuth.Config
      if (!ServerAuth.required(auth)) return yield* new HttpApiError.Unauthorized({})
      const pair = yield* Effect.promise(() => ServerTokenAuth.tokens.refresh(ctx.payload.refreshToken))
      if (!pair) return yield* new HttpApiError.Unauthorized({})
      return toTokens(pair)
    })

    const authLogout = Effect.fn("GlobalHttpApi.authLogout")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = requestToken(request)
      if (!token) return false
      return yield* Effect.promise(() => ServerTokenAuth.tokens.revoke(token))
    })

    const authSession = Effect.fn("GlobalHttpApi.authSession")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = requestToken(request)
      if (!token) return yield* new HttpApiError.Unauthorized({})
      const session = yield* Effect.promise(() => ServerTokenAuth.tokens.session(token))
      if (!session) return yield* new HttpApiError.Unauthorized({})
      return toSession(session)
    })

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion, build: InstallationBuild, device: device() }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("authLogin", authLogin)
      .handle("authRefresh", authRefresh)
      .handle("authLogout", authLogout)
      .handle("authSession", authSession)
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
