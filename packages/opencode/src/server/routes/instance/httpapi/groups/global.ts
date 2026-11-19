import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { Device } from "@opencode-ai/protocol/groups/health"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
  build: Schema.String,
  device: Device,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.String.check(
    Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const AuthLoginInput = Schema.Struct({
  username: Schema.optional(Schema.String),
  password: Schema.String,
  deviceName: Schema.optional(Schema.String),
})

export const AuthRefreshInput = Schema.Struct({
  refreshToken: Schema.String,
})

export const AuthSession = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  deviceName: Schema.String,
  createdAt: Schema.String,
  accessExpiresAt: Schema.String,
  refreshExpiresAt: Schema.String,
}).annotate({ identifier: "AuthSession" })

export const AuthTokens = Schema.Struct({
  tokenType: Schema.Literal("Bearer"),
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresIn: Schema.Number,
  refreshExpiresIn: Schema.Number,
  session: AuthSession,
}).annotate({ identifier: "AuthTokens" })

export const GlobalPaths = {
  authLogin: "/global/auth/login",
  authRefresh: "/global/auth/refresh",
  authLogout: "/global/auth/logout",
  authSession: "/global/auth/session",
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.post("authLogin", GlobalPaths.authLogin, {
        payload: AuthLoginInput,
        success: described(AuthTokens, "Bearer tokens issued"),
        error: HttpApiError.Unauthorized,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.auth.login",
          summary: "Log in to the server",
          description: "Exchange the configured server username and password for a short-lived access token and rotating refresh token.",
        }),
      ),
      HttpApiEndpoint.post("authRefresh", GlobalPaths.authRefresh, {
        payload: AuthRefreshInput,
        success: described(AuthTokens, "Bearer tokens rotated"),
        error: HttpApiError.Unauthorized,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.auth.refresh",
          summary: "Refresh server tokens",
          description: "Rotate an access token and refresh token using a valid refresh token.",
        }),
      ),
      HttpApiEndpoint.post("authLogout", GlobalPaths.authLogout, {
        success: described(Schema.Boolean, "Token revoked"),
        error: HttpApiError.Unauthorized,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.auth.logout",
          summary: "Log out of the server",
          description: "Revoke the current access token or the supplied refresh token.",
        }),
      ),
      HttpApiEndpoint.get("authSession", GlobalPaths.authSession, {
        success: described(AuthSession, "Current token session"),
        error: HttpApiError.Unauthorized,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.auth.session",
          summary: "Get token session",
          description: "Return metadata for the current bearer token.",
        }),
      ),
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
