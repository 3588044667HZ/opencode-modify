import { describe, expect, test } from "bun:test"
import { ContributionLedger } from "../../src/pack/ledger"

const contribution = (packId: string, id: string) => ({
  packId,
  scope: "project:a",
  kind: "tool" as const,
  id,
  value: { id },
})

describe("contribution ledger", () => {
  test("adds, lists, and removes contributions", () => {
    const ledger = new ContributionLedger()
    const dispose = ledger.add(contribution("a", "one"))
    ledger.add(contribution("a", "two"))

    expect(ledger.list("project:a", "tool").map((item) => item.id)).toEqual(["one", "two"])
    dispose()
    expect(ledger.list("project:a", "tool").map((item) => item.id)).toEqual(["two"])
    expect(ledger.version).toBe(3)
  })

  test("rejects cross-pack conflicts and allows same-pack replacement", () => {
    const ledger = new ContributionLedger()
    ledger.add(contribution("a", "one"))
    expect(() => ledger.add(contribution("b", "one"))).toThrow("already owned by a")
    expect(() => ledger.add(contribution("a", "one"))).not.toThrow()
    expect(ledger.list("project:a")).toHaveLength(1)
  })

  test("removes all contributions for a pack or scope", () => {
    const ledger = new ContributionLedger()
    ledger.add(contribution("a", "one"))
    ledger.add(contribution("a", "two"))
    ledger.add({ ...contribution("b", "three"), scope: "project:b" })

    expect(ledger.removePack("a", "project:a")).toHaveLength(2)
    expect(ledger.list("project:a")).toHaveLength(0)
    expect(ledger.list("project:b")).toHaveLength(1)
    expect(ledger.removeScope("project:b")).toHaveLength(1)
    expect(ledger.snapshot().contributions).toHaveLength(0)
  })
})
