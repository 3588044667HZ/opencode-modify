import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BackupChunk } from "@opencode-ai/core/backup/chunk"
import { tmpdir } from "../fixture/tmpdir"

describe("backup chunks", () => {
  test("streams fixed-size chunks and hashes bytes without loading the whole file", async () => {
    await using tmp = await tmpdir()
    const size = BackupChunk.CHUNK_SIZE * 2 + 321
    const bytes = Buffer.allocUnsafe(size)
    for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) & 0xff
    const file = path.join(tmp.path, "large.bin")
    await fs.writeFile(file, bytes)

    const chunks = []
    for await (const chunk of BackupChunk.readChunks(file)) chunks.push(chunk)

    expect(chunks.map((chunk) => chunk.data.byteLength)).toEqual([
      BackupChunk.CHUNK_SIZE,
      BackupChunk.CHUNK_SIZE,
      321,
    ])
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2])

    const expected: string[] = []
    for (let offset = 0; offset < size; offset += BackupChunk.CHUNK_SIZE) {
      expected.push(
        createHash("sha256")
          .update(bytes.subarray(offset, Math.min(size, offset + BackupChunk.CHUNK_SIZE)))
          .digest("hex"),
      )
    }
    expect(chunks.map((chunk) => chunk.sha256)).toEqual(expected)

    const whole = await BackupChunk.hashFile(file)
    expect(whole).toEqual({
      size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  })

  test("handles empty files", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "empty.bin")
    await fs.writeFile(file, "")
    const chunks = []
    for await (const chunk of BackupChunk.readChunks(file)) chunks.push(chunk)
    expect(chunks).toEqual([])
    expect(await BackupChunk.hashFile(file)).toEqual({
      size: 0,
      sha256: createHash("sha256").update("").digest("hex"),
    })
  })
})