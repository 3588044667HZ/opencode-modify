#!/usr/bin/env bun
// 生成 Java 大型调用图基准项目：40 个真实 caller + 40 个同名 run() 干扰类 + 1 个测试。
// 用法: bun script/generate-java-bench.ts <output-dir>
import fs from "node:fs/promises"
import path from "node:path"

const out = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../.tmp/java-large-project"))
await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(path.join(out, "src/main/java/bench"), { recursive: true })
await fs.mkdir(path.join(out, "src/test/java/bench"), { recursive: true })

const write = async (relative: string, content: string) => {
  const file = path.join(out, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

await write(
  "src/main/java/bench/Engine.java",
  ["package bench;", "", "public class Engine {", '    public String run(String name) {', "        return format(name);", "    }", "", "    private String format(String name) {", '        return "[" + name + "]";', "    }", "}", ""].join("\n"),
)

for (let index = 1; index <= 40; index++) {
  const id = String(index).padStart(3, "0")
  await write(
    `src/main/java/bench/Caller${id}.java`,
    [
      "package bench;",
      "",
      `public class Caller${id} {`,
      `    void call(Engine e${id}) {`,
      `        e${id}.run("${id}");`,
      "    }",
      "}",
      "",
    ].join("\n"),
  )
  await write(
    `src/main/java/bench/Decoy${id}.java`,
    [
      "package bench;",
      "",
      `public class Decoy${id} {`,
      "    void run() {}",
      "",
      `    void call(Decoy${id} d${id}) {`,
      `        d${id}.run();`,
      "    }",
      "}",
      "",
    ].join("\n"),
  )
}

await write(
  "src/test/java/bench/EngineTest.java",
  [
    "package bench;",
    "",
    "public class EngineTest {",
    "    void testRun() {",
    '        new Engine().run("test");',
    "    }",
    "}",
    "",
  ].join("\n"),
)
console.log(out)
