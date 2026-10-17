import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { renderBlastRadius } from "@/semantic/render"
import { frame, listenServer } from "./fake-server"
import { SAMPLE_BLAST_RENDER, SAMPLE_BLAST_RESULT } from "./fixture"

describe("semantic blast_radius render", () => {
  test("renders the spec sample byte for byte", () => {
    expect(renderBlastRadius(SAMPLE_BLAST_RESULT)).toBe(SAMPLE_BLAST_RENDER)
  })

  test("truncates callers with the total when callers_total exceeds the listed callers", () => {
    const callers = Array.from({ length: 20 }, (_, index) => ({
      file: `f${index}.ts`,
      line: index + 1,
      context: "run",
      is_test: false,
    }))
    const result: Protocol.BlastRadiusResult = {
      ...SAMPLE_BLAST_RESULT,
      callers,
      summary: { ...SAMPLE_BLAST_RESULT.summary, callers_count: 20, callers_total: 47, risk: "high" },
    }

    const lines = renderBlastRadius(result).split("\n")
    expect(lines[0]).toBe("load() @ engine.ts:40 (method)")
    expect(lines[1]).toBe("  callers: 20+ (total 47)")
    expect(lines[2]).toBe("  callees: 2 [json.load @ json/__init__.py:120, transform @ engine.ts:55]")
    expect(lines[6]).toBe("  risk: high")
    expect(renderBlastRadius(result)).not.toContain("f0.ts:1")
  })

  test("lists callers when callers_total matches the listed callers", () => {
    const result: Protocol.BlastRadiusResult = {
      ...SAMPLE_BLAST_RESULT,
      summary: { ...SAMPLE_BLAST_RESULT.summary, callers_total: 3 },
    }

    expect(renderBlastRadius(result).split("\n")[1]).toBe(
      "  callers: 3 [bar.ts:42 handleRequest, baz.ts:17 retry, test_engine.py:88 test_load]",
    )
  })

  test("renders empty callers, callees, entry points, and tests", () => {
    const result: Protocol.BlastRadiusResult = {
      symbol: "orphan",
      definition: { file: "a.ts", line: 1, kind: "function" },
      callers: [],
      callees: [],
      affected_files: [],
      entry_points: [],
      tests_affected: [],
      summary: { callers_count: 0, callees_count: 0, files_count: 0, has_public_api_usage: false, risk: "low" },
    }

    expect(renderBlastRadius(result).split("\n")).toEqual([
      "orphan() @ a.ts:1 (function)",
      "  callers: 0 []",
      "  callees: 0 []",
      "  affected: 0 files",
      "  entry: none",
      "  tests: 0 []",
      "  risk: low",
    ])
  })

  test("renders each entry point on its own line", () => {
    const result: Protocol.BlastRadiusResult = {
      ...SAMPLE_BLAST_RESULT,
      entry_points: [
        { file: "qux.ts", line: 88, context: "main", reason: "reached_from_main" },
        { file: "routes.ts", line: 12, context: "registerRoutes", reason: "public_api" },
      ],
    }

    const lines = renderBlastRadius(result).split("\n")
    expect(lines[4]).toBe("  entry: qux.ts:88 main ← reached_from_main")
    expect(lines[5]).toBe("  entry: routes.ts:12 registerRoutes ← public_api")
    expect(lines[6]).toBe("  tests: 1 [test_engine.py::test_load]")
  })
})

describe("semantic blast_radius client", () => {
  const serve = (
    result: unknown,
    onRequest?: (message: any) => void,
  ) =>
    listenServer((message, socket) => {
      if (message.method !== "blast_radius") return
      onRequest?.(message)
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result }))
    })

  test("decodes a complete blast_radius result and forwards the scope", async () => {
    const requests: any[] = []
    const server = await serve(SAMPLE_BLAST_RESULT, (message) => requests.push(message))
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const result = await client.blastRadius({ symbol: "load", scope: "file:engine.ts" })
    expect(result).toEqual(SAMPLE_BLAST_RESULT)
    expect(requests[0]?.method).toBe("blast_radius")
    expect(requests[0]?.params).toEqual({ symbol: "load", scope: "file:engine.ts" })

    client.close()
    await server.close()
  })

  test("maps symbol-not-found responses to RpcError -32002", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method === "blast_radius") {
        socket.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "symbol not found" } }))
      }
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.blastRadius({ symbol: "missing" }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.symbolNotFound)
    expect(error.message).toBe("symbol not found")

    client.close()
    await server.close()
  })

  test("rejects responses with excess fields instead of silently ignoring them", async () => {
    const cases = [
      { ...SAMPLE_BLAST_RESULT, extra: true },
      {
        ...SAMPLE_BLAST_RESULT,
        callers: [{ ...SAMPLE_BLAST_RESULT.callers[0], extra: 1 }, ...SAMPLE_BLAST_RESULT.callers.slice(1)],
      },
      { ...SAMPLE_BLAST_RESULT, summary: { ...SAMPLE_BLAST_RESULT.summary, risk: "critical" } },
    ]

    for (const result of cases) {
      const server = await serve(result)
      const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

      const error = await client.blastRadius({ symbol: "load" }).catch((cause) => cause)
      expect(error).toBeInstanceOf(Protocol.RpcError)
      expect(error.code).toBe(Protocol.ErrorCode.internalError)
      expect(error.message).toBe("malformed blast_radius response")

      client.close()
      await server.close()
    }
  })
})
