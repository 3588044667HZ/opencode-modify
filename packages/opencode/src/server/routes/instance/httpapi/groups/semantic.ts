import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/semantic"

export const SemanticStatusInfo = Schema.Struct({
  status: Schema.Literals(["disabled", "idle", "starting", "indexing", "ready", "failed"]),
  progress: Schema.Number,
  phase: Schema.optional(Schema.String),
  current: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "SemanticStatusInfo" })

export const SemanticPaths = {
  status: `${root}/status`,
  warmup: `${root}/warmup`,
} as const

export const SemanticApi = HttpApi.make("semantic")
  .add(
    HttpApiGroup.make("semantic")
      .add(
        HttpApiEndpoint.get("status", SemanticPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(SemanticStatusInfo, "Semantic engine status snapshot"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "semantic.status",
            summary: "Get semantic engine status",
            description:
              "Get the current semantic engine status snapshot for the active project directory without starting the daemon.",
          }),
        ),
        HttpApiEndpoint.post("warmup", SemanticPaths.warmup, {
          query: WorkspaceRoutingQuery,
          success: described(SemanticStatusInfo, "Semantic engine status snapshot after warmup trigger"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "semantic.warmup",
            summary: "Warm up semantic engine",
            description:
              "Trigger a lazy cold start of the semantic engine daemon for the active project directory and return the post-trigger status snapshot. Ongoing progress continues through semantic.indexing events.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "semantic",
          description: "Experimental HttpApi semantic routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
