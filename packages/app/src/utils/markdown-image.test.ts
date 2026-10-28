import { expect, test } from "bun:test"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { readLocalImage } from "./markdown-image"

function setup(content: FileContent) {
  const reads: Array<{ path: string; directory?: string }> = []
  const client = {
    file: {
      read(input: { path: string; directory?: string }) {
        reads.push(input)
        return Promise.resolve({ data: content })
      },
    },
  }
  return { reads, client, signal: new AbortController().signal }
}

const binary = (content: string, mimeType: string): FileContent => ({
  type: "binary",
  content,
  encoding: "base64",
  mimeType,
})

test("reads a relative image from the scoped directory", async () => {
  const { reads, client, signal } = setup(binary(Buffer.from([0, 127, 255]).toString("base64"), "image/png"))
  const blob = await readLocalImage(client, "images/chart.png", signal)

  expect(reads).toEqual([{ path: "images/chart.png" }])
  expect(blob?.type).toBe("image/png")
  expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([0, 127, 255]))
})

test.each([
  ["C:/tmp/chart.png", "chart.png", "C:/tmp/"],
  ["/tmp/chart.png", "chart.png", "/tmp/"],
])("reads absolute image %s from its parent directory", async (path, file, directory) => {
  const { reads, client, signal } = setup(binary("", "image/png"))
  await readLocalImage(client, path, signal)

  expect(reads).toEqual([{ path: file, directory }])
})

test("reads svg text content", async () => {
  const { client, signal } = setup({ type: "text", content: "<svg></svg>" })
  const blob = await readLocalImage(client, "chart.svg", signal)

  expect(blob?.type).toBe("image/svg+xml")
  expect(await blob?.text()).toBe("<svg></svg>")
})

test.each(["https://example.com/chart.png", "//example.com/chart.png", "chart.txt", "chart"])(
  "does not read %s",
  async (path) => {
    const { reads, client, signal } = setup(binary("", "image/png"))
    expect(await readLocalImage(client, path, signal)).toBeUndefined()
    expect(reads).toEqual([])
  },
)
