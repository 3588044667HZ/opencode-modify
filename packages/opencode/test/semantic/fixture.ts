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

// Fixed edit_batch responses used by the fake daemon. Crafted so renderEditBatch
// output is byte-identical to the samples in LLM-IDE-SPEC/edit-batch.md.
export const SAMPLE_EDIT_BATCH_SUCCESS: Protocol.EditBatchSuccess = {
  file: "engine.ts",
  applied: true,
  changes_applied: 3,
  changes_total: 3,
  old_version: "a3f9c2",
  new_version: "b7e1d4",
  diagnostics_delta: { errors: -2, warnings: 0 },
  diagnostics_after: { errors: 0, warnings: 0 },
  line_changes: [
    { line: 42, action: "modified" },
    { line: 43, action: "modified" },
    { line: 44, action: "modified" },
    { line: 67, action: "modified" },
    { line: 89, action: "inserted" },
  ],
}

export const SAMPLE_EDIT_BATCH_SUCCESS_RENDER = [
  "edit_batch applied 3/3 changes",
  "  engine.ts: L42-44 (modified), L67 (modified), L89 (inserted)",
  "  diagnostics: 2 err → 0 err",
  "  version: a3f9c2 → b7e1d4",
].join("\n")

export const SAMPLE_EDIT_BATCH_FAILURE: Protocol.EditBatchFailure = {
  applied: false,
  file: "engine.ts",
  changes_total: 3,
  error: {
    code: -32011,
    message: "ANCHOR_NOT_UNIQUE",
    detail: {
      change_index: 1,
      oldString: "return json.load(data)",
      match_count: 3,
      locations: [42, 67, 89],
    },
    hint: "提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具",
  },
}

export const SAMPLE_EDIT_BATCH_FAILURE_RENDER = [
  "edit_batch FAILED: change 2/3 anchor not unique",
  '  engine.ts: "return json.load(data)" matches 3 locations [L42, L67, L89]',
  "  hint: 提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具",
].join("\n")

// Fixed verify_test responses used by the fake daemon. Crafted so
// renderVerifyTest output is byte-identical to the samples in
// LLM-IDE-SPEC/verify-test.md.
export const SAMPLE_VERIFY_SUCCESS: Protocol.VerifyTestResult = {
  command: "pytest",
  exit_code: 0,
  duration_ms: 12400,
  summary: { passed: 42, failed: 0, skipped: 3, total: 45 },
  failures: [],
  output_head: "collected 45 items",
  output_tail: "45 passed in 12.4s",
  parsed: true,
  framework: "pytest",
}

export const SAMPLE_VERIFY_SUCCESS_RENDER = [
  "verify_test pytest → PASS (12.4s)",
  "  42 passed, 0 failed, 3 skipped",
  "  exit 0",
].join("\n")

export const SAMPLE_VERIFY_FAILURE: Protocol.VerifyTestResult = {
  command: "pytest",
  exit_code: 1,
  duration_ms: 12400,
  summary: { passed: 40, failed: 2, skipped: 3, total: 45 },
  failures: [
    {
      test: "test_engine.py::test_load_invalid_path",
      file: "test_engine.py",
      line: 42,
      message: "AssertionError: expected ValueError, got None",
    },
    {
      test: "test_api.py::test_timeout",
      file: "test_api.py",
      line: 88,
      message: "TimeoutError: request took 5.2s, limit 3s",
    },
  ],
  output_head: "collected 45 items",
  output_tail: "2 failed, 40 passed, 3 skipped in 12.4s",
  parsed: true,
  framework: "pytest",
}

export const SAMPLE_VERIFY_FAILURE_RENDER = [
  "verify_test pytest → FAIL (12.4s)",
  "  40 passed, 2 failed, 3 skipped",
  "  FAILED test_engine.py::test_load_invalid_path (L42)",
  "    AssertionError: expected ValueError, got None",
  "  FAILED test_api.py::test_timeout (L88)",
  "    TimeoutError: request took 5.2s, limit 3s",
  "  exit 1",
].join("\n")

export const SAMPLE_VERIFY_UNRECOGNIZED: Protocol.VerifyTestResult = {
  command: "./custom-test.sh",
  exit_code: 1,
  duration_ms: 3000,
  summary: null,
  failures: [],
  output_head: "custom test output",
  output_tail: "...",
  parsed: false,
  framework: null,
}

export const SAMPLE_VERIFY_UNRECOGNIZED_RENDER = [
  "verify_test ./custom-test.sh → FAIL (3.0s, 未识别框架)",
  "  exit 1",
  "  output (last 20 lines):",
  "    ...",
].join("\n")
