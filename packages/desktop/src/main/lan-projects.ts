export type DesktopProjectList = {
  directories: string[]
  lastProject?: string
}

const empty: DesktopProjectList = { directories: [] }

export function parseProjectDirectories(raw: unknown): DesktopProjectList {
  if (raw === undefined || raw === null) return empty
  let value: unknown
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch {
    return empty
  }
  if (!value || typeof value !== "object") return empty
  const state = value as {
    projects?: Record<string, unknown>
    lastProject?: Record<string, unknown>
  }
  const entries = state.projects?.local
  if (!Array.isArray(entries)) return empty
  const directories = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const worktree = (entry as { worktree?: unknown }).worktree
    return typeof worktree === "string" && worktree ? [worktree] : []
  })
  const last = state.lastProject?.local
  return {
    directories: [...new Set(directories)],
    lastProject: typeof last === "string" ? last : undefined,
  }
}
