import { Protocol } from "./protocol"

// Annotations (diagnostics and anchors) start at a fixed column so multiple
// rows line up; longer code lines fall back to a single separating space.
const ANNOTATION_COLUMN = 36

export function render(result: Protocol.ReadViewResult): string {
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
  return lines.join("\n")
}

function header(result: Protocol.ReadViewResult): string {
  const status = [
    ...(result.status.modified ? ["M"] : []),
    ...(result.status.errors > 0 ? [`${result.status.errors}err`] : []),
    `v:${result.version}`,
  ]
  return `${result.file} [${status.join(", ")}] · L1-${result.size.lines} · symbols: ${result.size.symbols}`
}

function positionLine(result: Protocol.ReadViewResult): string | undefined {
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

function coverageLine(result: Protocol.ReadViewResult): string | undefined {
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
  return [
    `edit_batch applied ${result.changes_applied}/${result.changes_total} changes`,
    `  ${result.file}: ${formatLineChanges(result.line_changes)}`,
    `  diagnostics: ${beforeErrors} err → ${result.diagnostics_after.errors} err`,
    `  version: ${result.old_version} → ${result.new_version}`,
  ].join("\n")
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
  const lines = [`edit_batch FAILED: ${headline}`, `  ${result.file ?? "?"}: ${editBatchDetailLine(result)}`]
  if (error.hint !== undefined) lines.push(`  hint: ${error.hint}`)
  return lines.join("\n")
}

const HumanFailure: Record<number, string | undefined> = {
  [Protocol.EditBatchErrorCode.anchorNotFound]: "anchor not found",
  [Protocol.EditBatchErrorCode.anchorNotUnique]: "anchor not unique",
  [Protocol.EditBatchErrorCode.versionMismatch]: "version mismatch",
  [Protocol.EditBatchErrorCode.pathProtected]: "path protected",
  [Protocol.EditBatchErrorCode.contentImpure]: "content impure",
  [Protocol.EditBatchErrorCode.writeFailed]: "write failed",
  [Protocol.EditBatchErrorCode.changeConflict]: "change conflict",
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
