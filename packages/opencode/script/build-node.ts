#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"
import pkg from "../package.json"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    // 自编译构建没有 CI 注入的版本号，兜底用 package.json 的已发布版本，
    // 避免把未发布的 0.0.0-<channel>-<时间戳> 写进 InstallationVersion，
    // 导致 .opencode 依赖安装 pin 到不存在的 @opencode-ai/plugin 版本。
    OPENCODE_VERSION: `'${process.env.OPENCODE_VERSION ?? pkg.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    OPENCODE_BUILD_ID: JSON.stringify(process.env.OPENCODE_BUILD_ID ?? "local"),
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
