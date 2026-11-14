import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
export { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"

const REASON_LIMIT = 1024
const SENSITIVE = /((?:token|password|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi

function truncateReason(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`
}

export function sanitizeSchemaReason(reason: string) {
  return truncateReason(reason.replace(SENSITIVE, "$1[redacted]"))
}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) => {
  const reason = sanitizeSchemaReason(error.cause.message)
  return Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: error.kind, reason }),
    Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
  )
})
