export * as BackupChunk from "./chunk"

import { createHash } from "crypto"
import { open } from "fs/promises"

export const CHUNK_SIZE = 1024 * 1024

export interface Chunk {
  readonly index: number
  readonly data: Uint8Array
  readonly sha256: string
}

export function hashBytes(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

export async function* readChunks(file: string, chunkSize = CHUNK_SIZE): AsyncGenerator<Chunk> {
  const handle = await open(file, "r")
  try {
    let index = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(chunkSize)
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, index * chunkSize)
      if (bytesRead === 0) return
      const data = buffer.subarray(0, bytesRead)
      yield { index, data, sha256: hashBytes(data) }
      index += 1
    }
  } finally {
    await handle.close()
  }
}

export async function hashFile(file: string, chunkSize = CHUNK_SIZE) {
  const handle = await open(file, "r")
  const hash = createHash("sha256")
  let size = 0
  try {
    let index = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(chunkSize)
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, index * chunkSize)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      size += bytesRead
      index += 1
    }
  } finally {
    await handle.close()
  }
  return { size, sha256: hash.digest("hex") }
}