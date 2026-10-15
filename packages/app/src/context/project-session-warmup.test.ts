import { describe, expect, test } from "bun:test"
import { createProjectSessionWarmup } from "./project-session-warmup"

type ProjectEntry = { worktree: string; expanded: boolean }

function harness(projects: ProjectEntry[]) {
  const loads: string[] = []
  const opened: string[] = []
  const expanded: string[] = []
  const warmup = createProjectSessionWarmup({
    list: () => projects,
    rootFor: (directory) => directory.replace(/\/sub$/, ""),
    loadSessions: (directory) => {
      loads.push(directory)
    },
    openProject: (root) => opened.push(root),
    expandProject: (root) => expanded.push(root),
  })
  return { warmup, loads, opened, expanded }
}

const projects = Array.from({ length: 5 }, (_, index) => ({ worktree: `/p${index}`, expanded: true }))

describe("createProjectSessionWarmup", () => {
  test("startup does not load sessions for every opened project", () => {
    const h = harness(projects)
    expect(h.loads).toEqual([])
  })

  test("expand loads only the expanded project and coalesces repeats", () => {
    const h = harness(projects)
    h.warmup.expand("/p2")
    h.warmup.expand("/p2")
    h.warmup.expand("/p2")
    expect(h.loads).toEqual(["/p2"])
    expect(h.expanded).toContain("/p2")
    expect(h.expanded.every((root) => root === "/p2")).toBe(true)
  })

  test("expand resolves sandbox directories to the project root", () => {
    const h = harness(projects)
    h.warmup.expand("/p2/sub")
    expect(h.loads).toEqual(["/p2"])
    expect(h.expanded).toEqual(["/p2"])
  })

  test("expand ignores projects that are not open", () => {
    const h = harness(projects)
    h.warmup.expand("/unknown")
    expect(h.loads).toEqual([])
    expect(h.expanded).toEqual([])
  })

  test("open loads and opens a project that is not open yet", () => {
    const h = harness(projects)
    h.warmup.open("/p9")
    expect(h.loads).toEqual(["/p9"])
    expect(h.opened).toEqual(["/p9"])
  })

  test("open keeps existing behavior for an already open project", () => {
    const h = harness(projects)
    h.warmup.open("/p1")
    expect(h.loads).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("re-expanding after a pending load settles issues another request", async () => {
    const loads: string[] = []
    let release!: () => void
    const warmup = createProjectSessionWarmup({
      list: () => [{ worktree: "/p1", expanded: true }],
      rootFor: (directory) => directory,
      loadSessions: (directory) => {
        loads.push(directory)
        return new Promise<void>((resolve) => (release = resolve))
      },
      openProject: () => {},
      expandProject: () => {},
    })

    warmup.expand("/p1")
    warmup.expand("/p1")
    expect(loads).toEqual(["/p1"])

    release()
    await Promise.resolve()
    await Promise.resolve()

    warmup.expand("/p1")
    expect(loads).toEqual(["/p1", "/p1"])
  })

  test("a failed load clears the in-flight guard so a later expand can retry", async () => {
    let calls = 0
    const warmup = createProjectSessionWarmup({
      list: () => [{ worktree: "/p1", expanded: true }],
      rootFor: (directory) => directory,
      loadSessions: () => {
        calls++
        return Promise.reject(new Error("load failed"))
      },
      openProject: () => {},
      expandProject: () => {},
    })

    warmup.expand("/p1")
    await Promise.resolve()
    await Promise.resolve()

    warmup.expand("/p1")
    expect(calls).toBe(2)
  })
})
