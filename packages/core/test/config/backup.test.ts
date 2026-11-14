import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

const backup = {
  enabled: true,
  server: "https://backup.example.com",
  username: "alice",
  schedule: "30 3 * * *",
  retention: 7,
  include_tool_output: true,
  include_snapshots: false,
  include_project_config: true,
}

describe("backup config schema", () => {
  test("is exposed on the core V2 config", () => {
    const decoded = Schema.decodeUnknownSync(Config.Info)({ backup })
    expect(decoded.backup?.enabled).toBe(true)
    expect(decoded.backup?.retention).toBe(7)
    expect(decoded.backup?.include_project_config).toBe(true)
    expect(Schema.decodeUnknownSync(Config.Info)({}).backup).toBeUndefined()
  })

  test("is exposed on the V1 config and survives migration", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({ backup })
    expect(decoded.backup?.server).toBe("https://backup.example.com")
    const migrated = ConfigMigrateV1.migrate(decoded)
    expect(migrated.backup).toEqual(decoded.backup)
  })

  test("rejects invalid types", () => {
    expect(() => Schema.decodeUnknownSync(Config.Info)({ backup: { retention: 0 } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Config.Info)({ backup: { enabled: "yes" } })).toThrow()
  })
})