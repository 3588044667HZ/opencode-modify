export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for opencode serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  subagent_depth: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents.",
  }),
  team: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.optional(Schema.String),
        members: Schema.mutable(
          Schema.Array(
            Schema.Struct({
              agent: Schema.String,
              role: Schema.optional(Schema.String),
              description: Schema.optional(Schema.String),
              prompt: Schema.optional(Schema.String),
              variant: Schema.optional(Schema.String).annotate({
                description:
                  "Thinking intensity for this member's effective model (e.g. low, medium, high, max). Must match one of the model's variants.",
              }),
              autonomy: Schema.optional(Schema.Array(Schema.String)).annotate({
                description:
                  "External directories (absolute paths) this member may access without prompting. High-risk paths require human approval.",
              }),
            }),
          ),
        ),
        max_parallel: Schema.optional(PositiveInt),
        aggregate: Schema.optional(Schema.Literals(["concat", "none"])),
      }),
    ),
  ).annotate({
    description:
      "Named subagent rosters for the dispatch tool. Each entry lists members (agent + optional role) that can be dispatched in parallel.",
  }),
  agent_message: Schema.optional(
    Schema.Struct({
      max_hop: Schema.optional(PositiveInt).annotate({ description: "Maximum peer-message hop count (default 8)" }),
      max_body_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum peer-message body size in bytes (default 8192)",
      }),
      max_per_minute: Schema.optional(PositiveInt).annotate({
        description: "Maximum peer messages a session may send per minute (default 20)",
      }),
      wake_idle: Schema.optional(Schema.Boolean).annotate({
        description: "Whether a peer message wakes an idle target session (default true)",
      }),
    }),
  ).annotate({ description: "Peer messaging limits for the agent_send tool" }),
  blackboard: Schema.optional(
    Schema.Struct({
      max_value_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum blackboard value size in bytes (default 65536)",
      }),
      max_keys: Schema.optional(PositiveInt).annotate({ description: "Maximum blackboard keys per session tree (default 256)" }),
    }),
  ).annotate({ description: "Shared team blackboard limits for the blackboard tool" }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  semantic: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Enable the semantic engine daemon (default: false)",
      }),
      command: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description:
          "Base argv used to launch the semantic engine daemon. The manager appends the project directory and the socket path.",
      }),
      jar: Schema.optional(Schema.String).annotate({
        description:
          "Path to semantic-server.jar used when semantic.command is not set; the daemon runs on a discovered JetBrains IDE JBR",
      }),
      socket_dir: Schema.optional(Schema.String).annotate({
        description: "Directory for the semantic daemon socket (default: system temp directory)",
      }),
      idle_timeout_ms: Schema.optional(NonNegativeInt).annotate({
        description: "Idle timeout in milliseconds passed to the semantic daemon",
      }),
      ide: Schema.optional(Schema.String).annotate({
        description:
          'JetBrains IDE for the semantic daemon: "auto", a product selector such as idea/pycharm/webstorm, or an install path (default: auto)',
      }),
      ide_home: Schema.optional(Schema.String).annotate({
        description: "Explicit path to the JetBrains IDE installation used by the semantic daemon",
      }),
      jdk_home: Schema.optional(Schema.String).annotate({
        description: "JDK home passed to the semantic daemon as SEMANTIC_JDK_HOME",
      }),
      exclude: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description:
          "Project-relative directory patterns excluded from semantic indexing, e.g. node_modules or packages/*/dist",
      }),
    }),
  ).annotate({ description: "Semantic engine daemon configuration" }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Maximum number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction. By default retention is limited only by the preserved token budget.",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
