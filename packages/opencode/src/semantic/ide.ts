import { execFile } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "node:url"

// App 侧 IDE 自动发现：目标机可能没有系统 JDK，因此先定位用户自己安装的
// JetBrains IDE，再用其自带 JBR 启动 semantic-server jar（launcher 随后复用同一
// IDE 启动 headless 平台）。只回答“装在哪”，不读取任何授权状态。

export type ProjectLanguage = "java" | "python" | "javascript" | "html"

export type IdeSource = "explicit" | "registry" | "toolbox" | "common"

export interface DiscoveredIde {
  readonly home: string
  readonly productCode: string
  readonly buildNumber: string
  readonly name?: string
  readonly version?: string
  readonly source: IdeSource
  readonly java: string
  readonly supports: ReadonlySet<ProjectLanguage>
}

export interface DiscoveryInput {
  readonly ide?: string
  readonly ideHome?: string
  readonly ides?: readonly DiscoveredIde[]
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}

export interface LaunchInput {
  readonly directory: string
  readonly semantic?: {
    readonly command?: readonly string[]
    readonly ide?: string
    readonly ide_home?: string
    readonly jar?: string
  }
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly ides?: readonly DiscoveredIde[]
}

export type LaunchPlan =
  | { readonly ok: true; readonly command: readonly string[]; readonly ideHome: string; readonly ide?: DiscoveredIde }
  | { readonly ok: false; readonly error: string }

const PRODUCT_SELECTORS: Readonly<Record<string, readonly string[]>> = {
  idea: ["IU", "IC"],
  pycharm: ["PY", "PC"],
  webstorm: ["WS"],
  clion: ["CL"],
  goland: ["GO"],
  phpstorm: ["PS"],
  datagrip: ["DB"],
  rider: ["RD"],
  rubymine: ["RM"],
  "android-studio": ["AI"],
}

const PREFERENCE = ["IU", "PY", "WS", "PC", "IC", "AI", "CL", "GO", "PS", "DB", "RD", "RM"]

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "node_modules",
  "build",
  "out",
  "dist",
  "target",
  "coverage",
])

const TIER1_MARKERS: Readonly<Record<Exclude<ProjectLanguage, "html">, readonly string[]>> = {
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
  python: ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "poetry.lock"],
  javascript: ["package.json", "tsconfig.json", "jsconfig.json"],
}

const JBR_JAVA = "jbr/bin/java"
const JBR_MAC_JAVA = "jbr/Contents/Home/bin/java"

let cache: { readonly key: string; readonly expires: number; readonly ides: readonly DiscoveredIde[] } | undefined

/** 测试/安装变化后清空进程内发现缓存。 */
export function clearCache() {
  cache = undefined
}

/** 发现 + 选择 IDE；显式 ide_home/路径/selector 优先，否则按项目语言与偏好序自动选择。 */
export async function discover(input: DiscoveryInput = {}): Promise<readonly DiscoveredIde[]> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const explicitHomes = explicitIdeHomes(input, env)
  const explicit = (
    await Promise.all(explicitHomes.map((home) => candidateFromHome(home, "explicit", platform)))
  ).filter((ide): ide is DiscoveredIde => ide !== undefined)

  const discovered = input.ides ?? (await discoverBase(platform, env))
  return dedupe([...explicit, ...discovered])
}

/** 解析项目语言（tier-1 构建/布局清单优先，tier-2 扩展名计数回退）。 */
export async function projectLanguages(directory: string): Promise<ReadonlySet<ProjectLanguage>> {
  const tier1 = new Set<ProjectLanguage>()
  const counts: Record<ProjectLanguage, number> = { java: 0, python: 0, javascript: 0, html: 0 }
  const rootEntries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const rootFiles = new Set(rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name))

  for (const [language, markers] of Object.entries(TIER1_MARKERS) as [
    Exclude<ProjectLanguage, "html">,
    readonly string[],
  ][]) {
    if (markers.some((marker) => rootFiles.has(marker))) tier1.add(language)
  }
  if (rootEntries.some((entry) => entry.isDirectory() && entry.name === "src")) {
    if (await isDir(path.join(directory, "src", "main", "java"))) tier1.add("java")
    if (await isDir(path.join(directory, "src", "test", "java"))) tier1.add("java")
    if (await isDir(path.join(directory, "src", "main", "kotlin"))) tier1.add("java")
  }
  if ([...rootFiles].some((name) => /^requirements.*\.txt$/i.test(name))) tier1.add("python")

  const stack: Array<{ dir: string; depth: number }> = [{ dir: directory, depth: 0 }]
  let visited = 0
  while (stack.length > 0 && visited < 5000) {
    const current = stack.pop()!
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => [])
    visited++
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (current.depth >= 4 || excluded(entry.name)) continue
        stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const language = languageOfFile(entry.name)
      if (language) counts[language]++
      if (current.depth > 0) {
        for (const [key, markers] of Object.entries(TIER1_MARKERS) as [
          Exclude<ProjectLanguage, "html">,
          readonly string[],
        ][]) {
          if (markers.includes(entry.name)) tier1.add(key)
        }
      }
    }
  }

  if (tier1.size > 0) return tier1
  const max = Math.max(counts.java, counts.python, counts.javascript, counts.html)
  if (max === 0) return new Set()
  return new Set(
    (["java", "python", "javascript", "html"] as const).filter((language) => counts[language] === max),
  )
}

