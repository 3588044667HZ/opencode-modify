import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

const directory = "C:/OpenCode/AgentTeamsPoll"
const projectID = "proj_agent_teams_poll"
const parentID = "ses_team_parent"
const parentTitle = "Team parent session"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

type ChildFixture = {
  id: string
  title: string
  agent: string
  busy: boolean
  activity: "thinking" | "tool"
  result: string
}

const children: ChildFixture[] = [
  { id: "ses_team_child_1", title: "Alpha researcher", agent: "explore", busy: true, activity: "thinking", result: "" },
  { id: "ses_team_child_2", title: "Bravo researcher", agent: "explore", busy: true, activity: "tool", result: "" },
  { id: "ses_team_child_3", title: "Charlie researcher", agent: "explore", busy: false, activity: "thinking", result: "Charlie finished the survey" },
  { id: "ses_team_child_4", title: "Delta researcher", agent: "explore", busy: false, activity: "thinking", result: "Delta finished the survey" },
  { id: "ses_team_child_5", title: "Echo researcher", agent: "explore", busy: false, activity: "thinking", result: "Echo finished the survey" },
  { id: "ses_team_child_6", title: "Foxtrot researcher", agent: "explore", busy: false, activity: "thinking", result: "Foxtrot finished the survey" },
  { id: "ses_team_child_7", title: "Golf researcher", agent: "explore", busy: false, activity: "thinking", result: "Golf finished the survey" },
  { id: "ses_team_child_8", title: "Hotel researcher", agent: "explore", busy: false, activity: "thinking", result: "Hotel finished the survey" },
]

test.use({ viewport: { width: 1280, height: 420 } })

test("team panel keeps row identity, scroll position and panel identity across poll cycles", async ({ page }) => {
  const counts = { children: 0, parentMessages: 0, status: 0, childMessages: 0 }

  await installSseTransport(page, { server, retry: 20 })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agent-teams-poll",
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
    sessions: [parentSession(), ...children.map(childSession)],
    pageMessages: () => ({ items: [] }),
    sessionStatus: Object.fromEntries(children.filter((child) => child.busy).map((child) => [child.id, { type: "busy" }])),
  })
  await routeTeamReads(page, counts)
  await configurePage(page)

  await page.goto(agentTeamsHref(parentID))
  await expect(page.getByText("Child sessions spawned from this session")).toBeVisible()

  const rows = page.locator('button[title="Open session"]')
  await expect(rows).toHaveCount(children.length)
  await expect(rows.filter({ hasText: "Alpha researcher" }).getByText("Thinking")).toBeVisible()
  await expect(rows.filter({ hasText: "Bravo researcher" }).getByText("Using bash")).toBeVisible()
  await expect(rows.filter({ hasText: "Charlie researcher" }).getByText("Done")).toBeVisible()

  const initialChildren = counts.children
  await installProbe(page, children.length)
  await scrollPanel(page, 160)

  await expect.poll(() => counts.children, { timeout: 20_000 }).toBeGreaterThanOrEqual(initialChildren + 2)

  const trace = await collectProbe(page)
  void test.info().attach("team-poll-trace", { body: JSON.stringify(trace, null, 2), contentType: "application/json" })
  void test.info().attach("team-poll-final", { body: await page.screenshot(), contentType: "image/png" })

  expect(trace.scrollTop.before).toBeGreaterThan(0)
  expect(trace.rows.retained).toEqual(trace.rows.baseline.map((row) => row.node))
  expect(trace.rows.current.map((row) => row.node)).toEqual(trace.rows.baseline.map((row) => row.node))
  expect(trace.rows.current.map((row) => row.title)).toEqual(trace.rows.baseline.map((row) => row.title))
  expect(trace.removedRows).toEqual([])
  expect(trace.rowListReplaced).toBe(false)
  expect(trace.scrollReplaced).toBe(false)
  expect(trace.blankFrames).toEqual([])
  expect(trace.bodyMutations).toEqual([])
  expect(trace.scrollTop.after).toBe(trace.scrollTop.before)
})

type TeamPollTrace = {
  expected: number
  rows: {
    baseline: { index: number; title: string; node: number }[]
    current: { index: number; title: string; node: number; attached: boolean }[]
    retained: number[]
  }
  removedRows: { at: number; node: number }[]
  addedRows: { at: number; node: number }[]
  rowListReplaced: boolean
  scrollReplaced: boolean
  scrollTop: { before: number; after: number }
  blankFrames: { at: number; count: number }[]
  frames: { at: number; tagged: number; rows: number; empty: boolean; description: boolean; header: boolean; splash: number; mainText: number; mainChildren: number; href: string }[]
  bodyMutations: { at: number; kind: "remove" | "add"; tag: string; hasRows: boolean; hasHeader: boolean }[]
  mutationBatches: { at: number; removed: number; added: number }[]
}

