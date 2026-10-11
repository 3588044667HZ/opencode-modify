import { describe, expect, test } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit } from "effect"
import os from "os"
import path from "path"
import { isHighRiskAutonomyPath, resolveAutonomy } from "../../src/tool/subagent"

const home = os.homedir()
const root = path.parse(home).root
const external = path.join(root, "opencode-autonomy-external")

const run = (directories: readonly string[], rulesets: readonly PermissionV1.Ruleset[] = []) =>
  Effect.runPromiseExit(resolveAutonomy({ directories, rulesets }))

const failureMessage = (exit: Exit.Exit<string[], Error>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const failure = Cause.squash(exit.cause)
  return failure instanceof Error ? failure.message : String(failure)
}

describe("tool.subagent autonomy", () => {
  describe("isHighRiskAutonomyPath", () => {
    test("rejects the filesystem root", () => {
      expect(isHighRiskAutonomyPath(root)).toBe(true)
    })

    test("rejects the home directory", () => {
      expect(isHighRiskAutonomyPath(home)).toBe(true)
    })

    test("rejects home ancestors", () => {
      expect(isHighRiskAutonomyPath(path.dirname(home))).toBe(true)
    })

    test("rejects sensitive segments", () => {
      expect(isHighRiskAutonomyPath(path.join(home, ".ssh"))).toBe(true)
      expect(isHighRiskAutonomyPath(path.join(home, ".aws"))).toBe(true)
      expect(isHighRiskAutonomyPath(path.join(home, ".config", "opencode"))).toBe(true)
    })

    test("rejects wildcard-only patterns", () => {
      expect(isHighRiskAutonomyPath("*")).toBe(true)
      expect(isHighRiskAutonomyPath("**")).toBe(true)
    })

    test("accepts a normal external directory", () => {
      expect(isHighRiskAutonomyPath(external)).toBe(false)
    })
  })

  describe("resolveAutonomy", () => {
    test("normalizes absolute directories to external_directory globs", async () => {
      const exit = await run([external])
      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) throw new Error("expected success")
      expect(exit.value).toEqual([FSUtil.normalizePathPattern(path.join(external, "*"))])
    })

    test("dedupes repeated directories", async () => {
      const exit = await run([external, external])
      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) throw new Error("expected success")
      expect(exit.value).toHaveLength(1)
    })

    test("rejects relative paths", async () => {
      const exit = await run(["relative/path"])
      expect(failureMessage(exit)).toBe('Autonomy path must be absolute: "relative/path"')
    })

    test("rejects high-risk paths", async () => {
      const exit = await run([home])
      expect(failureMessage(exit)).toBe(`Autonomy path is high-risk and requires human approval: "${home}"`)
    })

    test("rejects a path that conflicts with a deny rule", async () => {
      const glob = FSUtil.normalizePathPattern(path.join(external, "*"))
      const exit = await run([external], [
        [{ permission: "external_directory", pattern: glob, action: "deny" }],
      ])
      expect(failureMessage(exit)).toBe(`Autonomy path conflicts with a deny rule: "${external}"`)
    })

    test("ignores non-matching deny rules", async () => {
      const exit = await run([external], [
        [{ permission: "external_directory", pattern: path.join(root, "other", "*"), action: "deny" }],
      ])
      expect(Exit.isSuccess(exit)).toBe(true)
    })

    test("allows a grant when a later rule overrides a catch-all deny", async () => {
      const exit = await run([external], [
        [
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "external_directory", pattern: "*", action: "ask" },
        ],
      ])
      expect(Exit.isSuccess(exit)).toBe(true)
    })

    test("rejects more than 8 directories", async () => {
      const directories = Array.from({ length: 9 }, (_, index) => path.join(root, `opencode-autonomy-${index}`))
      const exit = await run(directories)
      expect(failureMessage(exit)).toBe("Autonomy accepts at most 8 directories")
    })
  })
})
