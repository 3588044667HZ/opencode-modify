import { describe, expect, test } from "bun:test"
import { FoldPolicy } from "../../src/session/fold-policy"

describe("session.fold-policy", () => {
  describe("hard boundaries", () => {
    test("pending edit payloads are never foldable", () => {
      const decision = FoldPolicy.decide({ kind: "pending-edit-payload", consumed: true })
      expect(decision.action).toBe("keep")
      expect(decision.reason).toContain("pending edit payload")
      expect(decision.hotPath).toBe("none")
    })

    test("current edit targets are never foldable", () => {
      const decision = FoldPolicy.decide({ kind: "edit-target", consumed: true })
      expect(decision.action).toBe("keep")
      expect(decision.reason).toContain("edit target")
    })

    test("user-pasted code is never foldable", () => {
      const decision = FoldPolicy.decide({ kind: "user-paste", consumed: true })
      expect(decision.action).toBe("keep")
      expect(decision.reason).toContain("user-pasted")
    })

    test("unique history without a snapshot is never foldable", () => {
      const decision = FoldPolicy.decide({
        kind: "superseded-read",
        recoverability: "unique-no-snapshot",
        consumed: true,
      })
      expect(decision.action).toBe("keep")
      expect(decision.reason).toContain("without a snapshot")
    })

    test("action-before content is never foldable even when otherwise consumable", () => {
      const decision = FoldPolicy.decide({ kind: "exploration-read", pendingAction: true })
      expect(decision.action).toBe("keep")
      expect(decision.reason).toContain("action-before")
    })

    test("boundaries win over shared-anchor deferral and oversized folding", () => {
      expect(
        FoldPolicy.decide({ kind: "user-paste", sharedAnchors: true, oversized: true }).action,
      ).toBe("keep")
    })
  })

  describe("decision table", () => {
    test("consumed exploration reads fold to a pointer stub on the hot path", () => {
      const decision = FoldPolicy.decide({ kind: "exploration-read", consumed: true })
      expect(decision.action).toBe("pointer")
      expect(decision.hotPath).toBe("marker")
    })

    test("unconsumed exploration reads stay", () => {
      expect(FoldPolicy.decide({ kind: "exploration-read" }).action).toBe("keep")
    })

    test("superseded reads fold immediately to a pointer stub", () => {
      const decision = FoldPolicy.decide({ kind: "superseded-read", consumed: false })
      expect(decision.action).toBe("pointer")
      expect(decision.hotPath).toBe("marker")
    })

    test("duplicate views fold into the newest copy", () => {
      const decision = FoldPolicy.decide({ kind: "duplicate-view", duplicateOfNewer: true, consumed: true })
      expect(decision.action).toBe("dedupe-latest")
      expect(decision.hotPath).toBe("marker")
    })

    test("the newest duplicate view itself stays", () => {
      expect(FoldPolicy.decide({ kind: "duplicate-view" }).action).toBe("keep")
    })

    test("stable interfaces fold semantically", () => {
      const decision = FoldPolicy.decide({ kind: "stable-interface", consumed: true })
      expect(decision.action).toBe("semantic")
      expect(decision.hotPath).toBe("marker")
    })

    test("oversized content uses the tool_output stub mode", () => {
      const decision = FoldPolicy.decide({ kind: "exploration-read", consumed: true, oversized: true })
      expect(decision.action).toBe("tool-output")
      expect(decision.hotPath).toBe("none")
    })

    test("working sets keep the newest version and fold older versions to a delta", () => {
      expect(FoldPolicy.decide({ kind: "working-set", latest: true }).action).toBe("keep")
      const older = FoldPolicy.decide({ kind: "working-set", latest: false })
      expect(older.action).toBe("delta")
      expect(older.hotPath).toBe("marker")
    })

    test("shared anchors defer folding to the task/agent boundary", () => {
      const decision = FoldPolicy.decide({ kind: "exploration-read", consumed: true, sharedAnchors: true })
      expect(decision.action).toBe("defer-task-boundary")
      expect(decision.hotPath).toBe("none")
    })
  })

  describe("triple test", () => {
    test("recoverability maps immutable/versioned/unique sources", () => {
      expect(FoldPolicy.recoverability({ kind: "exploration-read", recoverability: "immutable" })).toBe("restorable")
      expect(FoldPolicy.recoverability({ kind: "exploration-read" })).toBe("current-version-only")
      expect(
        FoldPolicy.recoverability({ kind: "exploration-read", recoverability: "unique-no-snapshot" }),
      ).toBe("forbidden")
    })

    test("consumption maps before-action/consumed/in-progress", () => {
      expect(FoldPolicy.consumption({ kind: "exploration-read", pendingAction: true })).toBe("before-action")
      expect(FoldPolicy.consumption({ kind: "exploration-read", consumed: true })).toBe("consumed")
      expect(FoldPolicy.consumption({ kind: "exploration-read" })).toBe("in-progress")
    })

    test("resolution picks the strongest sufficient replacement", () => {
      expect(FoldPolicy.resolution({ kind: "exploration-read", consumed: true })).toBe("pointer")
      expect(FoldPolicy.resolution({ kind: "stable-interface" })).toBe("semantic")
      expect(FoldPolicy.resolution({ kind: "working-set", latest: false })).toBe("delta")
      expect(FoldPolicy.resolution({ kind: "exploration-read", oversized: true })).toBe("tool-output")
      expect(FoldPolicy.resolution({ kind: "duplicate-view" })).toBe("dedupe-latest")
    })

    test("hardBoundary reports nothing for foldable inputs", () => {
      expect(FoldPolicy.hardBoundary({ kind: "exploration-read", consumed: true })).toBeUndefined()
    })
  })
})
