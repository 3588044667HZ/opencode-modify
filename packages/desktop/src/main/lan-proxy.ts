import { createHash, timingSafeEqual } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import * as http from "node:http"
import * as https from "node:https"
import * as net from "node:net"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import { pipeline } from "node:stream"
import * as tls from "node:tls"
import { createBrotliCompress, createGzip } from "node:zlib"

export type LanProxyTarget = {
  url: string
  username: string
  password: string
}

export type LanProxyOptions = {
  target: LanProxyTarget
  hostname?: string
  port?: number
  password: string
  /** Optional local web UI build; when present it is served instead of the sidecar's UI proxy. */
  staticRoot?: string
  /** Open projects from the desktop client, used by LAN/web clients that have no local project store. */
  projectList?: () => { directories: string[]; lastProject?: string }
}

export type LanProxy = {
  hostname: string
  port: number
  urls: string[]
  stop: () => Promise<void>
}

const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

const forwarded = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
])

const publicPaths = new Set([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

const upgradeSkip = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
])

export async function startLanProxy(options: LanProxyOptions): Promise<LanProxy> {
  const target = parseTarget(options.target)
  const authorization = basic(target.username, target.password)
  const sockets = new Set<net.Socket>()
  const upstreams = new Set<net.Socket>()

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = requestURL(request)
    if (!url) {
      badRequest(response)
      return
    }
    // Static assets are the app shell, not protected data. Serving them before
    // auth makes `?auth_token=...` work for the HTML while subresources load
    // without the token. The HTML document and all API calls still require auth.
    const staticFile_ = options.staticRoot ? staticFile(options.staticRoot, url.pathname) : undefined
    const indexFile = !!staticFile_ && staticFile_.endsWith("index.html")
    if (staticFile_ && !indexFile && (await serveFile(request, response, staticFile_))) return

    if (!publicPaths.has(url.pathname) && !authorized(request, url, options.password)) {
      unauthorized(response)
      return
    }

    if (url.pathname === "/__cockpit/projects") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" })
        response.end()
        return
      }
      const projects = options.projectList?.() ?? { directories: [] }
      const body = JSON.stringify(projects)
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
      })
      response.end(request.method === "HEAD" ? undefined : body)
      return
    }

    if (staticFile_ && (await serveFile(request, response, staticFile_))) return
    if (options.staticRoot && wantsHTML(request) && !isApiPath(url.pathname)) {
      const index = join(options.staticRoot, "index.html")
      if (await serveFile(request, response, index, "no-cache")) return
    }

    url.searchParams.delete("auth_token")
    const transport = target.protocol === "https:" ? https : http
    const upstream = transport.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: joinPath(target.pathname, url),
        headers: headers(request, target, authorization),
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, responseHeaders(incoming.headers))
        incoming.pipe(response)
        incoming.on("error", () => response.destroy())
        incoming.on("aborted", () => response.destroy())
      },
    )

    upstream.on("error", () => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      response.end("Bad Gateway")
    })
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy()
    })
    request.on("aborted", () => upstream.destroy())
    request.pipe(upstream)
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      response.end("Internal Server Error")
    })
  })

  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  server.on("upgrade", (request, socket, head) => {
    const url = requestURL(request)
    if (!url) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }
    if (!authorized(request, url, options.password)) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm="OpenCode"\r\nconnection: close\r\n\r\n',
      )
      socket.destroy()
      return
    }

    url.searchParams.delete("auth_token")
    const connected =
      target.protocol === "https:"
        ? tls.connect({ host: target.hostname, port: target.port, servername: target.hostname })
        : net.connect({ host: target.hostname, port: target.port })

    upstreams.add(connected)
    connected.on("close", () => upstreams.delete(connected))
    connected.on("connect", () => {
      const lines = [`${request.method ?? "GET"} ${joinPath(target.pathname, url)} HTTP/1.1`]
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue
        if (upgradeSkip.has(key) || forwarded.has(key)) continue
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`)
          continue
        }
        lines.push(`${key}: ${value}`)
      }
      lines.push(`host: ${target.authority}`)
      lines.push(`authorization: ${authorization}`)
      lines.push("x-forwarded-proto: http")
      if (request.socket.remoteAddress) lines.push(`x-forwarded-for: ${request.socket.remoteAddress}`)
      connected.write(lines.join("\r\n") + "\r\n\r\n")
      if (head.length) connected.write(head)
      connected.pipe(socket)
      socket.pipe(connected)
    })

    connected.on("error", () => socket.destroy())
    socket.on("error", () => connected.destroy())
  })

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
  })

  const port = await listen(server, options.hostname ?? "0.0.0.0", options.port ?? 4096)

  return {
    hostname: options.hostname ?? "0.0.0.0",
    port,
    urls: lanUrls(port),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
        sockets.forEach((socket) => socket.destroy())
        upstreams.forEach((socket) => socket.destroy())
      }),
  }
}

export function lanUrls(port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  const urls = new Set<string>()

  for (const entries of Object.values(interfaces)) {
    for (const item of entries ?? []) {
      if (item.family !== "IPv4" || item.internal) continue
      if (item.address.startsWith("169.254.")) continue
      urls.add(`http://${item.address}:${port}`)
    }
  }

  return Array.from(urls)
}

