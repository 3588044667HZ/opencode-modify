import { describe, expect, test } from "bun:test"
import * as Protocol from "@/semantic/protocol"
import { render } from "@/semantic/render"
import {
  SAMPLE_READ_DELTA,
  SAMPLE_READ_DELTA_RENDER,
  SAMPLE_READ_RECONCILE_FULL,
  SAMPLE_READ_RECONCILE_FULL_RENDER,
  SAMPLE_READ_WARNINGS,
  SAMPLE_READ_WARNINGS_RENDER,
  SAMPLE_RENDER,
  SAMPLE_RESULT,
  SAMPLE_RESULT_UNCHANGED,
  SAMPLE_RESULT_UNCHANGED_RENDER,
} from "./fixture"

describe("semantic render", () => {
  test("renders the spec sample byte for byte", () => {
    expect(render(SAMPLE_RESULT)).toBe(SAMPLE_RENDER)
  })

  test("renders the unchanged micro response", () => {
    expect(render(SAMPLE_RESULT_UNCHANGED)).toBe(SAMPLE_RESULT_UNCHANGED_RENDER)
  })

  test("renders a bounded delta with hunk markers instead of the content", () => {
    expect(render(SAMPLE_READ_DELTA)).toBe(SAMPLE_READ_DELTA_RENDER)
  })

  test("appends the full-view reconciliation note after the content", () => {
    expect(render(SAMPLE_READ_RECONCILE_FULL)).toBe(SAMPLE_READ_RECONCILE_FULL_RENDER)
  })

  test("renders degradation warnings as the final warning line", () => {
    expect(render(SAMPLE_READ_WARNINGS)).toBe(SAMPLE_READ_WARNINGS_RENDER)
  })

  test("omits position, diagnostics, anchors, and empty coverage", () => {
    const result: Protocol.ReadViewResult = {
      file: "a.py",
      version: "v1",
      size: { lines: 3, symbols: 0 },
      status: { modified: false, errors: 0 },
      content: [
        { line: 1, text: "x = 1" },
        { line: 2, text: "y = 2" },
        { line: 3, text: "" },
      ],
      coverage: { read: [[1, 3]], unread: [] },
      diagnostics: [],
    }

    expect(render(result)).toBe(["a.py [v:v1] · L1-3 · symbols: 0", "", "L1  x = 1", "L2  y = 2", "L3", "", "read: L1-3"].join("\n"))
  })

  test("falls back to top-level diagnostics and aligns annotations at column 36", () => {
    const result: Protocol.ReadViewResult = {
      file: "b.py",
      version: "v2",
      size: { lines: 2, symbols: 1 },
      status: { modified: true, errors: 0 },
      position: { current: 2, total: 2, remaining_symbols: 0 },
      content: [
        { line: 1, text: "y = 2", anchor: { symbol: "y", location: "b.py:1" } },
        { line: 2, text: "return y" },
      ],
      coverage: { read: [[1, 2]], unread: [] },
      diagnostics: [{ line: 2, severity: "warning", message: "unused" }],
    }

    const lines = render(result).split("\n")
    expect(lines[0]).toBe("b.py [M, v:v2] · L1-2 · symbols: 1")
    expect(lines[1]).toBe("pos: L2/2 (100%), module scope, 0 symbols below")
    expect(lines[3]).toBe("L1  y = 2" + " ".repeat(36 - "L1  y = 2".length) + "→ def@b.py:1")
    expect(lines[4]).toContain("L2  return y")
    expect(lines[4]!.indexOf("⚠ unused")).toBe(36)
  })

  test("renders the entry outline before content", () => {
    const result: Protocol.ReadViewResult = {
      ...SAMPLE_RESULT,
      outline: [
        { name: "load", line: 40, kind: "method" },
        { name: "helper", line: 44, kind: "method" },
      ],
      outline_total: 5,
    }

    const lines = render(result).split("\n")
    expect(lines[1]).toBe("pos: L43/320 (13%), in load(), 4 symbols below")
    expect(lines[2]).toBe("outline: L40 method load, L44 method helper (+3 more)")
  })

  test("labels a position outside any symbol as module scope", () => {
    const result: Protocol.ReadViewResult = {
      ...SAMPLE_RESULT,
      position: { current: 1, total: 320, remaining_symbols: 2 },
    }

    expect(render(result).split("\n")[1]).toBe("pos: L1/320 (0%), module scope, 2 symbols below")
  })

  test("renders multiple coverage ranges", () => {
    const result: Protocol.ReadViewResult = {
      file: "c.py",
      version: "v3",
      size: { lines: 10, symbols: 1 },
      status: { modified: false, errors: 1 },
      content: [{ line: 1, text: "x", diagnostic: { severity: "error", message: "boom" } }],
      coverage: {
        read: [
          [1, 2],
          [5, 6],
        ],
        unread: [[3, 4], [7, 10]],
      },
      diagnostics: [{ line: 1, severity: "error", message: "boom" }],
    }

    expect(render(result).endsWith("read: L1-2, L5-6 · unread: L3-4, L7-10")).toBe(true)
    expect(render(result).split("\n")[0]).toBe("c.py [1err, v:v3] · L1-10 · symbols: 1")
  })
})
