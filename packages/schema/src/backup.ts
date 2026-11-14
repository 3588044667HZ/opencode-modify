import { Schema } from "effect"
import { NonNegativeInt, optional, PositiveInt } from "./schema"

export const BackupStatus = Schema.Struct({
  running: Schema.Boolean,
  lastRunAt: optional(Schema.String),
  lastSuccessAt: optional(Schema.String),
  lastError: optional(Schema.String),
  lastSnapshotID: optional(Schema.String),
  lastLogicalBytes: optional(NonNegativeInt),
  lastUploadedBytes: optional(NonNegativeInt),
  lastDurationMs: optional(NonNegativeInt),
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  server: optional(Schema.String),
  username: optional(Schema.String),
  schedule: Schema.String,
  retention: PositiveInt,
  tokenConfigured: Schema.Boolean,
}).annotate({ identifier: "Backup.Status" })
export interface BackupStatus extends Schema.Schema.Type<typeof BackupStatus> {}

export const BackupSnapshotSummary = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  totalBytes: optional(NonNegativeInt),
  fileCount: optional(NonNegativeInt),
}).annotate({ identifier: "Backup.SnapshotSummary" })
export interface BackupSnapshotSummary extends Schema.Schema.Type<typeof BackupSnapshotSummary> {}

export const BackupConfigureInput = Schema.Struct({
  enabled: optional(Schema.Boolean),
  server: optional(Schema.String),
  username: optional(Schema.String),
  token: optional(Schema.String),
  password: optional(Schema.String),
  schedule: optional(Schema.String),
}).annotate({ identifier: "Backup.ConfigureInput" })
export interface BackupConfigureInput extends Schema.Schema.Type<typeof BackupConfigureInput> {}

export const BackupRunResult = Schema.Struct({
  running: Schema.Boolean,
  skipped: Schema.Boolean,
  snapshotID: optional(Schema.String),
  logicalBytes: optional(NonNegativeInt),
  uploadedBytes: optional(NonNegativeInt),
  files: optional(NonNegativeInt),
  chunks: optional(NonNegativeInt),
  durationMs: NonNegativeInt,
  reason: optional(Schema.String),
}).annotate({ identifier: "Backup.RunResult" })
export interface BackupRunResult extends Schema.Schema.Type<typeof BackupRunResult> {}
