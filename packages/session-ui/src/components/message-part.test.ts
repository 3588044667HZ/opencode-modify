import { describe, expect, test } from "bun:test"
import { readPartText, peerMeta } from "./message-part-text"

describe("peerMeta", () => {
  test("returns undefined without peer metadata", () => {
    expect(peerMeta({})).toBeUndefined()
    expect(peerMeta({ metadata: {} })).toBeUndefined()
    expect(peerMeta({ metadata: { peer: "not-an-object" } })).toBeUndefined()
    expect(peerMeta({ metadata: { peer: [] } })).toBeUndefined()
  })

  test("extracts known peer fields and ignores the rest", () => {
    expect(peerMeta({ metadata: { peer: { from: "ses_a", fromAgent: "coder", kind: "note", hop: 2, extra: 1 } } })).toEqual({
      from: "ses_a",
      fromAgent: "coder",
      kind: "note",
      hop: 2,
    })
  })

  test("keeps only fields with the expected type", () => {
    expect(peerMeta({ metadata: { peer: { from: 1, fromAgent: "coder", hop: "2" } } })).toEqual({ fromAgent: "coder" })
  })
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})
