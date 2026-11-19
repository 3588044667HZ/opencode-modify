#!/usr/bin/env bun
// 构建语义引擎 jar，并尽量激活到 semantic-server.jar。
// 目标 jar 被运行中的语义守护占用时，保留 semantic-server.next.jar；
// 打包配置会选择最新的 jar，因此安装包仍能拿到新引擎。
import { $ } from "bun"
import { existsSync } from "node:fs"
import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const dir = path.join(root, "semantic-server", "build-local")
const target = path.join(dir, "semantic-server.jar")
const next = path.join(dir, "semantic-server.next.jar")
const args = new Set(process.argv.slice(2))
const required = args.has("--require")

if (args.has("--skip") || process.env.OPENCODE_SKIP_SEMANTIC === "1") {
  console.log("semantic: skipped")
  process.exit(0)
}

const bashCandidates = [
  process.env.OPENCODE_BASH,
  Bun.which("bash"),
  process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : undefined,
  process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : undefined,
]
const bash = bashCandidates.find((candidate): candidate is string => !!candidate && existsSync(candidate))
if (!bash) {
  const message = "semantic: bash not found; set OPENCODE_BASH or install Git Bash"
  if (required) throw new Error(message)
  console.warn(message)
  process.exit(0)
}
const bashEnv = { ...process.env }
if (process.platform === "win32" && /[\\/]Git[\\/]/i.test(bash)) {
  const gitRoot = path.dirname(path.dirname(bash))
  bashEnv.PATH = [path.join(gitRoot, "bin"), path.join(gitRoot, "usr", "bin"), bashEnv.PATH ?? ""]
    .filter(Boolean)
    .join(";")
}

await mkdir(dir, { recursive: true })
console.log("semantic: building semantic-server.jar")

try {
  await $`${bash} semantic-server/script/build-local.sh`.cwd(root).env({
    ...bashEnv,
    SEMANTIC_OUTPUT_JAR: next,
  })
} catch (error) {
  const message = `semantic: build failed: ${error instanceof Error ? error.message : String(error)}`
  if (required) throw new Error(message)
  console.warn(`${message}; continuing without updating the semantic jar`)
  process.exit(0)
}

try {
  await copyFile(next, target)
  await rm(next, { force: true })
  console.log("semantic: jar activated")
} catch {
  console.warn("semantic: jar is in use; kept semantic-server.next.jar (packaging will use the newest jar)")
}
