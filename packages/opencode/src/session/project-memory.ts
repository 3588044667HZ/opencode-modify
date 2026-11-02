import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

type Command = { label: string; command: string }

type Facts = {
  name: string
  languages: string[]
  layout: string[]
  commands: Command[]
  tooling: string[]
  docs: string[]
}

const ignoredDirectories = new Set([
  ".git",
  ".opencode",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
])

export const ensureProjectMemory = Effect.fn("ProjectMemory.ensure")(function* (
  directory: string,
  fs: FSUtil.Interface,
) {
  if (process.env.OPENCODE_DISABLE_PROJECT_MEMORY === "1") return
  const target = path.join(directory, ".opencode", "memory.md")
  if (yield* fs.existsSafe(target)) return

  // Do not create a competing instruction file when the project already has one.
  for (const file of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    if (yield* fs.existsSafe(path.join(directory, file))) return
  }

  const facts = yield* readFacts(directory, fs)
  yield* fs.writeWithDirs(target, render(facts))
})

function readFacts(directory: string, fs: FSUtil.Interface): Effect.Effect<Facts> {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
    const names = new Set(entries.map((entry) => entry.name))
    const read = (name: string) =>
      fs.readFileStringSafe(path.join(directory, name)).pipe(Effect.orElseSucceed(() => undefined))

    const packageText = yield* read("package.json")
    const packageJson = parseJson(packageText)
    const packageManager = (() => {
      if (names.has("bun.lock") || names.has("bun.lockb")) return "bun"
      if (names.has("pnpm-lock.yaml")) return "pnpm"
      if (names.has("yarn.lock")) return "yarn"
      if (names.has("package-lock.json")) return "npm"
      return packageJson ? "npm" : undefined
    })()
    const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {}
    const scriptNames = ["dev", "build", "test", "lint", "typecheck", "format"]
    const tooling = [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "vite.config.js",
      "next.config.ts",
      "next.config.js",
      "turbo.json",
      "pyproject.toml",
      "requirements.txt",
      "Cargo.toml",
      "go.mod",
      "Makefile",
      "justfile",
      ".editorconfig",
      "eslint.config.js",
      "eslint.config.ts",
      "biome.json",
      "ruff.toml",
      "pytest.ini",
      ".prettierrc",
      ".prettierrc.json",
    ].filter((file) => names.has(file))
    const docs = ["README.md", "README", "CONTRIBUTING.md", "CONTRIBUTING"].filter((file) => names.has(file))
    const languages: string[] = []
    if (packageJson || names.has("tsconfig.json")) languages.push("TypeScript/JavaScript")
    if (names.has("pyproject.toml") || names.has("requirements.txt")) languages.push("Python")
    if (names.has("Cargo.toml")) languages.push("Rust")
    if (names.has("go.mod")) languages.push("Go")
    if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts"))
      languages.push("Java/Kotlin")

    const commands: Command[] = []
    if (packageJson) {
      if (packageManager) commands.push({ label: "Install", command: `${packageManager} install` })
      for (const script of scriptNames) {
        if (!isRecord(scripts) || typeof scripts[script] !== "string") continue
        commands.push({ label: labelFor(script), command: `${packageManager ?? "npm"} run ${script}` })
      }
    }
    if (names.has("pyproject.toml") || names.has("requirements.txt")) {
      const pyproject = yield* read("pyproject.toml")
      if (names.has("pytest.ini") || pyproject?.includes("[tool.pytest")) {
        commands.push({ label: "Test", command: "pytest" })
      }
      if (names.has("ruff.toml") || pyproject?.includes("[tool.ruff")) {
        commands.push({ label: "Lint", command: "ruff check ." })
      }
      if (pyproject?.includes("[tool.mypy")) commands.push({ label: "Typecheck", command: "mypy ." })
    }
    if (names.has("Cargo.toml")) {
      commands.push(
        { label: "Build", command: "cargo build" },
        { label: "Test", command: "cargo test" },
        { label: "Lint", command: "cargo clippy --all-targets" },
        { label: "Format", command: "cargo fmt" },
      )
    }
    if (names.has("go.mod")) {
      commands.push({ label: "Build", command: "go build ./..." }, { label: "Test", command: "go test ./..." })
    }
    if (names.has("Makefile")) {
      const makefile = yield* read("Makefile")
      const targets = new Set(
        (makefile ?? "").split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^([A-Za-z0-9_.-]+):(?!=)/)
          return match ? [match[1]!] : []
        }),
      )
      for (const target of ["build", "test", "lint", "check", "format"]) {
        if (targets.has(target)) commands.push({ label: labelFor(target), command: `make ${target}` })
      }
    }

    return {
      name: path.basename(directory),
      languages: languages.length > 0 ? languages : ["Unknown"],
      layout: entries
        .filter(
          (entry) => entry.type === "directory" && !ignoredDirectories.has(entry.name) && !entry.name.startsWith("."),
        )
        .map((entry) => entry.name)
        .toSorted()
        .slice(0, 12),
      commands: uniqueCommands(commands),
      tooling,
      docs,
    }
  })
}

function render(facts: Facts) {
  const lines = [
    "# Project Memory",
    "",
    `<!-- Generated by OpenCode on ${new Date().toISOString()} from repository metadata. Edit freely; OpenCode will not overwrite this file. -->`,
    "",
    "## Overview",
    "",
    `- Name: \`${facts.name}\``,
    `- Languages: ${facts.languages.join(", ")}`,
  ]
  if (facts.docs.length > 0) lines.push(`- Docs: ${facts.docs.map((item) => `\`${item}\``).join(", ")}`)

  lines.push("", "## Commands", "")
  if (facts.commands.length === 0)
    lines.push("- No standard commands recognized; inspect project manifests before running commands.")
  else for (const item of facts.commands) lines.push(`- ${item.label}: \`${item.command}\``)

  if (facts.layout.length > 0) {
    lines.push("", "## Layout", "")
    for (const directory of facts.layout) lines.push(`- \`${directory}/\``)
  }

  if (facts.tooling.length > 0) {
    lines.push("", "## Tooling", "")
    lines.push(`- ${facts.tooling.map((item) => `\`${item}\``).join(", ")}`)
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- This is a deterministic baseline generated without reading source files.",
    "- Prefer project manifests and existing docs over guesses; update this file when commands or structure change.",
    "- Run the `/init` command for an AI-assisted, deeper AGENTS.md.",
    "",
  )
  return lines.join("\n")
}

function parseJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function labelFor(script: string) {
  if (script === "dev") return "Dev"
  if (script === "build") return "Build"
  if (script === "test") return "Test"
  if (script === "lint") return "Lint"
  if (script === "typecheck") return "Typecheck"
  if (script === "format") return "Format"
  if (script === "check") return "Check"
  return script
}

function uniqueCommands(commands: Command[]) {
  const seen = new Set<string>()
  return commands.filter((item) => {
    if (seen.has(item.command)) return false
    seen.add(item.command)
    return true
  })
}
