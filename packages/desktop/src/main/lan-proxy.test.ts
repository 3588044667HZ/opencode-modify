import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import * as http from "node:http"
import * as net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { lanUrls, startLanProxy, type LanProxy } from "./lan-proxy"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

async function upstream() {
  const requests: Array<http.IncomingMessage> = []
  const server = http.createServer((request, response) => {
    requests.push(request)
    if (request.headers.authorization !== basic("opencode", "target-secret")) {
      response.writeHead(401)
      response.end()
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        url: request.url,
        authorization: request.headers.authorization,
        custom: request.headers["x-test"],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )
  return { port: typeof address === "object" && address ? address.port : 0, requests }
}

async function proxy(port: number, staticRoot?: string): Promise<LanProxy> {
  const result = await startLanProxy({
    target: { url: `http://127.0.0.1:${port}`, username: "opencode", password: "target-secret" },
    hostname: "127.0.0.1",
    port: 0,
    password: "lan-secret",
    staticRoot,
  })
  cleanups.unshift(() => result.stop())
  return result
}

async function staticFiles(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-lan-static-"))
  cleanups.unshift(() => rm(root, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

function send(port: number, pathname: string, headers: http.OutgoingHttpHeaders = {}, method = "GET") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const client = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
      )
    })
    client.on("error", reject)
    client.end()
  })
}

