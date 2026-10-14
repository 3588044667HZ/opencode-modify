import type * as Protocol from "./protocol"

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
