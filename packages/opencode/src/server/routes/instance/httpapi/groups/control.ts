import { Auth } from "@/auth"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { ProviderV2 } from "@opencode-ai/core/provider"

const AuthParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

const AuthKeyParams = Schema.Struct({
  providerID: ProviderV2.ID,
  keyID: Schema.String,
})

const LogQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

export const LogInput = Schema.Struct({
  service: Schema.String.annotate({ description: "Service name for the log entry" }),
  level: Schema.Union([
    Schema.Literal("debug"),
    Schema.Literal("info"),
    Schema.Literal("error"),
    Schema.Literal("warn"),
  ]).annotate({ description: "Log level" }),
  message: Schema.String.annotate({ description: "Log message" }),
  extra: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Additional metadata for the log entry",
  }),
})

export const ControlPaths = {
  auth: "/auth/:providerID",
  authKeys: "/auth/:providerID/keys",
  authKey: "/auth/:providerID/keys/:keyID",
  authKeyActivate: "/auth/:providerID/keys/:keyID/activate",
  log: "/log",
} as const

export const ControlApi = HttpApi.make("control").add(
  HttpApiGroup.make("control")
    .add(
      HttpApiEndpoint.put("authSet", ControlPaths.auth, {
        params: AuthParams,
        payload: Auth.Info,
        success: described(Schema.Boolean, "Successfully set authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.set",
          summary: "Set auth credentials",
          description: "Set authentication credentials",
        }),
      ),
      HttpApiEndpoint.delete("authRemove", ControlPaths.auth, {
        params: AuthParams,
        success: described(Schema.Boolean, "Successfully removed authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.remove",
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
        }),
      ),
      HttpApiEndpoint.get("authKeyList", ControlPaths.authKeys, {
        params: AuthParams,
        success: described(Auth.KeyList, "API keys stored for the provider with masked values"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.key.list",
          summary: "List API keys",
          description: "List the API keys stored for a provider. Key values are masked.",
        }),
      ),
      HttpApiEndpoint.put("authKeyAdd", ControlPaths.authKeys, {
        params: AuthParams,
        payload: Auth.AddKeyInput,
        success: described(Auth.KeyList, "Updated API key list for the provider"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.key.add",
          summary: "Add API key",
          description: "Add an API key for a provider and make it the active key.",
        }),
      ),
      HttpApiEndpoint.post("authKeyActivate", ControlPaths.authKeyActivate, {
        params: AuthKeyParams,
        success: described(Auth.KeyList, "Updated API key list for the provider"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.key.activate",
          summary: "Activate API key",
          description: "Select which stored API key is used for provider requests.",
        }),
      ),
      HttpApiEndpoint.delete("authKeyRemove", ControlPaths.authKey, {
        params: AuthKeyParams,
        success: described(Auth.KeyList, "Remaining API keys for the provider"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.key.remove",
          summary: "Remove API key",
          description: "Remove a stored API key. Removing the last key disconnects the provider.",
        }),
      ),
      HttpApiEndpoint.post("log", ControlPaths.log, {
        query: LogQuery,
        payload: LogInput,
        success: described(Schema.Boolean, "Log entry written successfully"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "app.log",
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "control", description: "Control plane routes." })),
)
