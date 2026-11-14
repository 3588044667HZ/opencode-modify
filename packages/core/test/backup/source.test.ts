import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BackupSource } from "@opencode-ai/core/backup/source"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "../fixture/tmpdir"

async function write(file: string, content = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe("backup source", () => {
  test("enumerates data, config, and optional tool output while excluding repos/log/snapshots", async () => {
    await using tmp = await tmpdir()
    const roots = {
      data: path.join(tmp.path, "data"),
      config: path.join(tmp.path, "config"),
      state: path.join(tmp.path, "state"),
      cache: path.join(tmp.path, "cache"),
    }
    await write(path.join(roots.data, "auth.json"), "auth")
    await write(path.join(roots.data, "mcp-auth.json"), "mcp")
    await write(path.join(roots.data, "tool-output", "session", "out.txt"), "tool")
    await write(path.join(roots.data, "snapshot", "project", "HEAD"), "snapshot")
    await write(path.join(roots.data, "repos", "repo", "file"), "repo")
    await write(path.join(roots.data, "log", "log.txt"), "log")
    await write(path.join(roots.data, "opencode.db"), "db")
    await write(path.join(roots.data, "opencode.db-wal"), "wal")
    await write(path.join(roots.config, "opencode.jsonc"), "{}")
    await write(path.join(roots.config, "notes.txt"), "notes")
    await write(path.join(roots.state, "backup", "auth.json"), "secret")

    const files = await BackupSource.enumerate(roots, {
      includeToolOutput: true,
      includeSnapshots: false,
      includeProjectConfig: false,
    })
    expect(files.map((file) => file.path)).toEqual([
      "config/opencode.jsonc",
      "data/auth.json",
      "data/mcp-auth.json",
      "data/tool-output/session/out.txt",
    ])
    expect(files.every((file) => file.absolute !== undefined)).toBe(true)

    const noTools = await BackupSource.enumerate(roots, {
      includeToolOutput: false,
      includeSnapshots: false,
      includeProjectConfig: false,
    })
    expect(noTools.map((file) => file.path)).not.toContain("data/tool-output/session/out.txt")
  })

  test("does not follow a data-root symlink that escapes data", async () => {
    await using tmp = await tmpdir()
    const roots = {
      data: path.join(tmp.path, "data"),
      config: path.join(tmp.path, "config"),
      state: path.join(tmp.path, "state"),
      cache: path.join(tmp.path, "cache"),
    }
    await fs.mkdir(roots.data, { recursive: true })
    const outside = path.join(tmp.path, "outside")
    await write(path.join(outside, "secret.txt"), "outside")
    try {
      await fs.symlink(outside, path.join(roots.data, "tool-output"), "junction")
    } catch {
      return
    }

    const files = await BackupSource.enumerate(roots, {
      includeToolOutput: true,
      includeSnapshots: false,
      includeProjectConfig: false,
    })
    expect(files.some((file) => file.path.startsWith("data/tool-output"))).toBe(false)
  })

  test("includes snapshots and project config only when requested", async () => {
    await using tmp = await tmpdir()
    const roots = {
      data: path.join(tmp.path, "data"),
      config: path.join(tmp.path, "config"),
      state: path.join(tmp.path, "state"),
      cache: path.join(tmp.path, "cache"),
    }
    const project = path.join(tmp.path, "work", "project")
    await write(path.join(roots.data, "snapshot", "p", "HEAD"), "snapshot")
    await write(path.join(project, "opencode.json"), "{}")
    await write(path.join(project, ".opencode", "opencode.jsonc"), "{}")

    const files = await BackupSource.enumerate(roots, {
      includeToolOutput: false,
      includeSnapshots: true,
      includeProjectConfig: true,
      projectDirectories: [project],
    })
    const paths = files.map((file) => file.path)
    expect(paths).toContain("data/snapshot/p/HEAD")
    expect(paths).toContain(`projects/${Hash.fast(project)}/opencode.json`)
    expect(paths).toContain(`projects/${Hash.fast(project)}/.opencode/opencode.jsonc`)
    expect(paths).toContain("projects/index.json")

    const index = files.find((file) => file.path === "projects/index.json")
    expect(index?.content).toBeDefined()
    const parsed = JSON.parse(Buffer.from(index!.content!).toString("utf8"))
    expect(parsed.projects[Hash.fast(project)]).toBe(project)
  })
})