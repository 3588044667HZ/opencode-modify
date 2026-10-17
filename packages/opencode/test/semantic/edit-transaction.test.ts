import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { renderEditTransaction } from "@/semantic/render"
import { frame, listenServer } from "./fake-server"
import {
  SAMPLE_EDIT_TRANSACTION_FAILURE,
  SAMPLE_EDIT_TRANSACTION_FAILURE_RENDER,
  SAMPLE_EDIT_TRANSACTION_MISMATCH,
  SAMPLE_EDIT_TRANSACTION_MISMATCH_RENDER,
  SAMPLE_EDIT_TRANSACTION_SUCCESS,
  SAMPLE_EDIT_TRANSACTION_SUCCESS_RENDER,
} from "./fixture"

const decode = (value: unknown) => Protocol.decodeOption(Protocol.EditTransactionResult, value)

const failure = (
  code: Protocol.EditTransactionErrorCode,
  detail?: Protocol.EditTransactionDetail,
  hint?: string,
): Protocol.EditTransactionFailure => ({
  applied: false,
  error: {
    code,
    message: `RAW_${code}`,
    ...(detail === undefined ? {} : { detail }),
    ...(hint === undefined ? {} : { hint }),
  },
})

describe("semantic edit_transaction render", () => {
  test("renders the spec success sample byte for byte", () => {
    expect(renderEditTransaction(SAMPLE_EDIT_TRANSACTION_SUCCESS)).toBe(SAMPLE_EDIT_TRANSACTION_SUCCESS_RENDER)
  })

  test("renders the spec failure sample byte for byte", () => {
    expect(renderEditTransaction(SAMPLE_EDIT_TRANSACTION_FAILURE)).toBe(SAMPLE_EDIT_TRANSACTION_FAILURE_RENDER)
  })

  test("renders a VERSION_MISMATCH delta reconciliation byte for byte", () => {
    expect(renderEditTransaction(SAMPLE_EDIT_TRANSACTION_MISMATCH)).toBe(SAMPLE_EDIT_TRANSACTION_MISMATCH_RENDER)
  })

  test("renders a full re-read hint with the rollback notice last", () => {
    const result: Protocol.EditTransactionFailure = {
      applied: false,
      error: {
        code: Protocol.EditTransactionErrorCode.versionMismatch,
        message: "VERSION_MISMATCH",
        detail: { file: "engine.ts", current_version: "b7e1d4" },
        reconciliation: { mode: "full", current_version: "b7e1d4" },
      },
    }

    expect(renderEditTransaction(result)).toBe(
      [
        "edit_transaction FAILED: version mismatch in engine.ts",
        "  version mismatch (current b7e1d4)",
        "  reconciliation: full re-read required (current v:b7e1d4)",
        "  所有文件均未修改",
      ].join("\n"),
    )
  })

  test("merges consecutive lines ignoring action and keeps other runs split", () => {
    const result: Protocol.EditTransactionResult = {
      ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
      files_changed: 1,
      changes_applied: 3,
      changes_total: 3,
      files: [
        {
          file: "engine.ts",
          old_version: "a3f9c2",
          new_version: "b7e1d4",
          changes_applied: 3,
          line_changes: [
            { line: 3, action: "inserted" },
            { line: 4, action: "deleted" },
            { line: 5, action: "modified" },
            { line: 9, action: "modified" },
          ],
        },
      ],
      diagnostics_delta: {},
      diagnostics_after: {},
    }

    expect(renderEditTransaction(result)).toBe(
      ["edit_transaction applied 3/3 changes across 1 files", "  engine.ts:  L3-5, L9 (3 changes)"].join("\n"),
    )
  })

  test("does not merge descending or repeated lines", () => {
    const result: Protocol.EditTransactionResult = {
      ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
      files_changed: 1,
      changes_applied: 2,
      changes_total: 2,
      files: [
        {
          file: "engine.ts",
          old_version: "a3f9c2",
          new_version: "b7e1d4",
          changes_applied: 2,
          line_changes: [
            { line: 8, action: "modified" },
            { line: 6, action: "modified" },
            { line: 8, action: "deleted" },
          ],
        },
      ],
      diagnostics_delta: {},
      diagnostics_after: {},
    }

    expect(renderEditTransaction(result).split("\n")[1]).toBe("  engine.ts:  L8, L6, L8 (2 changes)")
  })

  test("renders a dash for a file without line_changes", () => {
    const result: Protocol.EditTransactionResult = {
      applied: true,
      files_changed: 1,
      changes_applied: 1,
      changes_total: 1,
      files: [{ file: "engine.ts", old_version: "a3f9c2", new_version: "b7e1d4", changes_applied: 1 }],
      diagnostics_delta: {},
      diagnostics_after: {},
    }

    expect(renderEditTransaction(result)).toBe(
      ["edit_transaction applied 1/1 changes across 1 files", "  engine.ts:  - (1 changes)"].join("\n"),
    )
  })

  test("appends warnings only when the warning delta is non-zero and skips zero deltas", () => {
    const result: Protocol.EditTransactionResult = {
      ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
      diagnostics_delta: {
        "src/core/engine.ts": { errors: 0, warnings: 2 },
        "src/api/routes.ts": { errors: 0, warnings: 0 },
      },
      diagnostics_after: {
        "src/core/engine.ts": { errors: 1, warnings: 5 },
        "src/api/routes.ts": { errors: 3, warnings: 1 },
      },
    }

    expect(renderEditTransaction(result).split("\n").at(-1)).toBe(
      "  diagnostics: 1 err → 1 err, 3 warn → 5 warn (engine.ts)",
    )
  })

  test("renders a lock timeout byte for byte", () => {
    const result = failure(
      Protocol.EditTransactionErrorCode.lockTimeout,
      { file: "src/qux.ts", waited_ms: 30000 },
      "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
    )
    expect(renderEditTransaction(result)).toBe(
      [
        "edit_transaction FAILED: lock timeout in src/qux.ts",
        "  lock timeout after 30000ms",
        "  hint: 文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
        "  所有文件均未修改",
      ].join("\n"),
    )
  })

  test("renders a duplicate file failure byte for byte", () => {
    const result = failure(Protocol.EditTransactionErrorCode.duplicateFile, { file: "src/core/engine.ts" })
    expect(renderEditTransaction(result)).toBe(
      [
        "edit_transaction FAILED: duplicate file in src/core/engine.ts",
        "  duplicate file src/core/engine.ts",
        "  所有文件均未修改",
      ].join("\n"),
    )
  })

  test("renders each error code detail shape", () => {
    const cases: Array<{ result: Protocol.EditTransactionFailure; lines: string[] }> = [
      {
        result: failure(Protocol.EditTransactionErrorCode.anchorNotFound, {
          file: "engine.ts",
          oldString: "load(data)",
        }),
        lines: [
          "edit_transaction FAILED: anchor not found in engine.ts",
          '  "load(data)" not found',
          "  所有文件均未修改",
        ],
      },
      {
        result: failure(Protocol.EditTransactionErrorCode.versionMismatch, {
          file: "engine.ts",
          current_version: "c0ffee",
        }),
        lines: [
          "edit_transaction FAILED: version mismatch in engine.ts",
          "  version mismatch (current c0ffee)",
          "  所有文件均未修改",
        ],
      },
      {
        result: failure(Protocol.EditTransactionErrorCode.pathProtected, { file: "node_modules/engine.ts" }),
        lines: [
          "edit_transaction FAILED: path protected in node_modules/engine.ts",
          "  path protected",
          "  所有文件均未修改",
        ],
      },
      {
        result: failure(Protocol.EditTransactionErrorCode.contentImpure, {
          file: "engine.ts",
          change_index: 1,
          changes_total: 3,
          marker: "[err:",
        }),
        lines: [
          "edit_transaction FAILED: content impure in engine.ts (change 2/3)",
          "  change 2 contains render-layer metasyntax ([err:)",
          "  所有文件均未修改",
        ],
      },
      {
        result: failure(Protocol.EditTransactionErrorCode.changeConflict, {
          file: "engine.ts",
          change_index: 0,
          changes_total: 3,
          conflict_with_index: 2,
        }),
        lines: [
          "edit_transaction FAILED: change conflict in engine.ts (change 1/3)",
          "  change 1 overlaps change 3",
          "  所有文件均未修改",
        ],
      },
    ]

    for (const item of cases) expect(renderEditTransaction(item.result)).toBe(item.lines.join("\n"))
  })

  test("falls back to the daemon message for a write failure without a human mapping", () => {
    const result = failure(Protocol.EditTransactionErrorCode.writeFailed)
    expect(renderEditTransaction(result)).toBe(
      ["edit_transaction FAILED: RAW_-32015", "  RAW_-32015", "  所有文件均未修改"].join("\n"),
    )
  })

  test("falls back to ? for missing detail fields", () => {
    expect(renderEditTransaction(failure(Protocol.EditTransactionErrorCode.lockTimeout))).toBe(
      ["edit_transaction FAILED: lock timeout", "  lock timeout after ?ms", "  所有文件均未修改"].join("\n"),
    )
    expect(renderEditTransaction(failure(Protocol.EditTransactionErrorCode.anchorNotUnique))).toBe(
      [
        "edit_transaction FAILED: anchor not unique",
        '  "?" matches ? locations []',
        "  所有文件均未修改",
      ].join("\n"),
    )
    const incompleteChange = failure(Protocol.EditTransactionErrorCode.versionMismatch, {
      file: "engine.ts",
      change_index: 1,
    })
    expect(renderEditTransaction(incompleteChange).split("\n")[0]).toBe(
      "edit_transaction FAILED: version mismatch in engine.ts (change 2/?)",
    )
  })

  test("always ends failures with the rollback notice and omits the hint when absent", () => {
    const result = failure(Protocol.EditTransactionErrorCode.duplicateFile, { file: "engine.ts" })
    const lines = renderEditTransaction(result).split("\n")
    expect(lines).toHaveLength(3)
    expect(lines.at(-1)).toBe("  所有文件均未修改")
  })
})