/** 选择 IDE：显式路径/selector 优先；否则按项目语言覆盖率与固定偏好序。 */
export function selectIde(
  ides: readonly DiscoveredIde[],
  languages: ReadonlySet<ProjectLanguage>,
  input: { readonly ide?: string; readonly ideHome?: string } = {},
): DiscoveredIde | undefined {
  const explicitHome = firstNonEmpty(input.ideHome)
  if (explicitHome) {
    const normalized = normalizePath(explicitHome)
    return ides.find((ide) => normalizePath(ide.home) === normalized)
  }

  const selector = firstNonEmpty(input.ide)
  if (selector && selector !== "auto") {
    if (isPathLike(selector)) {
      const normalized = normalizePath(selector)
      return ides.find((ide) => normalizePath(ide.home) === normalized)
    }
    const productCodes = PRODUCT_SELECTORS[selector.toLowerCase()]
    if (productCodes) {
      const matching = ides.filter((ide) => productCodes.includes(ide.productCode))
      return newest(matching)
    }
  }

  if (languages.size === 0) return newest(ides)
  const ranked = ides
    .map((ide) => ({ ide, coverage: [...languages].filter((language) => ide.supports.has(language)).length }))
    .filter((entry) => entry.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage || rank(a.ide) - rank(b.ide) || compareBuild(b.ide, a.ide))
  return ranked[0]?.ide
}

/** 无 semantic.command 时：IDE JBR + jar 自动组成启动命令；不依赖系统 JDK。 */
export async function resolveLaunch(input: LaunchInput): Promise<LaunchPlan> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const configured = input.semantic?.command ?? []
  if (configured.length > 0) {
    return {
      ok: true,
      command: configured,
      ideHome: firstNonEmpty(input.semantic?.ide_home) ?? "",
    }
  }

  const jar = await resolveJar(input.directory, input.semantic?.jar, env, platform)
  if (!jar) {
    return {
      ok: false,
      error:
        "semantic-server.jar not found; set semantic.jar or semantic.command (looked in resources/semantic-server and semantic-server/build-local)",
    }
  }

  const languages = await projectLanguages(input.directory)
  const ides = input.ides ?? (await discover({ ...input, env, platform }))
  const selected = selectIde(ides, languages, {
    ide: input.semantic?.ide,
    ideHome: input.semantic?.ide_home ?? env.SEMANTIC_IDE_HOME ?? env.IDEA_HOME ?? env.IDEA_DIR,
  })
  if (!selected) {
    return { ok: false, error: selectionError(languages, ides, input.semantic) }
  }
  return {
    ok: true,
    command: [selected.java, "-Djava.awt.headless=true", "-jar", jar],
    ideHome: selected.home,
    ide: selected,
  }
}

export async function resolveJar(
  directory: string,
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const explicit = firstNonEmpty(configured) ?? firstNonEmpty(env.OPENCODE_SEMANTIC_JAR) ?? firstNonEmpty(env.SEMANTIC_JAR)
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(directory, explicit)
    if (await isFile(resolved)) return resolved
  }

  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resources === undefined ? undefined : path.join(resources, "semantic-server", "semantic-server.jar"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../semantic-server/build-local/semantic-server.jar"),
    path.resolve(directory, "semantic-server", "build-local", "semantic-server.jar"),
  ]
  for (const candidate of candidates) {
    if (candidate && (await isFile(candidate))) return candidate
  }
  return undefined
}

function explicitIdeHomes(input: DiscoveryInput, env: NodeJS.ProcessEnv): string[] {
  const values = [input.ideHome, input.ide, env.SEMANTIC_IDE_HOME, env.IDEA_HOME, env.IDEA_DIR]
  return values
    .map(firstNonEmpty)
    .filter((value): value is string => value !== undefined && value !== "auto" && isPathLike(value))
}

