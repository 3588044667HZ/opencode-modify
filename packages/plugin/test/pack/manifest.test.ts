import { describe, expect, test } from "bun:test"
import { parsePackManifest } from "../../src/pack/manifest"

describe("pack manifest", () => {
  test("parses contributions", () => {
    const manifest = parsePackManifest({
      id: "review",
      version: "1.0.0",
      entry: "index.js",
      contributes: {
        tools: [{ id: "review.diff", description: "Review a diff" }],
        agents: [{ id: "reviewer", prompt: "You review code." }],
        prompts: [{ id: "review.style", content: "Be precise." }],
        rpc: [{ id: "review.status", method: "review.status" }],
        ui: [{ id: "review.settings", slot: "settings.section", entry: "ui.js" }],
      },
    })

    expect(manifest.id).toBe("review")
    expect(manifest.contributes?.tools?.[0]?.id).toBe("review.diff")
  })

  test("rejects duplicate ids within the same contribution kind", () => {
    expect(() =>
      parsePackManifest({
        id: "review",
        version: "1.0.0",
        entry: "index.js",
        contributes: {
          tools: [
            { id: "review.diff", description: "a" },
            { id: "review.diff", description: "b" },
          ],
        },
      }),
    ).toThrow("Duplicate tool contribution")
  })

  test("rejects unsafe pack ids", () => {
    expect(() => parsePackManifest({ id: "../escape", version: "1" })).toThrow()
  })
})

test("requires a runtime for tools and rpc", () => {
  expect(() =>
    parsePackManifest({
      id: "review",
      version: "1.0.0",
      contributes: { tools: [{ id: "review.diff", description: "a" }] },
    }),
  ).toThrow("require an entry or command")
})
