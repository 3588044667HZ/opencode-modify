import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SemanticWarmup"
const projectID = "proj_semantic_warmup"
const sessionID = "ses_semantic_warmup"
const title = "Semantic warmup"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

declare global {
  interface Window {
    __semanticWarmupAudio?: string[]
  }
}

test("shows indexing progress, queues prompts and drains them on ready", async ({ page }) => {
  const transport = await installSseTransport(page, { server, retry: 20 })
  await mockServer(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectAppVisible(page.getByRole("heading", { name: title }))

  const bar = page.locator('[data-component="semantic-warmup"]')
  await expect(bar).toHaveCount(0)

  await transport.send(indexing("starting", 0))
  await expect(bar).toBeVisible()
  await expect(bar).toHaveText("Analyzing project...")

  await transport.send(indexing("indexing", 0.4, "engine.ts"))
  await expect(bar).toHaveText("Analyzing project... 40% (engine.ts)")

  const prompts: string[] = []
  page.on("request", (request) => {
    if (isPromptRequest(request.method(), request.url())) prompts.push(new URL(request.url()).pathname)
  })

  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)
  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("queue during warmup")
  await input.press("Enter")

  await expect(page.getByText("1 queued message")).toBeVisible()
  expect(prompts).toEqual([])

  const drain = page.waitForRequest((request) => isPromptRequest(request.method(), request.url()))
  await transport.send(indexing("ready", 1))
  await drain
  await expect(bar).toHaveCount(0)
  await expect(page.getByText("1 queued message")).toHaveCount(0)
})

test("hides progress, rings and degrades the queue on failure", async ({ page }) => {
  const transport = await installSseTransport(page, { server, retry: 20 })
  await mockServer(page)
  await installAudioProbe(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectAppVisible(page.getByRole("heading", { name: title }))

  const bar = page.locator('[data-component="semantic-warmup"]')
  await transport.send(indexing("indexing", 0.2, "engine.ts"))
  await expect(bar).toHaveText("Analyzing project... 20% (engine.ts)")

  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)
  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("degrade me")
  await input.press("Enter")
  await expect(page.getByText("1 queued message")).toBeVisible()

  const drain = page.waitForRequest((request) => isPromptRequest(request.method(), request.url()))
  await transport.send({
    directory,
    payload: {
      id: "evt_semantic_failed",
      type: "semantic.indexing",
      properties: { status: "failed", progress: 0.2, error: "engine crashed" },
    },
  })

  await drain
  await expect(bar).toHaveCount(0)
  await expect(page.getByText("Semantic engine failed to start")).toBeVisible()
  await expect(page.getByText("engine crashed")).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__semanticWarmupAudio?.length ?? 0)).toBeGreaterThan(0)
})

function isPromptRequest(method: string, url: string) {
  if (method !== "POST") return false
  const path = new URL(url).pathname
  return path.endsWith(`/session/${sessionID}/prompt_async`) || path.endsWith(`/api/session/${sessionID}/prompt`)
}

function indexing(status: string, progress: number, current?: string) {
  return {
    directory,
    payload: {
      id: `evt_semantic_${status}_${progress}`,
      type: "semantic.indexing",
      properties: { status, progress, ...(current === undefined ? {} : { current }) },
    },
  }
}

async function installAudioProbe(page: Page) {
  await page.addInitScript(() => {
    const calls: string[] = []
    window.__semanticWarmupAudio = calls
    class ProbeAudio {
      src: string
      currentTime = 0
      constructor(src?: string) {
        this.src = src ?? ""
        calls.push(this.src)
      }
      play() {
        return Promise.resolve()
      }
      pause() {}
    }
    Object.defineProperty(window, "Audio", { configurable: true, writable: true, value: ProbeAudio })
  })
}

async function mockServer(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "semantic-warmup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "semantic-warmup",
        projectID,
        directory,
        title,
        version: "dev",
        model: { id: "claude-opus-4-6", providerID: "opencode" },
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
}
