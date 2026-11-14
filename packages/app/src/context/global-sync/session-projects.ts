import { pathKey } from "@/utils/path-key"

export const SESSION_PROJECT_SEED_LIMIT = 10
const GLOBAL_PROJECT_ID = "global"

type SessionSeed = {
  readonly parentID?: string
  readonly projectID: string
  readonly location: { readonly directory: string }
  readonly time: { readonly updated: number; readonly archived?: number }
}

type ProjectSeed = {
  readonly id?: string
  readonly worktree: string
  readonly sandboxes?: ReadonlyArray<string>
}

/**
 * Directories a headless/LAN client should treat as known projects.
 *
 * The server project table only holds git worktrees; sessions from non-git
 * directories all belong to the single `global` project. Web clients have no
 * local project store of their own, so derive recent directories from sessions
 * when the server cannot enumerate them.
 */
export function recentSessionDirectories(input: {
  sessions: ReadonlyArray<SessionSeed>
  projects: ReadonlyArray<ProjectSeed>
  recentlyClosed: ReadonlyArray<string>
  limit?: number
}) {
  const known = new Set<string>()
  const covered = new Set<string>()
  for (const project of input.projects) {
    if (project.id && project.id !== GLOBAL_PROJECT_ID) known.add(project.id)
    if (project.worktree) covered.add(pathKey(project.worktree))
    for (const sandbox of project.sandboxes ?? []) covered.add(pathKey(sandbox))
  }
  const closed = new Set(input.recentlyClosed.map((directory) => pathKey(directory)))
  const recent = new Map<string, { directory: string; updated: number }>()

  for (const session of input.sessions) {
    if (session.parentID || session.time.archived !== undefined) continue
    if (known.has(session.projectID)) continue
    const directory = session.location.directory
    if (!directory) continue
    const key = pathKey(directory)
    if (covered.has(key) || closed.has(key)) continue
    const previous = recent.get(key)
    if (!previous || session.time.updated > previous.updated)
      recent.set(key, { directory, updated: session.time.updated })
  }

  return [...recent.values()]
    .sort((a, b) => b.updated - a.updated)
    .slice(0, input.limit ?? SESSION_PROJECT_SEED_LIMIT)
    .map((item) => item.directory)
}
