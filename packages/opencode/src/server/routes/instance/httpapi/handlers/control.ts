import { Auth } from "@/auth"

import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const badRequest = () => new HttpApiError.BadRequest({})

    const authKeyList = Effect.fn("ControlHttpApi.authKeyList")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      const keys = yield* auth.listKeys(ctx.params.providerID).pipe(Effect.mapError(badRequest))
      return { keys }
    })

    const authKeyAdd = Effect.fn("ControlHttpApi.authKeyAdd")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: typeof Auth.AddKeyInput.Type
    }) {
      yield* auth.addKey(ctx.params.providerID, ctx.payload).pipe(Effect.mapError(badRequest))
      const keys = yield* auth.listKeys(ctx.params.providerID).pipe(Effect.mapError(badRequest))
      return { keys }
    })

    const authKeyActivate = Effect.fn("ControlHttpApi.authKeyActivate")(function* (ctx: {
      params: { providerID: ProviderV2.ID; keyID: string }
    }) {
      yield* auth.activateKey(ctx.params.providerID, ctx.params.keyID).pipe(Effect.mapError(badRequest))
      const keys = yield* auth.listKeys(ctx.params.providerID).pipe(Effect.mapError(badRequest))
      return { keys }
    })

    const authKeyRemove = Effect.fn("ControlHttpApi.authKeyRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID; keyID: string }
    }) {
      yield* auth.removeKey(ctx.params.providerID, ctx.params.keyID).pipe(Effect.mapError(badRequest))
      const keys = yield* auth.listKeys(ctx.params.providerID).pipe(Effect.mapError(badRequest))
      return { keys }
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers
      .handle("authSet", authSet)
      .handle("authRemove", authRemove)
      .handle("authKeyList", authKeyList)
      .handle("authKeyAdd", authKeyAdd)
      .handle("authKeyActivate", authKeyActivate)
      .handle("authKeyRemove", authKeyRemove)
      .handle("log", log)
  }),
)