function parseTarget(input: LanProxyTarget) {
  const url = new URL(input.url)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported LAN proxy target protocol: ${url.protocol}`)
  }

  const hostname = normalizeHost(url.hostname)
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  const authority = `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
  return {
    protocol: url.protocol,
    hostname,
    port,
    authority,
    pathname: url.pathname,
    username: input.username || "opencode",
    password: input.password,
  }
}

function normalizeHost(hostname: string) {
  const value = hostname.replace(/^\[|\]$/g, "")
  if (value === "0.0.0.0" || value === "::") return "127.0.0.1"
  return value
}

function requestURL(request: http.IncomingMessage) {
  const raw = request.url ?? "/"
  // Only origin-form requests are accepted; absolute-form targets could turn
  // this listener into an unintended forward proxy.
  if (!raw.startsWith("/")) return
  try {
    return new URL(raw, "http://localhost")
  } catch {
    return
  }
}

function joinPath(base: string, url: URL) {
  const prefix = base === "/" ? "" : base.replace(/\/$/, "")
  return `${prefix}${url.pathname}${url.search}`
}

function staticFile(root: string, pathname: string) {
  if (pathname === "/") return join(root, "index.html")
  if (pathname.includes("\u0000")) return
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return
  }
  if (decoded.includes("\u0000")) return
  const file = resolve(root, `.${decoded}`)
  const rel = relative(root, file)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return
  return file
}

function wantsHTML(request: http.IncomingMessage) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  return (request.headers.accept ?? "").includes("text/html")
}

const apiPath = /^\/(?:api|global|session|project|file|config|event|pty|experimental|doc|health|share|tui)(?:\/|$)/

function isApiPath(pathname: string) {
  return apiPath.test(pathname)
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

const compressionThreshold = 1024

const compressible = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".xml",
  ".webmanifest",
  ".wasm",
])

function cacheControlFor(file: string) {
  if (basename(file).toLowerCase() === "index.html") return "no-cache"
  if (isHashedAsset(file)) return "public, max-age=31536000, immutable"
  return "public, max-age=3600"
}

const hashedAsset = /(?:-([A-Za-z0-9_-]{8})|\.([A-Za-z0-9_-]{8,}))\.[A-Za-z0-9]+$/

function isHashedAsset(file: string) {
  const match = hashedAsset.exec(basename(file))
  if (!match) return false
  const hash = match[1] ?? match[2]
  // Hashes contain digits or uppercase letters; this avoids treating names like
  // "apple-touch-icon.png" or "web-app-manifest-192x192.png" as content-addressed.
  return hash !== undefined && /[A-Z0-9]/.test(hash)
}