async function discoverBase(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<readonly DiscoveredIde[]> {
  const key = `${platform}:${env.LOCALAPPDATA ?? ""}:${env.ProgramFiles ?? ""}:${env.HOME ?? ""}`
  if (cache?.key === key && cache.expires > Date.now()) return cache.ides

  const homes = new Map<string, IdeSource>()
  for (const home of await registryHomes(platform, env)) homes.set(home, "registry")
  for (const base of scanBases(platform, env)) {
    const source: IdeSource = /[\\/]Toolbox[\\/]apps[\\/]?$/i.test(base) ? "toolbox" : "common"
    for (const home of await scanForProductInfo(base, platform === "win32" ? 4 : 3)) {
      if (!homes.has(home)) homes.set(home, source)
    }
  }
  const ides = dedupe(
    (await Promise.all([...homes].map(([home, source]) => candidateFromHome(home, source, platform)))).filter(
      (ide): ide is DiscoveredIde => ide !== undefined,
    ),
  )
  cache = { key, expires: Date.now() + 60_000, ides }
  return ides
}

async function registryHomes(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  if (platform !== "win32") return []
  const powershell = await powershellRegistryHomes(env)
  if (powershell.length > 0) return powershell
  return regRegistryHomes(env)
}

async function powershellRegistryHomes(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$paths=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$items=@(Get-ItemProperty -Path $paths | Where-Object { $_.DisplayName -match 'JetBrains|IntelliJ IDEA|PyCharm|WebStorm|CLion|GoLand|DataGrip|PhpStorm|RubyMine|Rider|Android Studio' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation)",
    "ConvertTo-Json -Compress -InputObject $items",
  ].join("; ")
  const output = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], env)
  if (typeof output !== "string" || !output) return []
  const parsed = parseJson(output)
  if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string")
  return typeof parsed === "string" ? [parsed] : []
}

async function regRegistryHomes(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const homes: string[] = []
  for (const hive of ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
    const output = await exec("reg.exe", ["query", hive, "/s"], env, "buffer")
    if (!output) continue
    let display = ""
    let install = ""
    for (const raw of decode(output).split(/\r?\n/)) {
      const line = raw.trim()
      if (/^DisplayName\s+REG_SZ\s+/i.test(line)) display = line.replace(/^DisplayName\s+REG_SZ\s+/i, "")
      else if (/^InstallLocation\s+REG_SZ\s+/i.test(line)) install = line.replace(/^InstallLocation\s+REG_SZ\s+/i, "")
      if (!display || !install) continue
      if (/JetBrains|IntelliJ IDEA|PyCharm|WebStorm|CLion|GoLand|DataGrip|PhpStorm|RubyMine|Rider|Android Studio/i.test(display)) {
        homes.push(install)
      }
      display = ""
      install = ""
    }
  }
  return homes
}

