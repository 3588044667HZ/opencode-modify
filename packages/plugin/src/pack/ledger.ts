export type ContributionKind = "tool" | "agent" | "prompt" | "rpc" | "ui"

export type Contribution = {
  packId: string
  scope: string
  kind: ContributionKind
  id: string
  value: unknown
}

export type ContributionSnapshot = {
  version: number
  contributions: readonly Contribution[]
}

function key(contribution: Pick<Contribution, "scope" | "kind" | "id">) {
  return `${contribution.scope}\u0000${contribution.kind}\u0000${contribution.id}`
}

export class ContributionLedger {
  private entries = new Map<string, Contribution>()
  private revision = 0

  get version() {
    return this.revision
  }

  add(contribution: Contribution) {
    const current = this.entries.get(key(contribution))
    if (current && current.packId !== contribution.packId) {
      throw new Error(
        `Contribution conflict: ${contribution.kind}:${contribution.id} is already owned by ${current.packId}`,
      )
    }
    this.entries.set(key(contribution), contribution)
    this.revision++
    return () => {
      if (this.entries.get(key(contribution)) !== contribution) return
      this.entries.delete(key(contribution))
      this.revision++
    }
  }

  removePack(packId: string, scope?: string) {
    const removed: Contribution[] = []
    for (const [itemKey, contribution] of this.entries) {
      if (contribution.packId !== packId) continue
      if (scope !== undefined && contribution.scope !== scope) continue
      this.entries.delete(itemKey)
      removed.push(contribution)
    }
    if (removed.length > 0) this.revision++
    return removed
  }

  removeScope(scope: string) {
    const removed: Contribution[] = []
    for (const [itemKey, contribution] of this.entries) {
      if (contribution.scope !== scope) continue
      this.entries.delete(itemKey)
      removed.push(contribution)
    }
    if (removed.length > 0) this.revision++
    return removed
  }

  list(scope: string, kind?: ContributionKind) {
    return this.snapshot().contributions.filter(
      (contribution) => contribution.scope === scope && (kind === undefined || contribution.kind === kind),
    )
  }

  snapshot(): ContributionSnapshot {
    const contributions = [...this.entries.values()].sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    )
    return { version: this.revision, contributions }
  }

  clear() {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.revision++
  }
}
