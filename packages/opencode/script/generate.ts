import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
const cachePath =
  process.env.OPENCODE_MODELS_PATH ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".cache", "opencode", "models.json")

async function readModelsSnapshot() {
  if (process.env.MODELS_DEV_API_JSON) {
    return await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  }

  try {
    const response = await fetch(`${modelsUrl}/api.json`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } catch (error) {
    console.warn(`models.dev fetch failed (${error instanceof Error ? error.message : String(error)}); using local cache`)
  }

  try {
    const cached = await Bun.file(cachePath).text()
    if (cached.trim()) return cached
  } catch {
    // fall through to an empty snapshot
  }

  console.warn(`no models.dev cache at ${cachePath}; building with an empty snapshot`)
  return "{}"
}

export const modelsData = await readModelsSnapshot()
console.log("Loaded models.dev snapshot")