describe("lan proxy", () => {
  test("requires the configured password", async () => {
    const origin = await upstream()
    const server = await proxy(origin.port)
    const response = await fetch(`http://127.0.0.1:${server.port}/hello`)

    expect(response.status).toBe(401)
    expect(origin.requests).toHaveLength(0)
  })

  test("forwards authorized requests with the target credentials", async () => {
    const origin = await upstream()
    const server = await proxy(origin.port)
    const response = await fetch(`http://127.0.0.1:${server.port}/hello?x=1`, {
      headers: { authorization: basic("opencode", "lan-secret"), "x-test": "yes" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      url: "/hello?x=1",
      authorization: basic("opencode", "target-secret"),
      custom: "yes",
    })
  })

  test("accepts auth_token and removes it before forwarding", async () => {
    const origin = await upstream()
    const server = await proxy(origin.port)
    const token = Buffer.from("opencode:lan-secret").toString("base64")
    const response = await fetch(`http://127.0.0.1:${server.port}/hello?auth_token=${encodeURIComponent(token)}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ url: "/hello" })
  })

  test("serves the desktop project list to authorized clients", async () => {
    const origin = await upstream()
    const server = await startLanProxy({
      target: { url: `http://127.0.0.1:${origin.port}`, username: "opencode", password: "target-secret" },
      hostname: "127.0.0.1",
      port: 0,
      password: "lan-secret",
      projectList: () => ({ directories: ["/tmp/a", "/tmp/b"], lastProject: "/tmp/a" }),
    })
    cleanups.unshift(() => server.stop())

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/__cockpit/projects`)
    expect(unauthorized.status).toBe(401)

    const response = await fetch(`http://127.0.0.1:${server.port}/__cockpit/projects`, {
      headers: { authorization: basic("opencode", "lan-secret") },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ directories: ["/tmp/a", "/tmp/b"], lastProject: "/tmp/a" })
    expect(origin.requests).toHaveLength(0)
  })

  test("rejects a malformed request target without crashing", async () => {
    const origin = await upstream()
    const server = await proxy(origin.port)
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(server.port, "127.0.0.1", () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\n\r\n")
      })
      socket.once("data", (chunk) => {
        resolve(chunk.toString())
        socket.destroy()
      })
      socket.once("error", reject)
    })

    expect(response).toContain("400 Bad Request")
  })

  test("rejects a wrong password", async () => {
    const origin = await upstream()
    const server = await proxy(origin.port)
    const response = await fetch(`http://127.0.0.1:${server.port}/hello`, {
      headers: { authorization: basic("opencode", "wrong") },
    })

    expect(response.status).toBe(401)
  })

  // Bun's node:http upgrade socket does not deliver server writes; Electron runs this path on Node.
  test.skipIf(typeof Bun !== "undefined")("proxies websocket upgrades with the target credentials", async () => {
    let request = ""
    const sockets = new Set<net.Socket>()
    const origin = net.createServer((socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.once("data", (chunk) => {
        request = chunk.toString()
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
      })
    })
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
    const address = origin.address()
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          sockets.forEach((socket) => socket.destroy())
          origin.close(() => resolve())
        }),
    )

    const server = await proxy(typeof address === "object" && address ? address.port : 0)
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(server.port, "127.0.0.1", () => {
        socket.write(
          [
            "GET /socket HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGVzdA==",
            "Sec-WebSocket-Version: 13",
            `Authorization: ${basic("opencode", "lan-secret")}`,
            "",
            "",
          ].join("\r\n"),
        )
      })
      socket.once("data", (chunk) => {
        resolve(chunk.toString())
        socket.destroy()
      })
      socket.once("error", reject)
    })

    expect(response).toContain("101 Switching Protocols")
    expect(request).toContain("GET /socket HTTP/1.1")
    expect(request).toContain(`authorization: ${basic("opencode", "target-secret")}`)
  })

  test("serves the local web UI and SPA fallback", async () => {
    const origin = await upstream()
    const root = await mkdtemp(path.join(tmpdir(), "opencode-lan-static-"))
    cleanups.unshift(() => rm(root, { recursive: true, force: true }))
    await mkdir(path.join(root, "assets"), { recursive: true })
    await writeFile(path.join(root, "index.html"), "<html>local ui</html>")
    await writeFile(path.join(root, "assets", "app.js"), "console.log('local')")

    const server = await startLanProxy({
      target: { url: `http://127.0.0.1:${origin.port}`, username: "opencode", password: "target-secret" },
      hostname: "127.0.0.1",
      port: 0,
      password: "lan-secret",
      staticRoot: root,
    })
    cleanups.unshift(() => server.stop())

    const auth = basic("opencode", "lan-secret")
    const index = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { authorization: auth, accept: "text/html" } })
    expect(await index.text()).toBe("<html>local ui</html>")
    expect(index.headers.get("content-type")).toContain("text/html")

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(unauthorized.status).toBe(401)

    const asset = await fetch(`http://127.0.0.1:${server.port}/assets/app.js`)
    expect(await asset.text()).toBe("console.log('local')")
    expect(asset.headers.get("content-type")).toContain("text/javascript")

    const route = await fetch(`http://127.0.0.1:${server.port}/some/session`, {
      headers: { authorization: auth, accept: "text/html" },
    })
    expect(await route.text()).toBe("<html>local ui</html>")
  })

  test("forwards API paths even when the client accepts HTML", async () => {
    const origin = await upstream()
    const root = await mkdtemp(path.join(tmpdir(), "opencode-lan-static-"))
    cleanups.unshift(() => rm(root, { recursive: true, force: true }))
    await writeFile(path.join(root, "index.html"), "<html>local ui</html>")

    const server = await startLanProxy({
      target: { url: `http://127.0.0.1:${origin.port}`, username: "opencode", password: "target-secret" },
      hostname: "127.0.0.1",
      port: 0,
      password: "lan-secret",
      staticRoot: root,
    })
    cleanups.unshift(() => server.stop())

    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
      headers: { authorization: basic("opencode", "lan-secret"), accept: "text/html" },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"url":"/api/health"')
  })

  test("uses immutable caching for hashed assets and no-cache for the index", async () => {
    const origin = await upstream()
    const root = await staticFiles({
      "index.html": "<html>local ui</html>",
      "assets/index-Dh5KOV1z.js": "console.log('hashed')",
      "assets/app.js": "console.log('plain')",
    })
    const server = await proxy(origin.port, root)

    const hashed = await send(server.port, "/assets/index-Dh5KOV1z.js")
    expect(hashed.status).toBe(200)
    expect(hashed.headers["cache-control"]).toBe("public, max-age=31536000, immutable")

    const plain = await send(server.port, "/assets/app.js")
    expect(plain.headers["cache-control"]).toBe("public, max-age=3600")

    const index = await send(server.port, "/", { authorization: basic("opencode", "lan-secret") })
    expect(index.status).toBe(200)
    expect(index.headers["cache-control"]).toBe("no-cache")
  })

  test("negotiates brotli and gzip for compressible static assets", async () => {
    const origin = await upstream()
    const body = "console.log('compressed asset')\n".repeat(200)
    const root = await staticFiles({
      "index.html": "<html>local ui</html>",
      "assets/app-C3P0abc1.js": body,
    })
    const server = await proxy(origin.port, root)

    const brotli = await send(server.port, "/assets/app-C3P0abc1.js", { "accept-encoding": "gzip, br" })
    expect(brotli.status).toBe(200)
    expect(brotli.headers["content-encoding"]).toBe("br")
    expect(brotli.headers.vary).toBe("Accept-Encoding")
    expect(brotli.headers["content-length"]).toBeUndefined()
    expect(brotliDecompressSync(brotli.body).toString()).toBe(body)

    const gzip = await send(server.port, "/assets/app-C3P0abc1.js", {
      "accept-encoding": "br;q=0.2, gzip;q=0.9",
    })
    expect(gzip.headers["content-encoding"]).toBe("gzip")
    expect(gunzipSync(gzip.body).toString()).toBe(body)

    const identity = await send(server.port, "/assets/app-C3P0abc1.js", { "accept-encoding": "gzip;q=0" })
    expect(identity.headers["content-encoding"]).toBeUndefined()
    expect(identity.body.toString()).toBe(body)
  })

  test("does not compress already compressed static assets", async () => {
    const origin = await upstream()
    const image = Buffer.alloc(4096, 7)
    const root = await staticFiles({ "assets/logo-Dh5KOV1z.png": image })
    const server = await proxy(origin.port, root)

    const response = await send(server.port, "/assets/logo-Dh5KOV1z.png", { "accept-encoding": "gzip, br" })
    expect(response.headers["content-encoding"]).toBeUndefined()
    expect(response.headers.vary).toBeUndefined()
    expect(response.headers["content-length"]).toBe(String(image.length))
    expect(response.body.equals(image)).toBe(true)
  })

  test("preserves HEAD responses for compressible static assets", async () => {
    const origin = await upstream()
    const body = "console.log('head')\n".repeat(200)
    const root = await staticFiles({ "assets/app-C3P0abc1.js": body })
    const server = await proxy(origin.port, root)

    const response = await send(server.port, "/assets/app-C3P0abc1.js", { "accept-encoding": "gzip, br" }, "HEAD")
    expect(response.status).toBe(200)
    expect(response.headers["content-encoding"]).toBeUndefined()
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(body)))
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
    expect(response.body).toHaveLength(0)
  })

  test("lists non-internal IPv4 addresses", () => {
    const urls = lanUrls(4096, {
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      wifi: [
        {
          address: "192.168.1.23",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:11:22:33:44:55",
          internal: false,
          cidr: "192.168.1.23/24",
        },
      ],
      docker: [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:11:22:33:44:56",
          internal: false,
          cidr: "172.17.0.1/16",
        },
      ],
    })

    expect(urls).toEqual(["http://192.168.1.23:4096", "http://172.17.0.1:4096"])
  })
})