declare global {
  interface Window {
    __teamPollProbe?: {
      scrollTo: (top: number) => void
      collect: () => TeamPollTrace
    }
  }
}

async function installProbe(page: Page, expected: number) {
  await page.evaluate((expected) => {
    const rowSelector = 'button[title="Open session"]'
    const rows = [...document.querySelectorAll<HTMLButtonElement>(rowSelector)]
    if (rows.length !== expected) throw new Error(`expected ${expected} rows, found ${rows.length}`)
    const rowList = rows[0].parentElement
    if (!rowList) throw new Error("team rows container not found")
    const scroll = rowList.closest<HTMLElement>(".overflow-y-auto")
    if (!scroll) throw new Error("team scroll container not found")

    const nodeIDs = new WeakMap<Node, number>()
    const nodeRefs = new Map<number, WeakRef<Node>>()
    let nextNodeID = 1
    const nodeID = (node: Node) => {
      const current = nodeIDs.get(node)
      if (current !== undefined) return current
      const id = nextNodeID++
      nodeIDs.set(node, id)
      nodeRefs.set(id, new WeakRef(node))
      return id
    }

    const startedAt = performance.now()
    const now = () => performance.now() - startedAt
    const tagged = (node: Node) => node instanceof Element && node.querySelector(rowSelector) !== null

    const trace: TeamPollTrace = {
      expected,
      rows: {
        baseline: rows.map((row, index) => ({ index, title: row.textContent ?? "", node: nodeID(row) })),
        current: [],
        retained: [],
      },
      removedRows: [],
      addedRows: [],
      rowListReplaced: false,
      scrollReplaced: false,
      scrollTop: { before: scroll.scrollTop, after: scroll.scrollTop },
      blankFrames: [],
      frames: [],
      bodyMutations: [],
      mutationBatches: [],
    }
    rows.forEach((row, index) => row.setAttribute("data-poll-row", String(index)))

    const scrollObserver = new MutationObserver((records) => {
      const at = now()
      let removed = 0
      let added = 0
      for (const record of records) {
        for (const node of record.removedNodes) {
          removed += 1
          if (node === rowList || (node instanceof Element && node.contains(rowList)))
            trace.rowListReplaced = true
          if (tagged(node)) trace.removedRows.push({ at, node: nodeID(node) })
        }
        for (const node of record.addedNodes) {
          added += 1
          if (tagged(node)) trace.addedRows.push({ at, node: nodeID(node) })
        }
      }
      if (removed || added) trace.mutationBatches.push({ at, removed, added })
    })
    scrollObserver.observe(scroll, { childList: true, subtree: true })

    const parentObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node === scroll) trace.scrollReplaced = true
      }
    })
    parentObserver.observe(scroll.parentElement!, { childList: true })

    const frame = () => {
      const taggedCount = document.querySelectorAll("[data-poll-row]").length
      const rowCount = document.querySelectorAll(rowSelector).length
      const text = document.body.textContent ?? ""
      const main = document.querySelector("main")
      return {
        at: now(),
        tagged: taggedCount,
        rows: rowCount,
        empty: text.includes("No team members"),
        description: text.includes("Child sessions spawned from this session"),
        header: text.includes("Agent teams"),
        splash: document.querySelectorAll(".animate-pulse").length,
        mainText: main?.textContent?.length ?? -1,
        mainChildren: main?.children.length ?? -1,
        href: location.href,
      }
    }
    const signature = (sample: ReturnType<typeof frame>) =>
      `${sample.tagged}|${sample.rows}|${sample.empty}|${sample.description}|${sample.header}|${sample.splash}|${sample.mainText}|${sample.mainChildren}|${sample.href}`

    const bodyObserver = new MutationObserver((records) => {
      const at = now()
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue
          const hasRows = node.matches(rowSelector) || node.querySelector(rowSelector) !== null
          const hasHeader = (node.textContent ?? "").includes("Agent teams")
          if (hasRows || hasHeader)
            trace.bodyMutations.push({ at, kind: "remove", tag: node.tagName + "." + node.className.split(" ").slice(0, 3).join("."), hasRows, hasHeader })
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const hasRows = node.matches(rowSelector) || node.querySelector(rowSelector) !== null
          const hasHeader = (node.textContent ?? "").includes("Agent teams")
          if (hasRows || hasHeader)
            trace.bodyMutations.push({ at, kind: "add", tag: node.tagName + "." + node.className.split(" ").slice(0, 3).join("."), hasRows, hasHeader })
        }
      }
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })

    let running = true
    let previous = signature(frame())
    trace.frames.push({ ...frame(), at: 0 })
    const sample = () => {
      if (!running) return
      const next = frame()
      const nextSignature = signature(next)
      if (nextSignature !== previous) {
        trace.frames.push(next)
        previous = nextSignature
      }
      if (next.tagged !== expected && trace.blankFrames.length < 50) trace.blankFrames.push({ at: next.at, count: next.tagged })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)

    window.__teamPollProbe = {
      scrollTo(top: number) {
        scroll.scrollTop = top
        trace.scrollTop.before = scroll.scrollTop
      },
      collect() {
        running = false
        scrollObserver.disconnect()
        parentObserver.disconnect()
        bodyObserver.disconnect()
        trace.rows.current = [...document.querySelectorAll<HTMLButtonElement>(rowSelector)].map((row, index) => ({
          index,
          title: row.textContent ?? "",
          node: nodeID(row),
          attached: document.contains(row),
        }))
        const baselineNodes = new Set(trace.rows.baseline.map((row) => row.node))
        trace.rows.retained = [...nodeRefs.entries()]
          .filter(([id, ref]) => baselineNodes.has(id) && ref.deref() !== undefined && document.contains(ref.deref()!))
          .map(([id]) => id)
        trace.scrollTop.after = scroll.scrollTop
        return trace
      },
    }
  }, expected)
}

