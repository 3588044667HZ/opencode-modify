export * as SemanticEvent from "./semantic-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const Indexing = Event.define({
  type: "semantic.indexing",
  schema: {
    status: Schema.Literals(["starting", "indexing", "ready", "failed"]),
    progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    current: optional(Schema.String),
    phase: optional(Schema.String),
    error: optional(Schema.String),
  },
})

export const Definitions = Event.inventory(Indexing)
