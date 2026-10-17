import { Protocol } from "@/semantic/protocol"

// Fixed read_view response used by the fake daemon. Crafted so `render` output
// is byte-identical to the sample in LLM-IDE-SPEC/oc-render-layer.md.
export const SAMPLE_RESULT: Protocol.ReadViewContent = {
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

// Reconcile fixtures: unchanged micro response, bounded delta, and the
// large-change fallback marked by reconciliation.mode=full.
export const SAMPLE_RESULT_UNCHANGED: Protocol.ReadViewUnchanged = { unchanged: true, version: "a3f9c2" }

export const SAMPLE_RESULT_UNCHANGED_RENDER = "read_view: unchanged (v:a3f9c2)"

export const SAMPLE_DELTA: Protocol.ReconciliationDelta = {
  mode: "delta",
  from_version: "a3f9c2",
  to_version: "b7e1d4",
  hunks: [
    {
      lines: [
        { op: "context", old_line: 40, new_line: 40, text: "def load(self, path):" },
        { op: "removed", old_line: 41, text: "    data = open(path)" },
        { op: "added", new_line: 41, text: '    data = open(path, "rb")' },
        { op: "context", old_line: 42, new_line: 42, text: "    return json.load(data)" },
      ],
    },
    {
      lines: [
        { op: "removed", old_line: 60, text: "def stale():" },
        { op: "added", new_line: 61, text: "def fresh():" },
      ],
    },
  ],
}

export const SAMPLE_READ_DELTA: Protocol.ReadViewDeltaView = {
  file: "engine.ts",
  version: "b7e1d4",
  reconciliation: SAMPLE_DELTA,
}

export const SAMPLE_READ_DELTA_RENDER = [
  "engine.ts [v:b7e1d4]",
  "delta: v:a3f9c2 → v:b7e1d4 (2 hunks)",
  "  @@ old L40-42 → new L40-42 @@",
  "    L40  def load(self, path):",
  "  - L41      data = open(path)",
  '  + L41      data = open(path, "rb")',
  "    L42      return json.load(data)",
  "  @@ old L60-60 → new L61-61 @@",
  "  - L60  def stale():",
  "  + L61  def fresh():",
].join("\n")

export const SAMPLE_READ_RECONCILE_FULL: Protocol.ReadViewContent = {
  ...SAMPLE_RESULT,
  version: "b7e1d4",
  reconciliation: { mode: "full" },
}

export const SAMPLE_READ_RECONCILE_FULL_RENDER = `${SAMPLE_RENDER.replace("v:a3f9c2", "v:b7e1d4")}\nreconciliation: full view (delta too large)`

// 不完整发行版（content module 实现 jar 缺失）下的降级视图：分析节省略并带 warnings，
// 内容/位置/覆盖/版本仍完整。
export const SAMPLE_READ_WARNINGS: Protocol.ReadViewContent = {
  file: "engine.ts",
  version: "c8d2e6",
  size: { lines: 320, symbols: 0 },
  status: { modified: false, errors: 0 },
  position: { current: 1, total: 320, remaining_symbols: 0 },
  content: [{ line: 1, text: "def load(self, path):" }],
  coverage: { read: [[1, 1]], unread: [[2, 320]] },
  diagnostics: [],
  warnings: [
    "analysis unavailable: RuntimeException: com.intellij.pycharm.community.ide.impl.PyProjectScopeBuilder",
  ],
}

export const SAMPLE_READ_WARNINGS_RENDER = [
  "engine.ts [v:c8d2e6] · L1-320 · symbols: 0",
  "pos: L1/320 (0%), 0 symbols below",
  "",
  "L1  def load(self, path):",
  "",
  "read: L1-1 · unread: L2-320",
  "warning: analysis unavailable: RuntimeException: com.intellij.pycharm.community.ide.impl.PyProjectScopeBuilder",
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
  version: "b7e1d4",
  changed: { start_line: 42, end_line: 44, text: "return parse(data)", truncated: false },
  position_map: [
    { old_start: 42, old_end: 44, delta: 0 },
    { old_start: 89, old_end: 89, delta: 1 },
  ],
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
  "  changed: L42-44: return parse(data)",
  "  position_map: old 42-44 → delta +0, old 89-89 → delta +1",
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

// VERSION_MISMATCH 对账载荷：delta（命中已服务视图缓存）与 full（缓存未命中）。
export const SAMPLE_EDIT_BATCH_MISMATCH: Protocol.EditBatchFailure = {
  applied: false,
  file: "engine.ts",
  changes_total: 1,
  error: {
    code: -32012,
    message: "VERSION_MISMATCH",
    detail: { current_version: "b7e1d4" },
    reconciliation: { ...SAMPLE_DELTA, current_version: "b7e1d4" },
    hint: "文件已变化：用返回的 current_version 与 content 重新读取后再提交",
  },
}

export const SAMPLE_EDIT_BATCH_MISMATCH_RENDER = [
  "edit_batch FAILED: version mismatch",
  "  engine.ts: version mismatch (current b7e1d4)",
  "  reconciliation: delta from v:a3f9c2 (2 hunks)",
  "    @@ old L40-42 → new L40-42 @@",
  "      L40  def load(self, path):",
  "    - L41      data = open(path)",
  '    + L41      data = open(path, "rb")',
  "      L42      return json.load(data)",
  "    @@ old L60-60 → new L61-61 @@",
  "    - L60  def stale():",
  "    + L61  def fresh():",
  "  hint: 文件已变化：用返回的 current_version 与 content 重新读取后再提交",
].join("\n")

export const SAMPLE_EDIT_BATCH_MISMATCH_FULL: Protocol.EditBatchFailure = {
  applied: false,
  file: "engine.ts",
  changes_total: 1,
  error: {
    code: -32012,
    message: "VERSION_MISMATCH",
    detail: { current_version: "b7e1d4" },
    reconciliation: { mode: "full", current_version: "b7e1d4" },
  },
}

export const SAMPLE_EDIT_BATCH_MISMATCH_FULL_RENDER = [
  "edit_batch FAILED: version mismatch",
  "  engine.ts: version mismatch (current b7e1d4)",
  "  reconciliation: full re-read required (current v:b7e1d4)",
].join("\n")

// Fixed edit_transaction responses used by the fake daemon. Crafted so
// renderEditTransaction output matches the sample in LLM-IDE-SPEC/edit-transaction.md
// byte for byte: diagnostics_after is synthesized so before = after - delta, and
// every file carries line_changes so the merged line list can be rendered.
export const SAMPLE_EDIT_TRANSACTION_SUCCESS: Protocol.EditTransactionSuccess = {
  applied: true,
  files_changed: 3,
  changes_applied: 7,
  changes_total: 7,
  files: [
    {
      file: "src/core/engine.ts",
      old_version: "a3f9c2",
      new_version: "b7e1d4",
      version: "b7e1d4",
      changed: { start_line: 42, end_line: 44, text: "return parse(data)", truncated: false },
      position_map: [
        { old_start: 42, old_end: 44, delta: 0 },
        { old_start: 89, old_end: 89, delta: 1 },
      ],
      changes_applied: 3,
      line_changes: [
        { line: 42, action: "modified" },
        { line: 43, action: "modified" },
        { line: 44, action: "modified" },
        { line: 67, action: "modified" },
        { line: 89, action: "inserted" },
      ],
    },
    {
      file: "src/api/routes.ts",
      old_version: "c1d2e3",
      new_version: "f4a5b6",
      version: "f4a5b6",
      changes_applied: 2,
      line_changes: [
        { line: 24, action: "modified" },
        { line: 31, action: "inserted" },
      ],
    },
    {
      file: "tests/test_engine.ts",
      old_version: "1a2b3c",
      new_version: "4d5e6f",
      version: "4d5e6f",
      changes_applied: 2,
      line_changes: [
        { line: 88, action: "modified" },
        { line: 95, action: "modified" },
      ],
    },
  ],
  diagnostics_delta: {
    "src/core/engine.ts": { errors: -2, warnings: 0 },
    "src/api/routes.ts": { errors: 0, warnings: 0 },
    "tests/test_engine.ts": { errors: 0, warnings: 0 },
  },
  diagnostics_after: {
    "src/core/engine.ts": { errors: 0, warnings: 0 },
    "src/api/routes.ts": { errors: 0, warnings: 0 },
    "tests/test_engine.ts": { errors: 0, warnings: 0 },
  },
}

export const SAMPLE_EDIT_TRANSACTION_SUCCESS_RENDER = [
  "edit_transaction applied 7/7 changes across 3 files",
  "  src/core/engine.ts:    L42-44, L67, L89 (3 changes) v:b7e1d4",
  "    changed: L42-44: return parse(data)",
  "    position_map: old 42-44 → delta +0, old 89-89 → delta +1",
  "  src/api/routes.ts:     L24, L31 (2 changes) v:f4a5b6",
  "  tests/test_engine.ts:  L88, L95 (2 changes) v:4d5e6f",
  "  diagnostics: 2 err → 0 err (engine.ts)",
].join("\n")

export const SAMPLE_EDIT_TRANSACTION_FAILURE: Protocol.EditTransactionFailure = {
  applied: false,
  error: {
    code: -32011,
    message: "ANCHOR_NOT_UNIQUE",
    detail: {
      file: "src/core/engine.ts",
      change_index: 1,
      changes_total: 3,
      oldString: "return json.load(data)",
      match_count: 3,
      locations: [42, 67, 89],
    },
    hint: "提供更多上下文使锚点唯一，或调用 fallback_option_direct",
  },
}

export const SAMPLE_EDIT_TRANSACTION_FAILURE_RENDER = [
  "edit_transaction FAILED: anchor not unique in src/core/engine.ts (change 2/3)",
  '  "return json.load(data)" matches 3 locations [L42, L67, L89]',
  "  hint: 提供更多上下文使锚点唯一，或调用 fallback_option_direct",
  "  所有文件均未修改",
].join("\n")

export const SAMPLE_EDIT_TRANSACTION_MISMATCH: Protocol.EditTransactionFailure = {
  applied: false,
  error: {
    code: -32012,
    message: "VERSION_MISMATCH",
    detail: { file: "src/core/engine.ts", current_version: "b7e1d4" },
    reconciliation: { ...SAMPLE_DELTA, current_version: "b7e1d4" },
  },
}

export const SAMPLE_EDIT_TRANSACTION_MISMATCH_RENDER = [
  "edit_transaction FAILED: version mismatch in src/core/engine.ts",
  "  version mismatch (current b7e1d4)",
  "  reconciliation: delta from v:a3f9c2 (2 hunks)",
  "    @@ old L40-42 → new L40-42 @@",
  "      L40  def load(self, path):",
  "    - L41      data = open(path)",
  '    + L41      data = open(path, "rb")',
  "      L42      return json.load(data)",
  "    @@ old L60-60 → new L61-61 @@",
  "    - L60  def stale():",
  "    + L61  def fresh():",
  "  所有文件均未修改",
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

// Fixed project_map responses used by the fake daemon. The structure and
// dependencies fixtures render byte-identically to the samples in
// LLM-IDE-SPEC/project-map.md; the hot fixture uses the frozen client
// alignment (max file length + 2) instead of the uneven spec sample columns.
export const SAMPLE_PROJECT_MAP_STRUCTURE: Protocol.ProjectMapStructure = {
  project: { root: "/path/to/project", total_files: 47, total_modules: 6 },
  modules: [
    {
      name: "core",
      path: "src/core",
      files: ["engine.py", "config.py", "types.py"],
      is_entry: false,
      hot: true,
    },
    { name: "api", path: "src/api", files: ["routes.py", "handlers.py"], is_entry: false, hot: false },
    { name: "utils", path: "src/utils", files: ["log.py", "io.py"], is_entry: false, hot: false },
    { name: "tests", path: "tests", files: ["test_engine.py", "test_api.py"], is_entry: false, hot: false },
  ],
  entry_points: [
    { file: "main.py", line: 1, symbol: "main", kind: "main" },
    { file: "src/api/routes.py", line: 24, symbol: "register", kind: "route" },
  ],
  root_files: ["main.py", "README.md", "TODO.md"],
}

export const SAMPLE_PROJECT_MAP_STRUCTURE_RENDER = [
  "project: 6 modules, 47 files",
  "  src/core/      [engine.py, config.py, types.py]  hot",
  "  src/api/       [routes.py, handlers.py]",
  "  src/utils/     [log.py, io.py]",
  "  tests/         [test_engine.py, test_api.py]",
  "  root:          [main.py, README.md, TODO.md]",
  "",
  "entry: main.py:main (main), src/api/routes.py:register (route)",
].join("\n")

export const SAMPLE_PROJECT_MAP_DEPENDENCIES: Protocol.ProjectMapDependencies = {
  project: { root: "/path/to/project", total_files: 47 },
  dependencies: [
    { from: "src/api", to: "src/core", count: 12 },
    { from: "src/core", to: "src/utils", count: 5 },
    { from: "tests", to: "src/core", count: 8 },
    { from: "tests", to: "src/api", count: 3 },
  ],
  cycles: [],
}

export const SAMPLE_PROJECT_MAP_DEPENDENCIES_RENDER = [
  "dependencies:",
  "  src/api → src/core (12)",
  "  src/core → src/utils (5)",
  "  tests → src/core (8), src/api (3)",
  "  cycles: none",
].join("\n")

export const SAMPLE_PROJECT_MAP_HOT: Protocol.ProjectMapHot = {
  project: { root: "/path/to/project", total_files: 47 },
  hot_files: [
    { file: "src/core/engine.py", read_count: 47, edit_count: 12, last_access: "<timestamp>" },
    { file: "TODO.md", read_count: 23, edit_count: 0, last_access: "<timestamp>" },
    { file: "src/api/routes.py", read_count: 18, edit_count: 4, last_access: "<timestamp>" },
  ],
  hot_modules: ["core", "api"],
}

export const SAMPLE_PROJECT_MAP_HOT_RENDER = [
  "hot files:",
  "  src/core/engine.py  47 reads, 12 edits",
  "  TODO.md             23 reads",
  "  src/api/routes.py   18 reads, 4 edits",
  "hot modules: core, api",
].join("\n")

export const SAMPLE_PROJECT_MAP_BUILDING: Protocol.ProjectMapStructure = {
  project: { root: "/path/to/project", total_files: 0, total_modules: 0 },
  modules: [],
  entry_points: [],
  root_files: [],
  building: true,
  progress: 0.42,
}

export const SAMPLE_PROJECT_MAP_BUILDING_RENDER = "project_map building 42%"