async function scrollPanel(page: Page, top: number) {
  await page.evaluate((top) => {
    const probe = window.__teamPollProbe
    if (!probe) throw new Error("team poll probe was not installed")
    probe.scrollTo(top)
  }, top)
}

async function collectProbe(page: Page) {
  return page.evaluate(() => {
    const probe = window.__teamPollProbe
    if (!probe) throw new Error("team poll probe was not installed")
    return probe.collect()
  })
}

async function routeTeamReads(
  page: Page,
  counts: { children: number; parentMessages: number; status: number; childMessages: number },
) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === `/session/${parentID}/children`) {
      counts.children += 1
      return json(route, children.map(childSession))
    }
    if (url.pathname === `/session/${parentID}/message`) {
      counts.parentMessages += 1
      return json(route, parentMessages())
    }
    const child = children.find((item) => url.pathname === `/session/${item.id}/message`)
    if (child) {
      counts.childMessages += 1
      return json(route, childMessages(child))
    }
    if (url.pathname === "/session/status") counts.status += 1
    return route.fallback()
  })
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function session(id: string, title: string, created: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function parentSession() {
  return session(parentID, parentTitle, 1700000000000)
}

function childSession(child: ChildFixture, index: number) {
  return session(child.id, child.title, 1700000001000 + index, { parentID, agent: child.agent })
}

function parentMessages() {
  const messageID = "msg_parent_dispatch"
  return [
    {
      info: {
        id: "msg_parent_user",
        sessionID: parentID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
      },
      parts: [
        {
          id: "prt_parent_user_text",
          sessionID: parentID,
          messageID: "msg_parent_user",
          type: "text",
          text: "Dispatch the team",
        },
      ],
    },
    {
      info: {
        id: messageID,
        sessionID: parentID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: "msg_parent_user",
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_parent_dispatch",
          sessionID: parentID,
          messageID,
          type: "tool",
          callID: "call_parent_dispatch",
          tool: "dispatch",
          state: {
            status: "completed",
            input: {},
            output: "dispatched",
            metadata: {
              members: children.map((child) => ({
                sessionID: child.id,
                state: child.busy ? "running" : "completed",
                ...(child.busy ? {} : { text: child.result }),
                ...(child.busy ? {} : { tokens: 1200, elapsedMs: 4200, variant: "explore" }),
              })),
            },
            time: { start: 1700000001000, end: 1700000002000 },
          },
        },
      ],
    },
  ]
}

function childMessages(child: ChildFixture) {
  const sessionID = child.id
  const parts =
    child.activity === "thinking"
      ? [{ id: `prt_${sessionID}_reasoning`, sessionID, messageID: `msg_${sessionID}`, type: "reasoning", text: "considering" }]
      : [
          {
            id: `prt_${sessionID}_tool`,
            sessionID,
            messageID: `msg_${sessionID}`,
            type: "tool",
            callID: `call_${sessionID}`,
            tool: "bash",
            state: { status: "running", input: { command: "grep -r stable ." }, time: { start: 1700000003000 } },
          },
        ]
  return [
    {
      info: {
        id: `msg_${sessionID}`,
        sessionID,
        role: "assistant",
        time: { created: 1700000003000 },
        parentID: "msg_parent_user",
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        mode: "build",
        agent: child.agent,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts,
    },
  ]
}

function agentTeamsHref(sessionID: string) {
  return `/server/${base64Encode(server)}/agent-teams/${sessionID}?view=team`
}

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, server, sessionId }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId }]))
    },
    { directory, server, sessionId: parentID },
  )
}