function scanBases(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): readonly string[] {
  const home = os.homedir()
  if (platform === "win32") {
    const programFilesX86 = env["ProgramFiles(x86)"]
    return unique([
      env.ProgramFiles && path.join(env.ProgramFiles, "JetBrains"),
      env.ProgramW6432 && path.join(env.ProgramW6432, "JetBrains"),
      programFilesX86 && path.join(programFilesX86, "JetBrains"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "JetBrains"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "JetBrains", "Toolbox", "apps"),
    ])
  }
  if (platform === "darwin") {
    return unique([
      "/Applications",
      path.join(home, "Applications"),
      path.join(home, "Library", "Application Support", "JetBrains", "Toolbox", "apps"),
    ])
  }
  return unique(["/opt", path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps")])
}

async function scanForProductInfo(root: string, maxDepth: number): Promise<readonly string[]> {
  const out: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 600) {
    const current = queue.shift()!
    visited++
    const base = current.dir.endsWith(".app") ? path.join(current.dir, "Contents") : current.dir
    if (await isFile(path.join(base, "product-info.json"))) {
      out.push(base)
      continue
    }
    if (current.depth >= maxDepth) continue
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded(entry.name)) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return out
}

async function candidateFromHome(
  home: string,
  source: IdeSource,
  platform: NodeJS.Platform,
): Promise<DiscoveredIde | undefined> {
  const base = home.endsWith(".app") ? path.join(home, "Contents") : home
  if (!(await isDir(path.join(base, "lib")))) return undefined
  const info = await readJson(path.join(base, "product-info.json"))
  if (!info || typeof info.productCode !== "string" || typeof info.buildNumber !== "string") return undefined
  const java = await findJbrJava(base, platform)
  if (!java) return undefined
  const supports = await supportedLanguages(base, info.productCode)
  return {
    home: base,
    productCode: info.productCode,
    buildNumber: info.buildNumber,
    ...(typeof info.name === "string" ? { name: info.name } : {}),
    ...(typeof info.version === "string" ? { version: info.version } : {}),
    source,
    java,
    supports,
  }
}

async function findJbrJava(home: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const candidates =
    platform === "darwin"
      ? [path.join(home, ...JBR_MAC_JAVA.split("/")), path.join(home, ...JBR_JAVA.split("/"))]
      : [path.join(home, ...JBR_JAVA.split("/")), path.join(home, ...JBR_MAC_JAVA.split("/"))]
  for (const candidate of candidates) {
    const file = platform === "win32" ? `${candidate}.exe` : candidate
    if (await isExecutable(file)) return file
  }
  return undefined
}

async function supportedLanguages(home: string, productCode: string): Promise<ReadonlySet<ProjectLanguage>> {
  const supports = new Set<ProjectLanguage>()
  if (productCode === "IU" || productCode === "IC" || productCode === "AI") supports.add("java")
  if (productCode === "PY" || productCode === "PC") supports.add("python")
  if (productCode === "IU" || productCode === "WS" || productCode === "PY" || productCode === "PC") supports.add("javascript")
  if (await isDir(path.join(home, "plugins", "java"))) supports.add("java")
  if (await isDir(path.join(home, "plugins", "python"))) supports.add("python")
  if (await isDir(path.join(home, "plugins", "javascript-plugin"))) supports.add("javascript")
  if (await isDir(path.join(home, "plugins", "html-tools"))) supports.add("html")
  return supports
}

function selectionError(
  languages: ReadonlySet<ProjectLanguage>,
  ides: readonly DiscoveredIde[],
  semantic: LaunchInput["semantic"],
): string {
  if (ides.length === 0) {
    return "no JetBrains IDE found (checked explicit config, uninstall registry, Toolbox and common paths); install one or set semantic.ide_home"
  }
  const requested = firstNonEmpty(semantic?.ide)
  if (requested && requested !== "auto") {
    return `requested semantic.ide "${requested}" was not found; available: ${describe(ides)}`
  }
  return `no installed JetBrains IDE supports project languages [${[...languages].join(", ")}]; available: ${describe(ides)}; set semantic.ide_home to choose one`
}

function describe(ides: readonly DiscoveredIde[]): string {
  return ides.map((ide) => `${ide.productCode} ${ide.buildNumber} (${ide.home})`).join(", ")
}

function excluded(name: string): boolean {
  return EXCLUDED_DIRS.has(name.toLowerCase()) || name.startsWith(".")
}

function languageOfFile(name: string): ProjectLanguage | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".kts")) return "java"
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python"
  if (/\.(m?[jt]sx?|cjs)$/.test(lower)) return "javascript"
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html"
  return undefined
}

function rank(ide: DiscoveredIde): number {
  const index = PREFERENCE.indexOf(ide.productCode)
  return index < 0 ? PREFERENCE.length : index
}

function newest<T extends DiscoveredIde>(ides: readonly T[]): T | undefined {
  return [...ides].sort((a, b) => rank(a) - rank(b) || compareBuild(b, a))[0]
}

function compareBuild(a: DiscoveredIde, b: DiscoveredIde): number {
  const left = a.buildNumber.split(/[^0-9]+/).filter(Boolean).map(Number)
  const right = b.buildNumber.split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function dedupe(ides: readonly DiscoveredIde[]): readonly DiscoveredIde[] {
  const seen = new Set<string>()
  const out: DiscoveredIde[] = []
  for (const ide of ides) {
    const key = normalizePath(ide.home)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ide)
  }
  return out.sort((a, b) => rank(a) - rank(b) || compareBuild(b, a))
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value.replace(/\\/g, "/"))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\")
}

function firstNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function unique(values: Array<string | undefined | false>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))]
}

function decode(value: Buffer | string): string {
  return typeof value === "string" ? value : new TextDecoder("utf-8").decode(value)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value.replace(/^\uFEFF/, "").trim())
  } catch {
    return undefined
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const value = parseJson(text)
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile(), () => false)
}

async function isDir(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isDirectory(), () => false)
}

async function isExecutable(file: string): Promise<boolean> {
  const ok = await fs.access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(
    () => true,
    () => false,
  )
  return ok && isFile(file)
}

function exec(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  encoding: "utf8" | "buffer" = "utf8",
): Promise<string | Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding,
        env,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    )
  })
}

export * as Ide from "./ide"
