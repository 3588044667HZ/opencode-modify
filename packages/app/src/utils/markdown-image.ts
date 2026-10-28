import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import type { FileContent } from "@opencode-ai/sdk/v2"

type ImageFileReader = {
  file: {
    read: (
      input: { path: string; directory?: string },
      options: { signal: AbortSignal },
    ) => Promise<{ data?: FileContent }>
  }
}

const imageTypes = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
])

export async function readLocalImage(client: ImageFileReader, path: string, signal: AbortSignal) {
  const drive = /^[a-z]:\//i.test(path)

  if (/^[\\/]{2}/.test(path) || (!drive && /^[a-z][a-z\d+.-]*:/i.test(path))) return
  const type = imageTypes.get(path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "")

  if (!type) return
  const absolute = drive || path.startsWith("/")
  const result = await client.file.read(
    absolute ? { path: getFilename(path), directory: getDirectory(path) } : { path },
    { signal },
  )
  const content = result.data

  if (!content) return

  if (content.type === "binary") {
    if (content.encoding !== "base64") return
    const bytes = Uint8Array.from(atob(content.content), (char) => char.charCodeAt(0))
    return new Blob([bytes], { type: content.mimeType ?? type })
  }

  if (type === "image/svg+xml") return new Blob([content.content], { type })
}
