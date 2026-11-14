import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { readProjectDirectories, snapshotDatabase, snapshotDatabaseAsync } from "#sqlite"
import { tmpdir } from "../fixture/tmpdir"

describe("sqlite snapshot", () => {
  test("uses VACUUM INTO and keeps the snapshot readable", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "opencode.db")
    const target = path.join(tmp.path, "snapshot", "opencode.db")

    const db = new Database(source)
    db.run("CREATE TABLE value (id INTEGER PRIMARY KEY, text TEXT)")
    db.run("INSERT INTO value (text) VALUES (?)", ["hello"])
    db.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)")
    db.run("CREATE TABLE project_directory (project_id TEXT, directory TEXT)")
    db.run("INSERT INTO project VALUES ('p1', ?)", ["C:/work/one"])
    db.run("INSERT INTO project_directory VALUES ('p1', ?)", ["C:/work/two"])
    db.close()

    snapshotDatabase({ source, target, quickCheck: true })
    expect((await fs.stat(target)).isFile()).toBe(true)

    const snapshot = new Database(target, { readonly: true })
    expect(snapshot.query("SELECT text FROM value").values()).toEqual([["hello"]])
    snapshot.close()
    expect(readProjectDirectories(target).toSorted()).toEqual(["C:/work/one", "C:/work/two"])
  })

  test("runs the snapshot in a worker so the caller event loop stays responsive", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "opencode.db")
    const target = path.join(tmp.path, "worker", "opencode.db")
    const db = new Database(source)
    db.run("CREATE TABLE value (id INTEGER PRIMARY KEY, text TEXT)")
    db.run("INSERT INTO value (text) VALUES (?)", ["worker"])
    db.close()

    let ticked = false
    const timer = setTimeout(() => {
      ticked = true
    }, 0)
    await snapshotDatabaseAsync({ source, target, quickCheck: true })
    clearTimeout(timer)
    expect(ticked).toBe(true)
    const snapshot = new Database(target, { readonly: true })
    expect(snapshot.query("SELECT text FROM value").values()).toEqual([["worker"]])
    snapshot.close()
  })

  test("cleans up partial targets after failure and refuses in-place snapshots", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "opencode.db")
    const target = path.join(tmp.path, "out.db")

    const db = new Database(source)
    db.run("CREATE TABLE value (id INTEGER PRIMARY KEY)")
    db.close()

    const broken = path.join(tmp.path, "not-a-db")
    await fs.writeFile(broken, "not sqlite")
    expect(() => snapshotDatabase({ source: broken, target })).toThrow()
    await expect(fs.access(target)).rejects.toThrow()

    expect(() => snapshotDatabase({ source, target: source })).toThrow(/differ/)
    expect((await fs.stat(source)).isFile()).toBe(true)
  })
})