import * as Tool from "./tool"
import DESCRIPTION from "./mcp.txt"
import { MCP } from "@/mcp"
import { Effect, Schema } from "effect"

const id = "mcp"

type Metadata = { servers: number; name?: string; status?: string; [key: string]: unknown }

export const Parameters = Schema.Struct({
  op: Schema.Literals(["list", "enable", "disable"]).annotate({
    description: '"list" shows configured MCP servers; "enable"/"disable" changes one configured server at runtime',
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "MCP server name from opencode.json; required for enable/disable",
  }),
})

export const McpTool = Tool.define(
  id,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    const configured = () => mcp.configured().pipe(Effect.orDie)

    const render = (servers: Record<string, MCP.Status>) =>
      [
        `<configured_mcp servers="${Object.keys(servers).length}">`,
        ...Object.entries(servers)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([name, status]) =>
            status.status === "failed"
              ? `<server name="${name}" status="failed" error="${escapeAttribute(status.error)}" />`
              : `<server name="${name}" status="${status.status}" />`,
          ),
        "</configured_mcp>",
      ].join("\n")

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        _ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (params.op === "list") {
            const servers = yield* configured()
            return {
              title: `MCP servers (${Object.keys(servers).length})`,
              metadata: { servers: Object.keys(servers).length },
              output: render(servers),
            }
          }

          if (!params.name) return yield* Effect.die(new Error(`mcp ${params.op} requires name`))
          const servers = yield* configured()
          if (!Object.hasOwn(servers, params.name)) {
            return yield* Effect.die(
              new Error(`Unknown MCP server: ${params.name}. Only servers configured in opencode.json can be changed.`),
            )
          }

          if (params.op === "enable") yield* mcp.connect(params.name).pipe(Effect.orDie)
          else yield* mcp.disconnect(params.name).pipe(Effect.orDie)

          const next = yield* configured()
          return {
            title: `MCP ${params.name} ${params.op === "enable" ? "enabled" : "disabled"}`,
            metadata: { servers: Object.keys(next).length, name: params.name, status: next[params.name]?.status },
            output: render(next),
          }
        }),
    }
  }),
)

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
