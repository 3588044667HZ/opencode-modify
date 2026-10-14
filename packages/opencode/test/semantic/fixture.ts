import { Protocol } from "@/semantic/protocol"

// Fixed read_view response used by the fake daemon. Crafted so `render` output
// is byte-identical to the sample in LLM-IDE-SPEC/oc-render-layer.md.
export const SAMPLE_RESULT: Protocol.ReadViewResult = {
  file: "engine.ts",
  version: "a3f9c2",
  size: { lines: 320, symbols: 6 },
  status: { modified: true, errors: 2 },
  position: { current: 43, total: 320, in_symbol: "load", remaining_symbols: 4 },
  content: [
    { line: 40, text: "def load(self, path):" },
    { line: 41, text: "    data = open(path)", diagnostic: { severity: "warning", message: "type mismatch" } },
    {
      line: 42,
      text: "    return json.load(data)",
      anchor: { symbol: "json.load", location: "json/__init__.py:120" },
    },
    { line: 43, text: "" },
    { line: 44, text: "def helper():", diagnostic: { severity: "error", message: "undefined 'config'" } },
    { line: 45, text: "    return config.value" },
  ],
  coverage: { read: [[1, 44]], unread: [[45, 320]] },
  diagnostics: [
    { line: 41, severity: "warning", message: "type mismatch" },
    { line: 44, severity: "error", message: "undefined 'config'" },
  ],
}

export const SAMPLE_RENDER = [
  "engine.ts [M, 2err, v:a3f9c2] · L1-320 · symbols: 6",
  "pos: L43/320 (13%), in load(), 4 symbols below",
  "",
  "L40  def load(self, path):",
  "L41      data = open(path)          ⚠ type mismatch",
  "L42      return json.load(data)     → def@json/__init__.py:120",
  "L43",
  "L44  def helper():                  ✖ undefined 'config'",
  "L45      return config.value",
  "",
  "read: L1-44 · unread: L45-320",
].join("\n")

// Fixed blast_radius response used by the fake daemon. Crafted so
// renderBlastRadius output is byte-identical to the sample in
// LLM-IDE-SPEC/blast_radius.md.
export const SAMPLE_BLAST_RESULT: Protocol.BlastRadiusResult = {
  symbol: "load",
  definition: { file: "engine.ts", line: 40, kind: "method" },
  callers: [
    { file: "bar.ts", line: 42, context: "handleRequest", is_test: false },
    { file: "baz.ts", line: 17, context: "retry", is_test: false },
    { file: "test_engine.py", line: 88, context: "test_load", is_test: true },
  ],
  callees: [
    { symbol: "json.load", file: "json/__init__.py", line: 120 },
    { symbol: "transform", file: "engine.ts", line: 55 },
  ],
  affected_files: ["bar.ts", "baz.ts", "engine.ts"],
  entry_points: [{ file: "qux.ts", line: 88, context: "main", reason: "reached_from_main" }],
  tests_affected: [{ file: "test_engine.py", line: 88, name: "test_load" }],
  summary: {
    callers_count: 3,
    callees_count: 2,
    files_count: 3,
    has_public_api_usage: false,
    risk: "low",
  },
}

export const SAMPLE_BLAST_RENDER = [
  "load() @ engine.ts:40 (method)",
  "  callers: 3 [bar.ts:42 handleRequest, baz.ts:17 retry, test_engine.py:88 test_load]",
  "  callees: 2 [json.load @ json/__init__.py:120, transform @ engine.ts:55]",
  "  affected: 3 files",
  "  entry: qux.ts:88 main ← reached_from_main",
  "  tests: 1 [test_engine.py::test_load]",
  "  risk: low",
].join("\n")