describe("semantic edit_transaction decoding", () => {
  test("accepts the success and failure fixtures", () => {
    expect(decode(SAMPLE_EDIT_TRANSACTION_SUCCESS)).toEqual(SAMPLE_EDIT_TRANSACTION_SUCCESS)
    expect(decode(SAMPLE_EDIT_TRANSACTION_FAILURE)).toEqual(SAMPLE_EDIT_TRANSACTION_FAILURE)
  })

  test("accepts per-file additions and an error reconciliation payload", () => {
    expect(decode(SAMPLE_EDIT_TRANSACTION_MISMATCH)).toEqual(SAMPLE_EDIT_TRANSACTION_MISMATCH)
    expect(decode(SAMPLE_EDIT_TRANSACTION_SUCCESS)).toEqual(SAMPLE_EDIT_TRANSACTION_SUCCESS)
    const files = SAMPLE_EDIT_TRANSACTION_SUCCESS.files
    expect(files[0]?.version).toBe("b7e1d4")
    expect(files[0]?.position_map).toHaveLength(2)
  })

  test("rejects unknown reconciliation shapes on transaction errors", () => {
    expect(
      decode({
        ...SAMPLE_EDIT_TRANSACTION_MISMATCH,
        error: {
          ...SAMPLE_EDIT_TRANSACTION_MISMATCH.error,
          reconciliation: { mode: "delta" },
        },
      }),
    ).toBeUndefined()
    expect(
      decode({
        ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
        files: [{ ...SAMPLE_EDIT_TRANSACTION_SUCCESS.files[0], position_map: [{ old_start: 1, old_end: 1 }] }],
      }),
    ).toBeUndefined()
  })

  test("accepts a failure result without a hint or detail", () => {
    const result: Protocol.EditTransactionFailure = {
      applied: false,
      error: { code: Protocol.EditTransactionErrorCode.pathProtected, message: "PATH_PROTECTED" },
    }

    expect(decode(result)).toEqual(result)
  })

  test("accepts lock timeout and duplicate file codes", () => {
    expect(Protocol.EditTransactionErrorCode.lockTimeout).toBe(-32017)
    expect(Protocol.EditTransactionErrorCode.duplicateFile).toBe(-32019)
    expect(decode(failure(Protocol.EditTransactionErrorCode.lockTimeout, { file: "engine.ts", waited_ms: 7 }))).toEqual(
      failure(Protocol.EditTransactionErrorCode.lockTimeout, { file: "engine.ts", waited_ms: 7 }),
    )
    expect(decode(failure(Protocol.EditTransactionErrorCode.duplicateFile, { file: "engine.ts" }))).toEqual(
      failure(Protocol.EditTransactionErrorCode.duplicateFile, { file: "engine.ts" }),
    )
  })

  test("rejects excess fields at the top level and in nested objects", () => {
    const cases = [
      { ...SAMPLE_EDIT_TRANSACTION_SUCCESS, extra: true },
      {
        ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
        files: [{ ...SAMPLE_EDIT_TRANSACTION_SUCCESS.files[0], extra: true }],
      },
      {
        ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
        files: [{ ...SAMPLE_EDIT_TRANSACTION_SUCCESS.files[0], line_changes: [{ line: 1, action: "modified", extra: 1 }] }],
      },
      {
        ...SAMPLE_EDIT_TRANSACTION_SUCCESS,
        diagnostics_delta: { "src/core/engine.ts": { errors: -2, warnings: 0, infos: 1 } },
      },
      { ...SAMPLE_EDIT_TRANSACTION_FAILURE, extra: true },
      {
        ...SAMPLE_EDIT_TRANSACTION_FAILURE,
        error: { ...SAMPLE_EDIT_TRANSACTION_FAILURE.error, detail: { change_index: 1, extra: true } },
      },
    ]

    for (const value of cases) expect(decode(value)).toBeUndefined()
  })

  test("rejects unknown error codes, the RPC-only journal code, and bad discriminators", () => {
    expect(
      decode({ applied: false, error: { code: -32018, message: "JOURNAL_RECOVERY_FAILED" } }),
    ).toBeUndefined()
    expect(decode({ applied: false, error: { code: -32099, message: "UNKNOWN" } })).toBeUndefined()
    expect(decode({ applied: false, error: { code: -32010, message: "ANCHOR_NOT_FOUND" }, file: "engine.ts" })).toBeUndefined()
    expect(decode({ ...SAMPLE_EDIT_TRANSACTION_SUCCESS, applied: "yes" })).toBeUndefined()
  })
})

