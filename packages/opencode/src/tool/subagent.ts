import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import type { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { Session } from "../session/session"
import { Provider } from "../provider/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Effect } from "effect"
import os from "os"
import path from "path"

/**
 * Creates (or reuses) the child session for a subagent launched from a tool.
 * Shared by `task` and `dispatch` so both honor the same session-tree, title,
 * and permission-derivation conventions. Desktop matches child sessions back to
 * their parent tool card using the `(@<agent> subagent)` title suffix, so the
 * title format must stay stable.
 */
export function createSubagentSession(input: {
  sessions: Session.Interface
  parent: Session.Info
  subagent: Agent.Info
  description: string
  primaryTools?: readonly string[]
  existing?: Session.Info
  autonomy?: readonly string[]
}): Effect.Effect<Session.Info> {
  return Effect.gen(function* () {
    const grants = (input.autonomy ?? []).map((glob) => ({
      permission: "external_directory" as const,
      pattern: glob,
      action: "allow" as const,
    }))
    if (input.existing) {
      // Resumed sessions keep their identity; append only the grants that are
      // not already present instead of silently ignoring the request.
      if (grants.length > 0) {
        const current = input.existing.permission ?? []
        const added = grants.filter(
          (grant) =>
            !current.some(
              (rule) =>
                rule.permission === grant.permission && rule.pattern === grant.pattern && rule.action === grant.action,
            ),
        )
        if (added.length > 0)
          yield* input.sessions.setPermission({
            sessionID: input.existing.id,
            permission: [...current, ...added],
          })
      }
      return input.existing
    }
    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: input.parent.permission ?? [],
      subagent: input.subagent,
    })
    const childToolDenies = [
      ...gatedDeny(input.subagent, "todowrite"),
      ...gatedDeny(input.subagent, "task"),
      ...gatedDeny(input.subagent, "dispatch"),
      ...(input.primaryTools ?? []).map((permission) => ({
        permission,
        pattern: "*" as const,
        action: "deny" as const,
      })),
    ]
    return yield* input.sessions.create({
      parentID: input.parent.id,
      title: input.description + ` (@${input.subagent.name} subagent)`,
      agent: input.subagent.name,
      permission: [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
        ...grants,
      ],
    })
  })
}

/**
 * Rejects directory grants an agent must never self-authorize. Filesystem
 * roots, the user's home directory (and its ancestors), well-known secret
 * stores, and wildcard-only patterns always require a human decision.
 */
export function isHighRiskAutonomyPath(input: string): boolean {
  if (input.replace(/[\\/*?]+/g, "").length === 0) return true
  const normalized = FSUtil.normalizePath(input)
  if (path.parse(normalized).root === normalized) return true
  if (FSUtil.contains(normalized, FSUtil.normalizePath(os.homedir()))) return true
  return hasSensitiveSegment(normalized)
}

/**
 * Validates lead-provided autonomy grants and normalizes them to the same
 * external-directory globs the ask flow produces, so an approved grant is
 * matched without another prompt. High-risk paths and grants that collide with
 * a deny rule fail before any child session is created.
 */
export function resolveAutonomy(input: {
  directories: readonly string[]
  rulesets: readonly PermissionV1.Ruleset[]
}): Effect.Effect<string[], Error> {
  return Effect.gen(function* () {
    const seen = new Set<string>()
    const globs: string[] = []
    for (const dir of input.directories) {
      if (!path.isAbsolute(dir))
        return yield* Effect.fail(new Error(`Autonomy path must be absolute: "${dir}"`))
      if (isHighRiskAutonomyPath(dir))
        return yield* Effect.fail(new Error(`Autonomy path is high-risk and requires human approval: "${dir}"`))
      if (dir.length > 512) return yield* Effect.fail(new Error(`Autonomy path is too long: "${dir}"`))
      if (seen.has(dir)) continue
      if (globs.length >= 8) return yield* Effect.fail(new Error("Autonomy accepts at most 8 directories"))
      const glob = FSUtil.normalizePathPattern(path.join(dir, "*"))
      // Match Permission.evaluate semantics: the last matching rule wins, so a
      // later allow/ask overrides an earlier catch-all deny. Only an effective
      // deny rejects the grant.
      const effective = input.rulesets
        .flat()
        .findLast(
          (rule) => Wildcard.match("external_directory", rule.permission) && Wildcard.match(glob, rule.pattern),
        )
      if (effective?.action === "deny")
        return yield* Effect.fail(new Error(`Autonomy path conflicts with a deny rule: "${dir}"`))
      seen.add(dir)
      globs.push(glob)
    }
    return globs
  })
}

const HIGH_RISK_SEGMENTS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store"]
const HIGH_RISK_SEQUENCES = [
  [".config", "opencode"],
  ["appdata", "roaming", "opencode"],
]

function hasSensitiveSegment(input: string): boolean {
  const segments = input
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  if (segments.some((segment) => HIGH_RISK_SEGMENTS.includes(segment))) return true
  return HIGH_RISK_SEQUENCES.some((sequence) =>
    segments.some((_, index) => sequence.every((segment, offset) => segments[index + offset] === segment)),
  )
}

/** Subagents are denied tools that could recursively fan out unless they opt in. */
function gatedDeny(subagent: Agent.Info, tool: string): PermissionV1.Rule[] {
  return subagent.permission.some((rule) => rule.permission === tool)
    ? []
    : [{ permission: tool, pattern: "*", action: "deny" }]
}

/**
 * Validates a lead-provided thinking intensity (`variant`) against the model
 * the subagent will actually run on. Downstream request preparation silently
 * ignores variants that are not in `Model.variants`, so a typo would otherwise
 * look like it worked while changing nothing. The `"default"` sentinel opts out
 * of any override and returns `undefined` without a model lookup.
 */
export function resolveSubagentVariant(input: {
  provider: Provider.Interface
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant: string
}): Effect.Effect<string | undefined, Error> {
  return Effect.gen(function* () {
    if (input.variant === "default") return undefined
    const model = yield* input.provider
      .getModel(input.providerID, input.modelID)
      .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (!model) {
      return yield* Effect.fail(
        new Error(`Cannot apply variant "${input.variant}": model ${input.providerID}/${input.modelID} was not found.`),
      )
    }
    const available = model.variants ? Object.keys(model.variants) : []
    if (available.includes(input.variant)) return input.variant
    const hint = available.length
      ? `Available variants: ${available.join(", ")}.`
      : `This model exposes no variants; omit "variant" instead.`
    return yield* Effect.fail(
      new Error(`Unknown variant "${input.variant}" for ${input.providerID}/${input.modelID}. ${hint}`),
    )
  })
}
