import { describe, expect, test } from "bun:test"
import { recentSessionDirectories, SESSION_PROJECT_SEED_LIMIT } from "./session-projects"

function session(
  directory: string,
  updated: number,
  extra?: { parentID?: string; projectID?: string; archived?: number },
) {
  return {
    projectID: extra?.projectID ?? "global",
    parentID: extra?.parentID,
    location: { directory },
    time: { updated, archived: extra?.archived },
  }
}

describe("recentSessionDirectories", () => {
  test("returns non-git session directories newest first", () => {
    expect(
      recentSessionDirectories({
        sessions: [session("/home/a", 10), session("/home/b", 30), session("/home/a", 20)],
        projects: [{ id: "global", worktree: "/" }],
        recentlyClosed: [],
      }),
    ).toEqual(["/home/b", "/home/a"])
  })

  test("skips directories already represented by a project or sandbox", () => {
    expect(
      recentSessionDirectories({
        sessions: [session("C:\\repo", 5), session("C:\\repo\\worktree", 6), session("C:\\other", 7)],
        projects: [{ id: "project", worktree: "C:/repo", sandboxes: ["C:/repo/worktree"] }],
        recentlyClosed: [],
      }),
    ).toEqual(["C:\\other"])
  })

  test("skips sessions owned by a known project", () => {
    expect(
      recentSessionDirectories({
        sessions: [session("C:/repo/sub", 9, { projectID: "project" }), session("C:/loose", 1)],
        projects: [{ id: "project", worktree: "C:/repo" }],
        recentlyClosed: [],
      }),
    ).toEqual(["C:/loose"])
  })

  test("respects recently closed directories", () => {
    expect(
      recentSessionDirectories({
        sessions: [session("C:\\closed", 2), session("C:\\open", 1)],
        projects: [],
        recentlyClosed: ["C:/closed/"],
      }),
    ).toEqual(["C:\\open"])
  })

  test("ignores child, archived, and empty session directories", () => {
    expect(
      recentSessionDirectories({
        sessions: [
          session("/parent", 4),
          session("/child", 3, { parentID: "ses_parent" }),
          session("/archived", 2, { archived: 1 }),
          session("", 1),
        ],
        projects: [],
        recentlyClosed: [],
      }),
    ).toEqual(["/parent"])
  })

  test("caps the number of seeded projects", () => {
    const sessions = Array.from({ length: SESSION_PROJECT_SEED_LIMIT + 2 }, (_, index) => session(`/p${index}`, index))
    const result = recentSessionDirectories({ sessions, projects: [], recentlyClosed: [] })
    expect(result).toHaveLength(SESSION_PROJECT_SEED_LIMIT)
    expect(result[0]).toBe(`/p${SESSION_PROJECT_SEED_LIMIT + 1}`)
  })

  test("honours a custom limit", () => {
    expect(
      recentSessionDirectories({
        sessions: [session("/one", 2), session("/two", 1)],
        projects: [],
        recentlyClosed: [],
        limit: 1,
      }),
    ).toEqual(["/one"])
  })
})
