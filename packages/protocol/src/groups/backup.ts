import { Schema } from "effect"
import {
  BackupConfigureInput,
  BackupRunResult,
  BackupSnapshotSummary,
  BackupStatus,
} from "@opencode-ai/schema/backup"
import { PositiveInt } from "@opencode-ai/schema/schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError } from "../errors"
export { BackupConfigureInput, BackupRunResult, BackupSnapshotSummary, BackupStatus } from "@opencode-ai/schema/backup"

export class BackupError extends Schema.TaggedErrorClass<BackupError>()(
  "BackupError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const SnapshotsQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export const BackupGroup = HttpApiGroup.make("server.backup")
  .add(
    HttpApiEndpoint.get("backup.status", "/api/backup/status", {
      success: BackupStatus,
      error: BackupError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.backup.status",
        summary: "Get backup status",
        description: "Return local backup configuration state and the latest run status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("backup.run", "/api/backup/run", {
      success: BackupRunResult.pipe(HttpApiSchema.status(202)),
      error: [InvalidRequestError, BackupError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.backup.run",
        summary: "Start a backup",
        description: "Start a backup in the background and return immediately.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("backup.snapshots", "/api/backup/snapshots", {
      query: SnapshotsQuery,
      success: Schema.Array(BackupSnapshotSummary),
      error: [InvalidRequestError, BackupError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.backup.snapshots",
        summary: "List backup snapshots",
        description: "List snapshots stored on the configured backup server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("backup.configure", "/api/backup/configure", {
      payload: BackupConfigureInput,
      success: BackupStatus,
      error: [InvalidRequestError, ForbiddenError, BackupError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.backup.configure",
        summary: "Configure backup",
        description:
          "Store backup configuration in the global config and the token in the state directory. Tokens are never returned.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "backup",
      description: "Local backup configuration, manual runs, and remote snapshots.",
    }),
  )
