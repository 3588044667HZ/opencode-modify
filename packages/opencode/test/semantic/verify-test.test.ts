import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { renderVerifyTest } from "@/semantic/render"
import { frame, listenServer } from "./fake-server"
import {
  SAMPLE_VERIFY_FAILURE,
  SAMPLE_VERIFY_FAILURE_RENDER,
  SAMPLE_VERIFY_SUCCESS,
  SAMPLE_VERIFY_SUCCESS_RENDER,
  SAMPLE_VERIFY_UNRECOGNIZED,
  SAMPLE_VERIFY_UNRECOGNIZED_RENDER,
} from "./fixture"

const decode = (value: unknown) => Protocol.decodeOption(Protocol.VerifyTestResult, value)

describe("semantic verify_test render", () => {
  test("renders the spec success sample byte for byte", () => {
    expect(renderVerifyTest(SAMPLE_VERIFY_SUCCESS)).toBe(SAMPLE_VERIFY_SUCCESS_RENDER)
  })

  test("renders the spec failure sample byte for byte", () => {
    expect(renderVerifyTest(SAMPLE_VERIFY_FAILURE)).toBe(SAMPLE_VERIFY_FAILURE_RENDER)
  })

  test("renders the spec unrecognized sample byte for byte", () => {
    expect(renderVerifyTest(SAMPLE_VERIFY_UNRECOGNIZED)).toBe(SAMPLE_VERIFY_UNRECOGNIZED_RENDER)
  })

  test("renders a timeout headline, exit -1, and the output tail", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_UNRECOGNIZED,
      command: "pytest",
      duration_ms: 3000,
      timeout: true,
      output_tail: "line one\nline two",
    }

    expect(renderVerifyTest(result)).toBe(
      [
        "verify_test pytest → TIMEOUT (3.0s)",
        "  exit -1",
        "  output (last 20 lines):",
        "    line one",
        "    line two",
      ].join("\n"),
    )
  })

  test("keeps only the last 20 output lines and indents blank lines", () => {
    const tail = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`)
    tail[22] = ""
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_UNRECOGNIZED,
      output_tail: tail.join("\n"),
    }

    const lines = renderVerifyTest(result).split("\n")
    expect(lines.slice(0, 3)).toEqual([
      "verify_test ./custom-test.sh → FAIL (3.0s, 未识别框架)",
      "  exit 1",
      "  output (last 20 lines):",
    ])
    expect(lines.slice(3)).toEqual([
      ...tail.slice(-20).map((line) => `    ${line}`),
    ])
    expect(lines).toContain("    ")
  })

  test("indents every line of a multi-line failure message", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_FAILURE,
      summary: { passed: 40, failed: 1, skipped: 3, total: 44 },
      failures: [{ test: "test_engine.py::test_load", line: 5, message: "first line\nsecond line" }],
    }

    expect(renderVerifyTest(result)).toBe(
      [
        "verify_test pytest → FAIL (12.4s)",
        "  40 passed, 1 failed, 3 skipped",
        "  FAILED test_engine.py::test_load (L5)",
        "    first line",
        "    second line",
        "  exit 1",
      ].join("\n"),
    )
  })

  test("omits the file/line and message parts when they are absent", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_FAILURE,
      summary: { passed: 44, failed: 1, skipped: 0, total: 45 },
      failures: [{ test: "test_engine.py::test_load", file: "test_engine.py" }],
    }

    expect(renderVerifyTest(result)).toBe(
      [
        "verify_test pytest → FAIL (12.4s)",
        "  44 passed, 1 failed, 0 skipped",
        "  FAILED test_engine.py::test_load",
        "  exit 1",
      ].join("\n"),
    )
  })

  test("appends the truncated failures footer before the exit line", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_FAILURE,
      total_failures: 22,
    }

    const lines = renderVerifyTest(result).split("\n")
    expect(lines.at(-2)).toBe("  (+20 more failures, total 22)")
    expect(lines.at(-1)).toBe("  exit 1")
  })

  test("renders (无输出) when the output tail is empty", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_UNRECOGNIZED,
      output_tail: "",
    }

    expect(renderVerifyTest(result)).toBe(
      [
        "verify_test ./custom-test.sh → FAIL (3.0s, 未识别框架)",
        "  exit 1",
        "  output (last 20 lines):",
        "    (无输出)",
      ].join("\n"),
    )
  })

  test("omits the summary line when summary is null and supports pass without a framework", () => {
    const result: Protocol.VerifyTestResult = {
      command: "make check",
      exit_code: 0,
      duration_ms: 900,
      summary: null,
      failures: [],
      output_head: "",
      output_tail: "ok\n",
      parsed: false,
      framework: null,
    }

    expect(renderVerifyTest(result)).toBe(
      [
        "verify_test make check → PASS (0.9s, 未识别框架)",
        "  exit 0",
        "  output (last 20 lines):",
        "    ok",
        "    ",
      ].join("\n"),
    )
  })
})

describe("semantic verify_test decoding", () => {
  test("accepts the success, failure, and unrecognized fixtures", () => {
    expect(decode(SAMPLE_VERIFY_SUCCESS)).toEqual(SAMPLE_VERIFY_SUCCESS)
    expect(decode(SAMPLE_VERIFY_FAILURE)).toEqual(SAMPLE_VERIFY_FAILURE)
    expect(decode(SAMPLE_VERIFY_UNRECOGNIZED)).toEqual(SAMPLE_VERIFY_UNRECOGNIZED)
  })

  test("accepts optional timeout and total_failures fields", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_FAILURE,
      timeout: false,
      total_failures: 2,
    }

    expect(decode(result)).toEqual(result)
  })

  test("accepts a failure with only the test field", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_FAILURE,
      failures: [{ test: "test_api.py::test_timeout" }],
    }

    expect(decode(result)).toEqual(result)
  })

  test("rejects excess fields at the top level and inside nested objects", () => {
    const cases = [
      { ...SAMPLE_VERIFY_SUCCESS, extra: true },
      { ...SAMPLE_VERIFY_SUCCESS, summary: { passed: 42, failed: 0, skipped: 3, total: 45, infos: 0 } },
      { ...SAMPLE_VERIFY_FAILURE, failures: [{ ...SAMPLE_VERIFY_FAILURE.failures[0], output: "raw" }] },
      { ...SAMPLE_VERIFY_UNRECOGNIZED, environment: { CI: "1" } },
    ]

    for (const value of cases) expect(decode(value)).toBeUndefined()
  })

  test("rejects wrong field types and missing required fields", () => {
    const cases = [
      { ...SAMPLE_VERIFY_SUCCESS, exit_code: "0" },
      { ...SAMPLE_VERIFY_SUCCESS, parsed: 1 },
      { ...SAMPLE_VERIFY_SUCCESS, timeout: "yes" },
      { ...SAMPLE_VERIFY_SUCCESS, summary: undefined },
      { ...SAMPLE_VERIFY_SUCCESS, framework: undefined },
      { ...SAMPLE_VERIFY_FAILURE, failures: [{ line: 42 }] },
    ]

    for (const value of cases) expect(decode(value)).toBeUndefined()
  })

  test("accepts a timeout result without a summary", () => {
    const result: Protocol.VerifyTestResult = {
      ...SAMPLE_VERIFY_UNRECOGNIZED,
      timeout: true,
    }

    expect(decode(result)).toEqual(result)
  })
})

describe("semantic verify_test client", () => {
  test("decodes results and forwards the request", async () => {
    const requests: any[] = []
    const server = await listenServer((message, socket) => {
      if (message.method !== "verify_test") return
      requests.push(message)
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: SAMPLE_VERIFY_SUCCESS }))
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })
    const input: Protocol.VerifyTestRequest = {
      command: "pytest",
      options: { cwd: "src", timeout_ms: 1_000, env: { CI: "1" } },
    }

    expect(await client.verifyTest(input)).toEqual(SAMPLE_VERIFY_SUCCESS)
    expect(requests[0]?.method).toBe("verify_test")
    expect(requests[0]?.params).toEqual(input)

    client.close()
    await server.close()
  })

  test("rejects malformed results instead of silently ignoring fields", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "verify_test") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: { ...SAMPLE_VERIFY_SUCCESS, extra: true } }))
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })

    const error = await client.verifyTest({ command: "pytest" }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.internalError)
    expect(error.message).toBe("malformed verify_test response")

    client.close()
    await server.close()
  })

  test("maps JSON-RPC protection and parameter errors to typed RpcError", async () => {
    const codes = [-32013, -32001, -32603]
    let index = 0
    const server = await listenServer((message, socket) => {
      if (message.method !== "verify_test") return
      const code = codes[index++] ?? Protocol.ErrorCode.internalError
      socket.write(frame({ jsonrpc: "2.0", id: message.id, error: { code, message: `rpc ${code}` } }))
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })

    for (const code of codes) {
      const error = await client.verifyTest({ command: "pytest" }).catch((cause) => cause)
      expect(error).toBeInstanceOf(Protocol.RpcError)
      expect(error.code).toBe(code)
      expect(error.message).toBe(`rpc ${code}`)
    }

    client.close()
    await server.close()
  })
})
