export * as ConfigBackup from "./backup"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Backup")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable the daily backup scheduler (default: false)",
  }),
  server: Schema.String.pipe(Schema.optional).annotate({
    description: "Backup server base URL, for example https://backup.example.com",
  }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Backup server username",
  }),
  schedule: Schema.String.pipe(Schema.optional).annotate({
    description: "Five-field cron expression in local time (default: 30 3 * * *)",
  }),
  retention: PositiveInt.pipe(Schema.optional).annotate({
    description: "Preferred number of snapshots to retain on the server (display/request only)",
  }),
  include_tool_output: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include managed tool output files (default: true)",
  }),
  include_snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include local git snapshots used for undo (default: false)",
  }),
  include_project_config: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include discovered per-project opencode configuration files (default: false)",
  }),
}) {}