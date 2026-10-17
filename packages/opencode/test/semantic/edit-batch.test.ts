import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { renderEditBatch } from "@/semantic/render"
import { frame, listenServer } from "./fake-server"
import {
  SAMPLE_EDIT_BATCH_FAILURE,
  SAMPLE_EDIT_BATCH_FAILURE_RENDER,
  SAMPLE_EDIT_BATCH_MISMATCH,
  SAMPLE_EDIT_BATCH_MISMATCH_FULL,
  SAMPLE_EDIT_BATCH_MISMATCH_FULL_RENDER,
  SAMPLE_EDIT_BATCH_MISMATCH_RENDER,
  SAMPLE_EDIT_BATCH_SUCCESS,
  SAMPLE_EDIT_BATCH_SUCCESS_RENDER,
} from "./fixture"

const decode = (value: unknown) => Protocol.decodeOption(Protocol.EditBatchResult, value)

const failure = (
  code: Protocol.EditBatchErrorCode,
  detail?: Protocol.EditBatchDetail,
  hint?: string,
): Protocol.EditBatchFailure => ({
  applied: false,
  file: "engine.ts",
  changes_total: 3,
  error: {
    code,
    message: `RAW_${code}`,
    ...(detail === undefined ? {} : { detail }),
    ...(hint === undefined ? {} : { hint }),
  },
})

