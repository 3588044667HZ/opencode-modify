import { Semantic } from "@/semantic/manager"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const semanticHandlers = HttpApiBuilder.group(InstanceHttpApi, "semantic", (handlers) =>
  Effect.gen(function* () {
    const semantic = yield* Semantic.Service

    const status = Effect.fn("SemanticHttpApi.status")(function* () {
      return yield* semantic.status()
    })

    const warmup = Effect.fn("SemanticHttpApi.warmup")(function* () {
      return yield* semantic.warmup()
    })

    return handlers.handle("status", status).handle("warmup", warmup)
  }),
)
