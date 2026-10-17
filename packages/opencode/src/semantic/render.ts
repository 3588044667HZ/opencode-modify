import path from "path"
import { Protocol } from "./protocol"

// Annotations (diagnostics and anchors) start at a fixed column so multiple
// rows line up; longer code lines fall back to a single separating space.
const ANNOTATION_COLUMN = 36

// 大变更降级：引擎返回全量视图且 delta 不可用，提示模型内容即当前版本。
const RECONCILIATION_FULL_VIEW = "reconciliation: full view (delta too large)"

export function render(result: Protocol.ReadViewResult): string {
  if (Protocol.isReadViewUnchanged(result)) return `read_view: unchanged (v:${result.version})`
  if (Protocol.isReadViewDelta(result)) return deltaView(result)
  const lines = [header(result)]
  const position = positionLine(result)
  if (position !== undefined) lines.push(position)
  lines.push("")
  for (const entry of result.content) lines.push(contentLine(entry, result.diagnostics))
  const coverage = coverageLine(result)
  if (coverage !== undefined) {
    lines.push("")
    lines.push(coverage)
  }
  if (result.reconciliation?.mode === "full") lines.push(RECONCILIATION_FULL_VIEW)
  // 降级警告作为最后一行输出：模型据此知道哪些分析节不可用。
  for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`)
  return lines.join("\n")
}

// 读时对账：只展示有界 delta hunks，不重发已在上文消费过的完整内容。
function deltaView(result: Protocol.ReadViewDeltaView): string {
  const reconciliation = result.reconciliation
  const lines = [
    `${result.file} [v:${result.version}]`,
    `delta: v:${reconciliation.from_version} → v:${reconciliation.to_version} (${reconciliation.hunks.length} hunks)`,
  ]
  for (const hunk of reconciliation.hunks) lines.push(...deltaHunkLines(hunk, "  "))
  return lines.join("\n")
}

function deltaHunkLines(hunk: Protocol.DeltaHunk, indent: string): string[] {
  const oldLines = hunk.lines.flatMap((line) => (line.old_line === undefined ? [] : [line.old_line]))
  const newLines = hunk.lines.flatMap((line) => (line.new_line === undefined ? [] : [line.new_line]))
  const range = [
    ...(oldLines.length === 0 ? [] : [`old L${Math.min(...oldLines)}-${Math.max(...oldLines)}`]),
    ...(newLines.length === 0 ? [] : [`new L${Math.min(...newLines)}-${Math.max(...newLines)}`]),
  ].join(" → ")
  const lines = [`${indent}@@ ${range} @@`]
  for (const entry of hunk.lines) {
    const marker = entry.op === "added" ? "+" : entry.op === "removed" ? "-" : " "
    const number = entry.op === "removed" ? entry.old_line : (entry.new_line ?? entry.old_line)
    const body =
      number === undefined
        ? entry.text
        : entry.text.length === 0
          ? `L${number}`
          : `L${number}  ${entry.text}`
    lines.push(`${indent}${marker} ${body}`)
  }
  return lines
}

function header(result: Protocol.ReadViewContent): string {
  const status = [
    ...(result.status.modified ? ["M"] : []),
    ...(result.status.errors > 0 ? [`${result.status.errors}err`] : []),
    `v:${result.version}`,
  ]
  return `${result.file} [${status.join(", ")}] · L1-${result.size.lines} · symbols: ${result.size.symbols}`
}

function positionLine(result: Protocol.ReadViewContent): string | undefined {
  const position = result.position
  if (!position) return undefined
  const percent = position.total > 0 ? Math.floor((position.current / position.total) * 100) : 0
  const parts = [
    ...(position.in_symbol === undefined ? [] : [`in ${position.in_symbol}()`]),
    `${position.remaining_symbols} symbols below`,
  ]
  return `pos: L${position.current}/${position.total} (${percent}%), ${parts.join(", ")}`
}

function contentLine(entry: Protocol.ContentLine, diagnostics: ReadonlyArray<Protocol.Diagnostic>): string {
  const base = entry.text.length === 0 ? `L${entry.line}` : `L${entry.line}  ${entry.text}`
  const diagnostic = entry.diagnostic ?? diagnostics.find((item) => item.line === entry.line)
  const annotations = [
    ...(diagnostic === undefined
      ? []
      : [`${diagnostic.severity === "error" ? "✖" : "⚠"} ${diagnostic.message}`]),
    ...(entry.anchor === undefined ? [] : [`→ def@${entry.anchor.location}`]),
  ]
  if (annotations.length === 0) return base
  const padded = base.length >= ANNOTATION_COLUMN ? `${base} ` : base.padEnd(ANNOTATION_COLUMN)
  return padded + annotations.join(" ")
}

function coverageLine(result: Protocol.ReadViewContent): string | undefined {
  const sections = [
    ...(result.coverage.read.length > 0 ? [`read: ${formatRanges(result.coverage.read)}`] : []),
    ...(result.coverage.unread.length > 0 ? [`unread: ${formatRanges(result.coverage.unread)}`] : []),
  ]
  return sections.length > 0 ? sections.join(" · ") : undefined
}

function formatRanges(ranges: ReadonlyArray<Protocol.CoverageRange>): string {
  return ranges.map(([from, to]) => `L${from}-${to}`).join(", ")
}

export function renderBlastRadius(result: Protocol.BlastRadiusResult): string {
  const definition = result.definition
  const lines = [`${result.symbol}() @ ${definition.file}:${definition.line} (${definition.kind})`]
  lines.push(callersLine(result))
  lines.push(calleesLine(result))
  lines.push(`  affected: ${result.summary.files_count} files`)
  if (result.entry_points.length === 0) lines.push("  entry: none")
  for (const entry of result.entry_points) {
    lines.push(`  entry: ${entry.file}:${entry.line} ${entry.context} ← ${entry.reason}`)
  }
  lines.push(testsLine(result))
  lines.push(`  risk: ${result.summary.risk}`)
  return lines.join("\n")
}

function callersLine(result: Protocol.BlastRadiusResult): string {
  const summary = result.summary
  if (summary.callers_total !== undefined && summary.callers_total > result.callers.length) {
    return `  callers: ${summary.callers_count}+ (total ${summary.callers_total})`
  }
  const callers = result.callers.map((caller) => `${caller.file}:${caller.line} ${caller.context}`)
  return `  callers: ${summary.callers_count} [${callers.join(", ")}]`
}

function calleesLine(result: Protocol.BlastRadiusResult): string {
  const callees = result.callees.map((callee) => `${callee.symbol} @ ${callee.file}:${callee.line}`)
  return `  callees: ${result.summary.callees_count} [${callees.join(", ")}]`
}

function testsLine(result: Protocol.BlastRadiusResult): string {
  const tests = result.tests_affected.map((test) => `${test.file}::${test.name}`)
  return `  tests: ${tests.length} [${tests.join(", ")}]`
}

export function renderEditBatch(result: Protocol.EditBatchResult): string {
  if (result.applied) return editBatchSuccess(result)
  return editBatchFailure(result)
}

function editBatchSuccess(result: Protocol.EditBatchSuccess): string {
  // 渲染层只展示 errors；before 由 after - delta 反推，避免额外请求一次快照。
  const beforeErrors = result.diagnostics_after.errors - result.diagnostics_delta.errors
  const lines = [
    `edit_batch applied ${result.changes_applied}/${result.changes_total} changes`,
    `  ${result.file}: ${formatLineChanges(result.line_changes)}`,
    `  diagnostics: ${beforeErrors} err → ${result.diagnostics_after.errors} err`,
    `  version: ${result.old_version} → ${result.new_version}`,
  ]
  if (result.changed !== undefined) lines.push(...changedLines("  changed:", result.changed))
  if (result.position_map !== undefined && result.position_map.length > 0) {
    lines.push(`  position_map: ${formatPositionMap(result.position_map)}`)
  }
  return lines.join("\n")
}

// 有界变更摘要：展示行区间与截断标记；单行内联，多行按缩进块展开。
function changedLines(prefix: string, changed: Protocol.ChangedExcerpt): string[] {
  const header = `${prefix} L${changed.start_line}-${changed.end_line}${changed.truncated ? " (truncated)" : ""}`
  if (changed.text === "") return [header]
  const parts = changed.text.split("\n")
  if (parts.length === 1) return [`${header}: ${parts[0]}`]
  return [`${header}:`, ...parts.map((line) => `    ${line}`)]
}

function formatPositionMap(entries: ReadonlyArray<Protocol.PositionMapEntry>): string {
  return entries
    .map((entry) => `old ${entry.old_start}-${entry.old_end} → delta ${entry.delta >= 0 ? "+" : ""}${entry.delta}`)
    .join(", ")
}

function formatLineChanges(changes: ReadonlyArray<Protocol.EditBatchLineChange>): string {
  const groups: Array<{ from: number; to: number; action: Protocol.EditBatchLineAction }> = []
  for (const change of changes) {
    const last = groups.at(-1)
    // 相邻且同 action 的连续行号合并为一个区间，其余保持单行输出。
    if (last && last.action === change.action && change.line === last.to + 1) {
      last.to = change.line
      continue
    }
    groups.push({ from: change.line, to: change.line, action: change.action })
  }
  return groups
    .map((group) =>
      group.from === group.to ? `L${group.from} (${group.action})` : `L${group.from}-${group.to} (${group.action})`,
    )
    .join(", ")
}

function editBatchFailure(result: Protocol.EditBatchFailure): string {
  const error = result.error
  const human = HumanFailure[error.code] ?? error.message
  const changeIndex = error.detail?.change_index
  const headline =
    changeIndex === undefined ? human : `change ${changeIndex + 1}/${result.changes_total} ${human}`
  // LOCK_TIMEOUT 的 file 优先取 detail.file（守护进程按锁目标文件回报，result.file 可能缺省）。
  const detailFile = error.code === Protocol.EditBatchErrorCode.lockTimeout ? error.detail?.file : undefined
  const lines = [`edit_batch FAILED: ${headline}`, `  ${detailFile ?? result.file ?? "?"}: ${editBatchDetailLine(result)}`]
  if (error.reconciliation !== undefined) lines.push(...reconciliationLines(error.reconciliation, "  "))
  if (error.hint !== undefined) lines.push(`  hint: ${error.hint}`)
  return lines.join("\n")
}

// VERSION_MISMATCH 不再裸错：给出可继续的对账信息（有界 delta 或 full 再读提示）。
function reconciliationLines(reconciliation: Protocol.Reconciliation, indent: string): string[] {
  if (reconciliation.mode === "delta") {
    return [
      `${indent}reconciliation: delta from v:${reconciliation.from_version} (${reconciliation.hunks.length} hunks)`,
      ...reconciliation.hunks.flatMap((hunk) => deltaHunkLines(hunk, `${indent}  `)),
    ]
  }
  return [`${indent}reconciliation: full re-read required (current v:${reconciliation.current_version ?? "?"})`]
}

const HumanFailure: Record<number, string | undefined> = {
  [Protocol.EditBatchErrorCode.anchorNotFound]: "anchor not found",
  [Protocol.EditBatchErrorCode.anchorNotUnique]: "anchor not unique",
  [Protocol.EditBatchErrorCode.versionMismatch]: "version mismatch",
  [Protocol.EditBatchErrorCode.pathProtected]: "path protected",
  [Protocol.EditBatchErrorCode.contentImpure]: "content impure",
  [Protocol.EditBatchErrorCode.writeFailed]: "write failed",
  [Protocol.EditBatchErrorCode.changeConflict]: "change conflict",
  [Protocol.EditBatchErrorCode.lockTimeout]: "lock timeout",
}

function editBatchDetailLine(result: Protocol.EditBatchFailure): string {
  const error = result.error
  const detail = error.detail
  switch (error.code) {
    case Protocol.EditBatchErrorCode.anchorNotUnique: {
      const locations = (detail?.locations ?? []).map((line) => `L${line}`).join(", ")
      return `"${detail?.oldString ?? "?"}" matches ${detail?.match_count ?? "?"} locations [${locations}]`
    }
    case Protocol.EditBatchErrorCode.anchorNotFound:
      return `"${detail?.oldString ?? "?"}" not found`
    case Protocol.EditBatchErrorCode.versionMismatch:
      return `version mismatch (current ${detail?.current_version ?? "?"})`
    case Protocol.EditBatchErrorCode.pathProtected:
      return "path protected"
    case Protocol.EditBatchErrorCode.contentImpure:
      return `change ${(detail?.change_index ?? 0) + 1} contains render-layer metasyntax (${detail?.marker ?? "?"})`
    case Protocol.EditBatchErrorCode.writeFailed:
      return `write failed (${detail?.reason ?? "?"})`
    case Protocol.EditBatchErrorCode.changeConflict:
      return `change ${(detail?.change_index ?? 0) + 1} overlaps change ${(detail?.conflict_with_index ?? 0) + 1}`
    case Protocol.EditBatchErrorCode.lockTimeout:
      return `lock timeout after ${detail?.waited_ms ?? "?"}ms`
    default:
      return error.message
  }
}

export function renderEditTransaction(result: Protocol.EditTransactionResult): string {
  if (result.applied) return editTransactionSuccess(result)
  return editTransactionFailure(result)
}

function editTransactionSuccess(result: Protocol.EditTransactionSuccess): string {
  // 对齐宽度 = 最长 "文件:" + 2，与 spec 样例（最长 tests/test_engine.ts: 后跟 2 空格）逐字节一致。
  const width = result.files.reduce((max, file) => Math.max(max, file.file.length + 1), 0) + 2
  const lines = [
    `edit_transaction applied ${result.changes_applied}/${result.changes_total} changes across ${result.files_changed} files`,
  ]
  for (const file of result.files) {
    const versionPart = file.version === undefined ? "" : ` v:${file.version}`
    lines.push(
      `  ${`${file.file}:`.padEnd(width)}${transactionLineList(file.line_changes)} (${file.changes_applied} changes)${versionPart}`,
    )
    if (file.changed !== undefined) lines.push(...changedLines("    changed:", file.changed))
    if (file.position_map !== undefined && file.position_map.length > 0) {
      lines.push(`    position_map: ${formatPositionMap(file.position_map)}`)
    }
  }
  for (const [file, delta] of Object.entries(result.diagnostics_delta)) {
    // 只展示发生变化的文件；before 由 after - delta 反推，避免额外请求一次快照。
    if (delta.errors === 0 && delta.warnings === 0) continue
    const after = result.diagnostics_after[file] ?? { errors: 0, warnings: 0 }
    const warnings = delta.warnings === 0 ? "" : `, ${after.warnings - delta.warnings} warn → ${after.warnings} warn`
    lines.push(`  diagnostics: ${after.errors - delta.errors} err → ${after.errors} err${warnings} (${path.basename(file)})`)
  }
  return lines.join("\n")
}

function transactionLineList(changes: ReadonlyArray<Protocol.EditBatchLineChange> | undefined): string {
  if (!changes || changes.length === 0) return "-"
  // 事务渲染忽略 action，仅按行号合并连续区间。
  const groups: Array<{ from: number; to: number }> = []
  for (const change of changes) {
    const last = groups.at(-1)
    if (last && change.line === last.to + 1) {
      last.to = change.line
      continue
    }
    groups.push({ from: change.line, to: change.line })
  }
  return groups.map((group) => (group.from === group.to ? `L${group.from}` : `L${group.from}-${group.to}`)).join(", ")
}

function editTransactionFailure(result: Protocol.EditTransactionFailure): string {
  const detail = result.error.detail
  const human = HumanTransactionFailure[result.error.code] ?? result.error.message
  const headline = [
    human,
    ...(detail?.file === undefined ? [] : [`in ${detail.file}`]),
    ...(detail?.change_index === undefined ? [] : [`(change ${detail.change_index + 1}/${detail.changes_total ?? "?"})`]),
  ].join(" ")
  const lines = [`edit_transaction FAILED: ${headline}`, `  ${editTransactionDetailLine(result.error)}`]
  if (result.error.reconciliation !== undefined) lines.push(...reconciliationLines(result.error.reconciliation, "  "))
  if (result.error.hint !== undefined) lines.push(`  hint: ${result.error.hint}`)
  lines.push("  所有文件均未修改")
  return lines.join("\n")
}

const HumanTransactionFailure: Record<number, string | undefined> = {
  [Protocol.EditTransactionErrorCode.anchorNotFound]: "anchor not found",
  [Protocol.EditTransactionErrorCode.anchorNotUnique]: "anchor not unique",
  [Protocol.EditTransactionErrorCode.versionMismatch]: "version mismatch",
  [Protocol.EditTransactionErrorCode.pathProtected]: "path protected",
  [Protocol.EditTransactionErrorCode.contentImpure]: "content impure",
  [Protocol.EditTransactionErrorCode.changeConflict]: "change conflict",
  [Protocol.EditTransactionErrorCode.lockTimeout]: "lock timeout",
  [Protocol.EditTransactionErrorCode.duplicateFile]: "duplicate file",
}

function editTransactionDetailLine(error: Protocol.EditTransactionError): string {
  const detail = error.detail
  switch (error.code) {
    case Protocol.EditTransactionErrorCode.anchorNotUnique: {
      const locations = (detail?.locations ?? []).map((line) => `L${line}`).join(", ")
      return `"${detail?.oldString ?? "?"}" matches ${detail?.match_count ?? "?"} locations [${locations}]`
    }
    case Protocol.EditTransactionErrorCode.anchorNotFound:
      return `"${detail?.oldString ?? "?"}" not found`
    case Protocol.EditTransactionErrorCode.versionMismatch:
      return `version mismatch (current ${detail?.current_version ?? "?"})`
    case Protocol.EditTransactionErrorCode.pathProtected:
      return "path protected"
    case Protocol.EditTransactionErrorCode.contentImpure:
      return `change ${(detail?.change_index ?? 0) + 1} contains render-layer metasyntax (${detail?.marker ?? "?"})`
    case Protocol.EditTransactionErrorCode.changeConflict:
      return `change ${(detail?.change_index ?? 0) + 1} overlaps change ${(detail?.conflict_with_index ?? 0) + 1}`
    case Protocol.EditTransactionErrorCode.lockTimeout:
      return `lock timeout after ${detail?.waited_ms ?? "?"}ms`
    case Protocol.EditTransactionErrorCode.duplicateFile:
      return `duplicate file ${detail?.file ?? "?"}`
    default:
      return error.message
  }
}

const VERIFY_OUTPUT_LINES = 20

export function renderVerifyTest(result: Protocol.VerifyTestResult): string {
  const seconds = (result.duration_ms / 1000).toFixed(1)
  const lines: string[] = []

  if (result.timeout === true) {
    lines.push(`verify_test ${result.command} → TIMEOUT (${seconds}s)`)
    lines.push("  exit -1")
    lines.push(...verifyOutput(result.output_tail))
    return lines.join("\n")
  }

  const passed = result.exit_code === 0
  const headline = `verify_test ${result.command} → ${passed ? "PASS" : "FAIL"} (${seconds}s${result.parsed ? "" : ", 未识别框架"})`
  lines.push(headline)
  if (result.summary !== null) {
    lines.push(`  ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`)
  }
  if (!passed) {
    for (const failure of result.failures) {
      lines.push(`  FAILED ${failure.test}${failure.line === undefined ? "" : ` (L${failure.line})`}`)
      if (failure.message !== undefined) {
        for (const line of failure.message.split("\n")) lines.push(`    ${line}`)
      }
    }
    if (result.total_failures !== undefined) {
      lines.push(`  (+${result.total_failures - result.failures.length} more failures, total ${result.total_failures})`)
    }
  }
  lines.push(`  exit ${result.exit_code}`)
  if (!result.parsed) lines.push(...verifyOutput(result.output_tail))
  return lines.join("\n")
}

function verifyOutput(tail: string): string[] {
  const lines = ["  output (last 20 lines):"]
  if (tail === "") {
    lines.push("    (无输出)")
    return lines
  }
  for (const line of tail.split("\n").slice(-VERIFY_OUTPUT_LINES)) lines.push(`    ${line}`)
  return lines
}

const PROJECT_MAP_MODULE_LIMIT = 20

export function renderProjectMap(result: Protocol.ProjectMapResult): string {
  if (result.building === true) return `project_map building ${Math.round((result.progress ?? 0) * 100)}%`
  if ("modules" in result) return projectMapStructure(result)
  if ("dependencies" in result) return projectMapDependencies(result)
  return projectMapHot(result)
}

function projectMapStructure(result: Protocol.ProjectMapStructure): string {
  // 对齐宽度按实际列出的模块计算，被截断的隐藏模块不参与。
  const modules = result.modules.slice(0, PROJECT_MAP_MODULE_LIMIT)
  const width = Math.max(...modules.map((module) => module.path.length + 1), "root:".length) + 5
  const lines = [`project: ${result.project.total_modules} modules, ${result.project.total_files} files`]
  for (const module of modules) {
    const hot = module.hot ? "  hot" : ""
    lines.push(`  ${`${module.path}/`.padEnd(width)}[${module.files.join(", ")}]${hot}`)
  }
  if (result.modules.length > PROJECT_MAP_MODULE_LIMIT) {
    lines.push(`  (+${result.project.total_modules - PROJECT_MAP_MODULE_LIMIT} more modules)`)
  }
  lines.push(`  ${"root:".padEnd(width)}[${result.root_files.join(", ")}]`)
  lines.push("")
  if (result.entry_points.length === 0) {
    lines.push("entry: none")
  } else {
    const entries = result.entry_points.map((entry) => `${entry.file}:${entry.symbol} (${entry.kind})`)
    lines.push(`entry: ${entries.join(", ")}`)
  }
  return lines.join("\n")
}

function projectMapDependencies(result: Protocol.ProjectMapDependencies): string {
  const lines = ["dependencies:"]
  const byFrom = new Map<string, Array<(typeof result.dependencies)[number]>>()
  for (const dependency of result.dependencies) {
    const targets = byFrom.get(dependency.from) ?? []
    targets.push(dependency)
    byFrom.set(dependency.from, targets)
  }
  for (const from of [...byFrom.keys()].sort()) {
    const targets = [...(byFrom.get(from) ?? [])].sort((a, b) => b.count - a.count || a.to.localeCompare(b.to))
    lines.push(`  ${from} → ${targets.map((target) => `${target.to} (${target.count})`).join(", ")}`)
  }
  if (byFrom.size === 0) lines.push("  (none)")
  lines.push(result.cycles.length === 0 ? "  cycles: none" : `  cycles: ${result.cycles.map(cycleText).join("; ")}`)
  return lines.join("\n")
}

function cycleText(cycle: ReadonlyArray<string>): string {
  if (cycle.length === 0) return ""
  return `${cycle.join(" → ")} → ${cycle[0]}`
}

function projectMapHot(result: Protocol.ProjectMapHot): string {
  if (result.hot_files.length === 0 && result.hot_modules.length === 0) {
    return "project_map hot: empty (no access stats yet)"
  }
  // 对齐取所列 hot_files 最长路径 + 2，未复刻 spec 样例的逐行差异。
  const width = result.hot_files.reduce((max, file) => Math.max(max, file.file.length), 0) + 2
  const lines = ["hot files:"]
  for (const file of result.hot_files) {
    const edits = file.edit_count > 0 ? `, ${file.edit_count} edits` : ""
    lines.push(`  ${file.file.padEnd(width)}${file.read_count} reads${edits}`)
  }
  lines.push(result.hot_modules.length === 0 ? "hot modules: none" : `hot modules: ${result.hot_modules.join(", ")}`)
  return lines.join("\n")
}