describe("semantic edit_batch render", () => {
  test("renders the spec success sample byte for byte", () => {
    expect(renderEditBatch(SAMPLE_EDIT_BATCH_SUCCESS)).toBe(SAMPLE_EDIT_BATCH_SUCCESS_RENDER)
  })

  test("renders the spec failure sample byte for byte", () => {
    expect(renderEditBatch(SAMPLE_EDIT_BATCH_FAILURE)).toBe(SAMPLE_EDIT_BATCH_FAILURE_RENDER)
  })

  test("renders a VERSION_MISMATCH delta reconciliation byte for byte", () => {
    expect(renderEditBatch(SAMPLE_EDIT_BATCH_MISMATCH)).toBe(SAMPLE_EDIT_BATCH_MISMATCH_RENDER)
  })

  test("renders a VERSION_MISMATCH full re-read hint byte for byte", () => {
    expect(renderEditBatch(SAMPLE_EDIT_BATCH_MISMATCH_FULL)).toBe(SAMPLE_EDIT_BATCH_MISMATCH_FULL_RENDER)
  })

  test("renders a multi-line changed excerpt as an indented block and skips an empty position_map", () => {
    const result: Protocol.EditBatchResult = {
      ...SAMPLE_EDIT_BATCH_SUCCESS,
      changed: { start_line: 4, end_line: 6, text: "int count = 7;\nreturn count + 1;", truncated: false },
      position_map: [],
    }

    expect(renderEditBatch(result)).toBe(
      [
        "edit_batch applied 3/3 changes",
        "  engine.ts: L42-44 (modified), L67 (modified), L89 (inserted)",
        "  diagnostics: 2 err → 0 err",
        "  version: a3f9c2 → b7e1d4",
        "  changed: L4-6:",
        "    int count = 7;",
        "    return count + 1;",
      ].join("\n"),
    )
  })

  test("marks a truncated changed excerpt and renders a negative position_map delta without a plus sign", () => {
    const result: Protocol.EditBatchResult = {
      ...SAMPLE_EDIT_BATCH_SUCCESS,
      changed: { start_line: 10, end_line: 12, text: "x", truncated: true },
      position_map: [{ old_start: 10, old_end: 14, delta: -3 }],
    }

    expect(renderEditBatch(result).split("\n").slice(-2)).toEqual([
      "  changed: L10-12 (truncated): x",
      "  position_map: old 10-14 → delta -3",
    ])
  })

  test("merges adjacent same-action lines and keeps other runs split", () => {
    const result: Protocol.EditBatchResult = {
      ...SAMPLE_EDIT_BATCH_SUCCESS,
      line_changes: [
        { line: 3, action: "inserted" },
        { line: 4, action: "inserted" },
        { line: 5, action: "inserted" },
        { line: 9, action: "modified" },
        { line: 12, action: "deleted" },
        { line: 13, action: "deleted" },
        { line: 16, action: "deleted" },
        { line: 16, action: "inserted" },
      ],
    }

    expect(renderEditBatch(result).split("\n")[1]).toBe(
      "  engine.ts: L3-5 (inserted), L9 (modified), L12-13 (deleted), L16 (deleted), L16 (inserted)",
    )
  })

  test("does not merge descending or action-changing lines", () => {
    const result: Protocol.EditBatchResult = {
      ...SAMPLE_EDIT_BATCH_SUCCESS,
      line_changes: [
        { line: 8, action: "modified" },
        { line: 7, action: "modified" },
        { line: 8, action: "deleted" },
      ],
    }

    expect(renderEditBatch(result).split("\n")[1]).toBe("  engine.ts: L8 (modified), L7 (modified), L8 (deleted)")
  })

  test("derives the before diagnostics count from after minus delta", () => {
    const result: Protocol.EditBatchResult = {
      ...SAMPLE_EDIT_BATCH_SUCCESS,
      diagnostics_delta: { errors: 3, warnings: -1 },
      diagnostics_after: { errors: 5, warnings: 0 },
    }

    expect(renderEditBatch(result).split("\n")[2]).toBe("  diagnostics: 2 err → 5 err")
  })

  test("renders a fixed failure with no change index in two lines", () => {
    const result = failure(Protocol.EditBatchErrorCode.anchorNotFound, { oldString: "load(data)" })
    expect(renderEditBatch(result)).toBe(
      ["edit_batch FAILED: anchor not found", '  engine.ts: "load(data)" not found'].join("\n"),
    )
  })

  test("renders an anchor-not-found failure without a change index or hint", () => {
    const result: Protocol.EditBatchFailure = {
      applied: false,
      file: "engine.ts",
      changes_total: 1,
      error: { code: Protocol.EditBatchErrorCode.anchorNotFound, message: "ANCHOR_NOT_FOUND" },
    }

    expect(renderEditBatch(result)).toBe(
      ["edit_batch FAILED: anchor not found", '  engine.ts: "?" not found'].join("\n"),
    )
  })

  test("renders each error code detail shape", () => {
    const cases: Array<{ result: Protocol.EditBatchFailure; lines: string[] }> = [
      {
        result: failure(Protocol.EditBatchErrorCode.versionMismatch, { current_version: "c0ffee" }),
        lines: ["edit_batch FAILED: version mismatch", "  engine.ts: version mismatch (current c0ffee)"],
      },
      {
        result: failure(Protocol.EditBatchErrorCode.pathProtected, { path: "node_modules/engine.ts" }),
        lines: ["edit_batch FAILED: path protected", "  engine.ts: path protected"],
      },
      {
        result: failure(Protocol.EditBatchErrorCode.contentImpure, { change_index: 1, marker: "[err:" }),
        lines: [
          "edit_batch FAILED: change 2/3 content impure",
          "  engine.ts: change 2 contains render-layer metasyntax ([err:)",
        ],
      },
      {
        result: failure(Protocol.EditBatchErrorCode.writeFailed, { reason: "EACCES" }),
        lines: ["edit_batch FAILED: write failed", "  engine.ts: write failed (EACCES)"],
      },
      {
        result: failure(Protocol.EditBatchErrorCode.changeConflict, { change_index: 0, conflict_with_index: 2 }),
        lines: ["edit_batch FAILED: change 1/3 change conflict", "  engine.ts: change 1 overlaps change 3"],
      },
    ]

    for (const item of cases) expect(renderEditBatch(item.result)).toBe(item.lines.join("\n"))
  })

  test("appends the hint only when the daemon sends one", () => {
    const result = failure(Protocol.EditBatchErrorCode.anchorNotUnique, undefined, "make it unique")
    expect(renderEditBatch(result).split("\n").at(-1)).toBe("  hint: make it unique")
  })

  test("falls back to ? for a missing file", () => {
    const result: Protocol.EditBatchFailure = {
      applied: false,
      changes_total: 1,
      error: {
        code: Protocol.EditBatchErrorCode.anchorNotFound,
        message: "ANCHOR_NOT_FOUND",
        detail: { oldString: "x" },
      },
    }

    expect(renderEditBatch(result).split("\n")[1]).toBe('  ?: "x" not found')
  })

  test("renders a lock timeout byte for byte", () => {
    const result = failure(
      Protocol.EditBatchErrorCode.lockTimeout,
      { file: "engine.ts", waited_ms: 30000 },
      "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
    )
    expect(renderEditBatch(result)).toBe(
      [
        "edit_batch FAILED: lock timeout",
        "  engine.ts: lock timeout after 30000ms",
        "  hint: 文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
      ].join("\n"),
    )
  })

  test("prefers detail.file then result.file then ? for lock timeouts", () => {
    const withDetailFile = failure(Protocol.EditBatchErrorCode.lockTimeout, {
      file: "src/qux.ts",
      waited_ms: 30000,
    })
    expect(renderEditBatch(withDetailFile).split("\n")[1]).toBe("  src/qux.ts: lock timeout after 30000ms")

    const withoutDetailFile = failure(Protocol.EditBatchErrorCode.lockTimeout, { waited_ms: 30000 })
    expect(renderEditBatch(withoutDetailFile).split("\n")[1]).toBe("  engine.ts: lock timeout after 30000ms")

    const missingBoth: Protocol.EditBatchFailure = {
      applied: false,
      changes_total: 1,
      error: {
        code: Protocol.EditBatchErrorCode.lockTimeout,
        message: "LOCK_TIMEOUT",
        detail: { waited_ms: 7 },
      },
    }
    expect(renderEditBatch(missingBoth)).toBe(
      ["edit_batch FAILED: lock timeout", "  ?: lock timeout after 7ms"].join("\n"),
    )
  })

  test("omits the hint line when a lock timeout has no hint", () => {
    const result = failure(Protocol.EditBatchErrorCode.lockTimeout, { file: "engine.ts", waited_ms: 30000 })
    expect(renderEditBatch(result).split("\n")).toHaveLength(2)
  })
})

