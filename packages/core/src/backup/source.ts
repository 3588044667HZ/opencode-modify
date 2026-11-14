export * as BackupSource from "./source"

import path from "path"
import { lstat, readdir, realpath } from "fs/promises"
import { Hash } from "../util/hash"
import { BackupManifest } from "./manifest"

export interface Roots {
  readonly data: string
  readonly config: string
  readonly state: string
  readonly cache: string
}

export interface Options {
  readonly includeToolOutput: boolean
  readonly includeSnapshots: boolean
  readonly includeProjectConfig: boolean
  readonly projectDirectories?: readonly string[]
}

export interface SourceFile {
  readonly path: string
  readonly absolute?: string
  readonly content?: Uint8Array
}

const CONFIG_FILES = ["opencode.json", "opencode.jsonc", "config.json", "tui.json", "tui.jsonc"]
const PROJECT_FILES = [
  "opencode.json",
  "opencode.jsonc",
  path.join(".opencode", "opencode.json"),
  path.join(".opencode", "opencode.jsonc"),
]

export async function enumerate(roots: Roots, options: Options): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const excluded = await Promise.all([roots.state, roots.cache].map((directory) => realpath(directory).catch(() => directory)))
  const dataRoot = await realpath(roots.data).catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  })

  await addIfFile(files, roots.data, "auth.json", "data/auth.json")
  await addIfFile(files, roots.data, "mcp-auth.json", "data/mcp-auth.json")

  if (options.includeToolOutput) {
    await walk(path.join(roots.data, "tool-output"), "data/tool-output", files, excluded, dataRoot)
  }
  if (options.includeSnapshots) {
    await walk(path.join(roots.data, "snapshot"), "data/snapshot", files, excluded, dataRoot)
  }

  for (const name of CONFIG_FILES) {
    await addIfFile(files, roots.config, name, `config/${name}`)
  }

  if (options.includeProjectConfig) {
    const projects = [...new Set(options.projectDirectories ?? [])].toSorted()
    for (const directory of projects) {
      const hash = Hash.fast(directory)
      for (const name of PROJECT_FILES) {
        await addIfFile(files, directory, name, `projects/${hash}/${toPosix(name)}`)
      }
    }
    if (projects.length) {
      const index = Object.fromEntries(projects.map((directory) => [Hash.fast(directory), directory]))
      files.push({
        path: "projects/index.json",
        content: Buffer.from(JSON.stringify({ version: 1, projects: index }, null, 2) + "\n", "utf8"),
      })
    }
  }

  BackupManifest.assertUnique(files)
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function addIfFile(files: SourceFile[], root: string, relative: string, logical: string) {
  const absolute = path.join(root, relative)
  const info = await lstat(absolute).catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  })
  if (!info?.isFile()) return
  files.push({ path: logical, absolute })
}

async function walk(
  root: string,
  logical: string,
  files: SourceFile[],
  excluded: readonly string[],
  allowedRoot: string | undefined,
) {
  if (!allowedRoot) return
  const real = await realpath(root).catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  })
  if (!real || !isInside(allowedRoot, real)) return
  if (excluded.some((directory) => isInside(directory, real))) return
  const entries = await readdir(real, { withFileTypes: true }).catch((error: unknown) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return []
    throw error
  })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(real, entry.name)
    const child = `${logical}/${entry.name}`
    if (entry.isDirectory()) {
      await walk(absolute, child, files, excluded, allowedRoot)
      continue
    }
    if (entry.isFile()) files.push({ path: child, absolute })
  }
}

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function toPosix(value: string) {
  return value.replaceAll("\\", "/")
}