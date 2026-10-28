import { describe, expect, test } from "bun:test"
import { parseProjectDirectories } from "./lan-projects"

describe("parseProjectDirectories", () => {
  test("reads the local desktop project list", () => {
    const raw = JSON.stringify({
      projects: {
        local: [
          { worktree: "E:\opencode-source", expanded: true },
          { worktree: "E:\notes", expanded: false },
        ],
      },
      lastProject: { local: "E:\opencode-source" },
    })

    expect(parseProjectDirectories(raw)).toEqual({
      directories: ["E:\opencode-source", "E:\notes"],
      lastProject: "E:\opencode-source",
    })
  })

  test("accepts an already parsed store value", () => {
    expect(
      parseProjectDirectories({
        projects: { local: [{ worktree: "/repo" }] },
        lastProject: { local: "/repo" },
      }),
    ).toEqual({ directories: ["/repo"], lastProject: "/repo" })
  })

  test("deduplicates and ignores invalid entries", () => {
    expect(
      parseProjectDirectories({
        projects: { local: [{ worktree: "/repo" }, { worktree: "/repo" }, {}, null, { worktree: 1 }] },
      }),
    ).toEqual({ directories: ["/repo"], lastProject: undefined })
  })

  test("ignores missing, malformed, or remote-only state", () => {
    expect(parseProjectDirectories(undefined)).toEqual({ directories: [] })
    expect(parseProjectDirectories("{")).toEqual({ directories: [] })
    expect(parseProjectDirectories({ projects: { "https://debian.example": [{ worktree: "/remote" }] } })).toEqual({
      directories: [],
    })
  })
})