describe("semantic edit_batch decoding", () => {
  test("accepts the success and failure fixtures", () => {
    expect(decode(SAMPLE_EDIT_BATCH_SUCCESS)).toEqual(SAMPLE_EDIT_BATCH_SUCCESS)
    expect(decode(SAMPLE_EDIT_BATCH_FAILURE)).toEqual(SAMPLE_EDIT_BATCH_FAILURE)
  })

  test("accepts version, changed, position_map, and error reconciliation additions strictly", () => {
    expect(decode(SAMPLE_EDIT_BATCH_MISMATCH)).toEqual(SAMPLE_EDIT_BATCH_MISMATCH)
    expect(decode(SAMPLE_EDIT_BATCH_MISMATCH_FULL)).toEqual(SAMPLE_EDIT_BATCH_MISMATCH_FULL)
  })

  test("rejects unknown reconciliation shapes and excess position_map fields", () => {
    expect(
      decode({ ...SAMPLE_EDIT_BATCH_SUCCESS, position_map: [{ old_start: 1, old_end: 2, delta: 0, extra: 1 }] }),
    ).toBeUndefined()
    expect(
      decode({
        ...SAMPLE_EDIT_BATCH_MISMATCH_FULL,
        error: {
          ...SAMPLE_EDIT_BATCH_MISMATCH_FULL.error,
          reconciliation: { mode: "partial", current_version: "x" },
        },
      }),
    ).toBeUndefined()
    expect(
      decode({
        ...SAMPLE_EDIT_BATCH_MISMATCH,
        error: { ...SAMPLE_EDIT_BATCH_MISMATCH.error, reconciliation: { known_version: "a3f9c2" } },
      }),
    ).toBeUndefined()
  })

  test("accepts a failure result without a hint or detail", () => {
    const result: Protocol.EditBatchFailure = {
      applied: false,
      file: "engine.ts",
      changes_total: 2,
      error: { code: Protocol.EditBatchErrorCode.pathProtected, message: "PATH_PROTECTED" },
    }

    expect(decode(result)).toEqual(result)
  })

  test("strictly decodes a lock timeout failure with detail and hint", () => {
    const result: Protocol.EditBatchFailure = {
      applied: false,
      file: "engine.ts",
      changes_total: 3,
      error: {
        code: -32017,
        message: "LOCK_TIMEOUT",
        detail: { file: "engine.ts", waited_ms: 30000 },
        hint: "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
      },
    }

    expect(Protocol.EditBatchErrorCode.lockTimeout).toBe(-32017)
    expect(decode(result)).toEqual(result)
  })

  test("still rejects error codes outside the frozen range", () => {
    expect(
      decode({
        applied: false,
        file: "engine.ts",
        changes_total: 1,
        error: { code: -32018, message: "UNKNOWN" },
      }),
    ).toBeUndefined()
  })

  test("rejects excess fields at the top level and in nested objects", () => {
    const failing = SAMPLE_EDIT_BATCH_FAILURE
    const cases = [
      { ...SAMPLE_EDIT_BATCH_SUCCESS, extra: true },
      {
        ...SAMPLE_EDIT_BATCH_SUCCESS,
        diagnostics_delta: { errors: -2, warnings: 0, infos: 1 },
      },
      {
        ...SAMPLE_EDIT_BATCH_SUCCESS,
        line_changes: [{ line: 42, action: "modified", extra: 1 }],
      },
      {
        ...failing,
        error: {
          ...failing.error,
          detail: { change_index: 1, extra: true },
        },
      },
    ]

    for (const value of cases) expect(decode(value)).toBeUndefined()
  })

  test("rejects unknown line actions and unknown error codes", () => {
    expect(decode({ ...SAMPLE_EDIT_BATCH_SUCCESS, line_changes: [{ line: 1, action: "moved" }] })).toBeUndefined()
    expect(decode({ ...SAMPLE_EDIT_BATCH_SUCCESS, applied: "yes" })).toBeUndefined()
    expect(
      decode({
        applied: false,
        file: "engine.ts",
        changes_total: 1,
        error: { code: -32099, message: "UNKNOWN" },
      }),
    ).toBeUndefined()
  })
})

