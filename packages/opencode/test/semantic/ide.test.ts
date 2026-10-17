import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { Ide, type DiscoveredIde, type ProjectLanguage } from "@/semantic/ide"

const fakeIde = (
  productCode: string,
  buildNumber: string,
  supports: readonly ProjectLanguage[],
): DiscoveredIde => ({
  home: path.join("C:/fake", productCode),
  productCode,
  buildNumber,
  source: "common",
  java: path.join("C:/fake", productCode, "jbr/bin/java.exe"),
  supports: new Set(supports),
})

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-ide-"))
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = await tempDir()
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  return dir
}

async function fakeIdeHome(productCode: string): Promise<string> {
  const home = await tempDir()
  await fs.mkdir(path.join(home, "lib"), { recursive: true })
  await fs.mkdir(path.join(home, "jbr", "bin"), { recursive: true })
  await fs.writeFile(
    path.join(home, "product-info.json"),
    JSON.stringify({ name: "Fake IDE", version: "2026.2", productCode, buildNumber: "262.1234.5" }),
  )
  const java = path.join(home, "jbr", "bin", process.platform === "win32" ? "java.exe" : "java")
  await fs.writeFile(java, "")
  if (process.platform !== "win32") await fs.chmod(java, 0o755)
  return home
}

describe("semantic ide discovery", () => {
  it("validates an explicit IDE home and resolves its JBR", async () => {
    const home = await fakeIdeHome("IU")
    const ides = await Ide.discover({ ideHome: home, ides: [], platform: process.platform })
    expect(ides).toHaveLength(1)
    expect(ides[0]?.productCode).toBe("IU")
    expect(ides[0]?.home).toBe(home)
    expect(ides[0]?.java.toLowerCase()).toContain("jbr")
    expect(ides[0]?.supports.has("java")).toBe(true)
    expect(ides[0]?.supports.has("javascript")).toBe(true)
  })

  it("rejects a home without product-info/lib/JBR", async () => {
    const home = await tempDir()
    const ides = await Ide.discover({ ideHome: home, ides: [], platform: process.platform })
    expect(ides).toHaveLength(0)
  })
})

describe("semantic project languages", () => {
  it("treats build/layout markers as tier-1 and ignores incidental Python tests", async () => {
    const dir = await project({
      "pom.xml": "<project />",
      "src/main/java/demo/A.java": "class A {}",
      "tests/test_sample.py": "def test_a(): pass",
    })
    expect(await Ide.projectLanguages(dir)).toEqual(new Set(["java"]))
  })

  it("detects Python from a pyproject marker", async () => {
    const dir = await project({ "pyproject.toml": "[project]", "test_main.py": "pass" })
    expect(await Ide.projectLanguages(dir)).toEqual(new Set(["python"]))
  })

  it("detects JavaScript/TypeScript from package.json", async () => {
    const dir = await project({ "package.json": "{}", "src/index.ts": "export {}" })
    expect(await Ide.projectLanguages(dir)).toEqual(new Set(["javascript"]))
  })

  it("falls back to extension counts for bare projects", async () => {
    const dir = await project({ "main.py": "print(1)", "util.py": "x = 1" })
    expect(await Ide.projectLanguages(dir)).toEqual(new Set(["python"]))
  })
})

describe("semantic ide selection", () => {
  const idea = fakeIde("IU", "262.1", ["java", "javascript", "html"])
  const pycharm = fakeIde("PY", "262.2", ["python", "javascript", "html"])
  const webstorm = fakeIde("WS", "262.3", ["javascript", "html"])

  it("prefers IDEA Ultimate for Java projects", () => {
    expect(Ide.selectIde([pycharm, webstorm, idea], new Set(["java"]))).toBe(idea)
  })

  it("prefers PyCharm for Python projects", () => {
    expect(Ide.selectIde([webstorm, idea, pycharm], new Set(["python"]))).toBe(pycharm)
  })

  it("prefers IDEA Ultimate over WebStorm for JS/TS", () => {
    expect(Ide.selectIde([webstorm, idea], new Set(["javascript"]))).toBe(idea)
  })

  it("honors an explicit selector", () => {
    expect(Ide.selectIde([idea, webstorm], new Set(["javascript"]), { ide: "webstorm" })).toBe(webstorm)
  })

  it("honors an explicit ide_home path", () => {
    expect(Ide.selectIde([idea, webstorm], new Set(), { ideHome: webstorm.home })).toBe(webstorm)
  })

  it("returns undefined when no IDE supports the project languages", () => {
    expect(Ide.selectIde([webstorm], new Set(["java"]))).toBeUndefined()
  })
})

describe("semantic launch planning", () => {
  it("builds a JBR + jar command without a configured command", async () => {
    const dir = await project({ "package.json": "{}" })
    const jar = path.join(await tempDir(), "semantic-server.jar")
    await fs.writeFile(jar, "")
    const idea = fakeIde("IU", "262.1", ["java", "javascript"])
    const plan = await Ide.resolveLaunch({
      directory: dir,
      semantic: { jar },
      ides: [idea],
      platform: process.platform,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.command).toEqual([idea.java, "-Djava.awt.headless=true", "-jar", jar])
    expect(plan.ideHome).toBe(idea.home)
  })

  it("uses semantic.ide selector when planning", async () => {
    const dir = await project({ "package.json": "{}" })
    const jar = path.join(await tempDir(), "semantic-server.jar")
    await fs.writeFile(jar, "")
    const idea = fakeIde("IU", "262.1", ["javascript"])
    const webstorm = fakeIde("WS", "262.3", ["javascript"])
    const plan = await Ide.resolveLaunch({
      directory: dir,
      semantic: { jar, ide: "webstorm" },
      ides: [idea, webstorm],
      platform: process.platform,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.ideHome).toBe(webstorm.home)
  })

  it("returns a clear error when the explicit IDE home is missing", async () => {
    const dir = await project({ "package.json": "{}" })
    const jar = path.join(await tempDir(), "semantic-server.jar")
    await fs.writeFile(jar, "")
    const idea = fakeIde("IU", "262.1", ["javascript"])
    const plan = await Ide.resolveLaunch({
      directory: dir,
      semantic: { jar, ide_home: path.join(os.tmpdir(), "opencode-missing-ide") },
      ides: [idea],
      platform: process.platform,
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain("IDE")
  })
})