describe("semantic edit_transaction describeError", () => {
  test("maps -32018 to the read-only journal message", () => {
    expect(Protocol.ErrorCode.journalRecoveryFailed).toBe(-32018)
    const error = new Protocol.RpcError({ code: -32018, message: "JOURNAL_RECOVERY_FAILED" })
    expect(Protocol.describeError(error)).toBe(
      "semantic writes are disabled: journal recovery failed (human intervention required)",
    )
  })
})

describe("semantic edit_transaction client", () => {
  const input: Protocol.EditTransactionRequest = {
    changes: [
      {
        file: "src/core/engine.ts",
        baseVersion: "a3f9c2",
        changes: [{ oldString: "return json.load(data)", newString: "return parse(data)", description: "harden" }],
      },
      {
        file: "src/api/routes.ts",
        baseVersion: "c1d2e3",
        changes: [{ oldString: "router.get", newString: "router.post" }],
      },
    ],
    options: { lock_timeout_ms: 5_000 },
  }

  test("decodes success and failure results and forwards the request", async () => {
    const requests: any[] = []
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_transaction") return
      const result = requests.length === 0 ? SAMPLE_EDIT_TRANSACTION_SUCCESS : SAMPLE_EDIT_TRANSACTION_FAILURE
      requests.push(message)
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    expect(await client.editTransaction(input)).toEqual(SAMPLE_EDIT_TRANSACTION_SUCCESS)
    expect(await client.editTransaction(input)).toEqual(SAMPLE_EDIT_TRANSACTION_FAILURE)
    expect(requests[0]?.method).toBe("edit_transaction")
    expect(requests[0]?.params).toEqual(input)

    client.close()
    await server.close()
  })

  test("decodes VERSION_MISMATCH responses with a reconciliation payload", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_transaction") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: SAMPLE_EDIT_TRANSACTION_MISMATCH }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    expect(await client.editTransaction(input)).toEqual(SAMPLE_EDIT_TRANSACTION_MISMATCH)

    client.close()
    await server.close()
  })

  test("rejects malformed results instead of silently ignoring fields", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_transaction") return
      socket.write(
        frame({ jsonrpc: "2.0", id: message.id, result: { ...SAMPLE_EDIT_TRANSACTION_SUCCESS, extra: true } }),
      )
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.editTransaction(input).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.internalError)
    expect(error.message).toBe("malformed edit_transaction response")

    client.close()
    await server.close()
  })

  test("maps the -32018 RPC error and explains it as a read-only gate", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "edit_transaction") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32018, message: "JOURNAL_RECOVERY_FAILED" } }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.editTransaction(input).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(-32018)
    expect(Protocol.describeError(error)).toBe(
      "semantic writes are disabled: journal recovery failed (human intervention required)",
    )

    client.close()
    await server.close()
  })
})