describe("semantic edit_batch client", () => {
  test("decodes success and failure results and forwards the request", async () => {
    const requests: any[] = []
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_batch") return
      const result = requests.length === 0 ? SAMPLE_EDIT_BATCH_SUCCESS : SAMPLE_EDIT_BATCH_FAILURE
      requests.push(message)
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })
    const input: Protocol.EditBatchRequest = {
      file: "engine.ts",
      changes: [{ oldString: "return json.load(data)", newString: "return parse(data)", description: "harden" }],
      baseVersion: "a3f9c2",
    }

    expect(await client.editBatch(input)).toEqual(SAMPLE_EDIT_BATCH_SUCCESS)
    expect(await client.editBatch(input)).toEqual(SAMPLE_EDIT_BATCH_FAILURE)
    expect(requests[0]?.method).toBe("edit_batch")
    expect(requests[0]?.params).toEqual(input)

    client.close()
    await server.close()
  })

  test("decodes VERSION_MISMATCH responses with a reconciliation payload", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_batch") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: SAMPLE_EDIT_BATCH_MISMATCH }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    expect(
      await client.editBatch({ file: "engine.ts", changes: [], baseVersion: "a3f9c2" }),
    ).toEqual(SAMPLE_EDIT_BATCH_MISMATCH)

    client.close()
    await server.close()
  })

  test("rejects malformed results instead of silently ignoring fields", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_batch") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: { ...SAMPLE_EDIT_BATCH_SUCCESS, extra: true } }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client
      .editBatch({ file: "engine.ts", changes: [], baseVersion: "a3f9c2" })
      .catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.internalError)
    expect(error.message).toBe("malformed edit_batch response")

    client.close()
    await server.close()
  })

  test("maps JSON-RPC error responses to typed RpcError", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method === "edit_batch") {
        socket.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "internal error" } }))
      }
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client
      .editBatch({ file: "engine.ts", changes: [], baseVersion: "a3f9c2" })
      .catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.internalError)

    client.close()
    await server.close()
  })
})