function acceptedEncoding(header: string | undefined) {
  if (!header) return
  const preferences = new Map<string, number>()
  let wildcard: number | undefined
  for (const entry of header.split(",")) {
    const [name, ...params] = entry.trim().toLowerCase().split(";")
    if (!name) continue
    let quality = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*(\S+)\s*$/.exec(param)
      if (!match) continue
      const value = Number(match[1])
      quality = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
    }
    if (name === "*") wildcard = quality
    else preferences.set(name, quality)
  }
  const br = preferences.get("br") ?? wildcard ?? 0
  const gzip = preferences.get("gzip") ?? wildcard ?? 0
  if (br <= 0 && gzip <= 0) return
  return br >= gzip ? "br" : "gzip"
}

function compressionFor(request: http.IncomingMessage, file: string, size: number) {
  if (size < compressionThreshold) return
  if (!compressible.has(extname(file).toLowerCase())) return
  return acceptedEncoding(request.headers["accept-encoding"])
}

async function serveFile(request: http.IncomingMessage, response: http.ServerResponse, file: string, cache?: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return false
  const extension = extname(file).toLowerCase()
  const responseHeaders: http.OutgoingHttpHeaders = {
    "content-type": mime[extension] ?? "application/octet-stream",
    "cache-control": cache ?? cacheControlFor(file),
  }
  if (compressible.has(extension)) responseHeaders.vary = "Accept-Encoding"
  // HEAD keeps the identity metadata so Content-Length matches the file without
  // paying the cost of compressing a body that will not be sent.
  const encoding = request.method === "HEAD" ? undefined : compressionFor(request, file, info.size)
  if (encoding) {
    responseHeaders["content-encoding"] = encoding
  } else {
    responseHeaders["content-length"] = String(info.size)
  }
  response.writeHead(200, responseHeaders)
  if (request.method === "HEAD") {
    response.end()
    return true
  }
  const stream = createReadStream(file)
  stream.on("error", () => response.destroy())
  if (!encoding) {
    stream.pipe(response)
    return true
  }
  void pipeline(stream, encoding === "br" ? createBrotliCompress() : createGzip(), response, (error) => {
    if (error) response.destroy()
  })
  return true
}

function headers(
  request: http.IncomingMessage,
  target: ReturnType<typeof parseTarget>,
  authorization: string,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (hop.has(key) || forwarded.has(key) || key === "authorization") continue
    result[key] = value
  }
  result.host = target.authority
  result.authorization = authorization
  result["x-forwarded-proto"] = "http"
  if (request.socket.remoteAddress) result["x-forwarded-for"] = request.socket.remoteAddress
  return result
}

function responseHeaders(input: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (hop.has(key)) continue
    result[key] = value
  }
  return result
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function authorized(request: http.IncomingMessage, url: URL, password: string) {
  const token = url.searchParams.get("auth_token")
  const decoded = decode(token ? `Basic ${token}` : request.headers.authorization)
  if (!decoded) return false
  return equal(decoded.username, "opencode") && equal(decoded.password, password)
}

function decode(value: string | undefined) {
  if (!value) return
  const match = /^Basic\s+(.+)$/i.exec(value)
  if (!match) return
  try {
    const raw = Buffer.from(match[1], "base64").toString("utf8")
    const index = raw.indexOf(":")
    if (index === -1) return
    return { username: raw.slice(0, index), password: raw.slice(index + 1) }
  } catch {
    return
  }
}

function equal(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest())
}

function unauthorized(response: http.ServerResponse) {
  response.writeHead(401, {
    "www-authenticate": 'Basic realm="OpenCode"',
    "content-type": "text/plain; charset=utf-8",
  })
  response.end("Unauthorized")
}

function badRequest(response: http.ServerResponse) {
  response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
  response.end("Bad Request")
}

function listen(server: http.Server, hostname: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, hostname)
  })
}
