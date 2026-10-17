import { Option, Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode-ai/schema/schema"

export const Views = ["entry", "sequential", "continue", "definition"] as const
export type View = (typeof Views)[number]

export const ErrorCode = {
  indexing: -32000,
  fileNotFound: -32001,
  symbolNotFound: -32002,
  journalRecoveryFailed: -32018,
  // hello 门禁未授权。数值与 edit_transaction 的 duplicate_file 相同，作用域不同（帧级 vs 结果联合）。
  unauthorized: -32019,
  internalError: -32603,
} as const

export const Defaults = {
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 15_000,
  // 冷沙箱首启（JVM 冷启动 + 首次索引）可能远超 60s；守护启动改为按需惰性后
  // 不再并发抢占资源，放宽到 180s 避免误判启动失败。
  socketReadyTimeoutMs: 180_000,
  socketRetryIntervalMs: 200,
  indexPollIntervalMs: 1_000,
} as const

export interface Request {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface Success {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly result: unknown
}

export interface Failure {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly error: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export type Response = Success | Failure

export interface Notification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

export type Message = Response | Notification

export function isResponse(message: Message): message is Response {
  return "id" in message && typeof message.id === "number"
}

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("SemanticRpcError", {
  code: Schema.Int,
  message: Schema.String,
  data: optional(Schema.Unknown),
}) {}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("SemanticTimeoutError", {
  message: Schema.String,
  method: Schema.String,
  timeout_ms: Schema.Int,
}) {}

export class ConnectionError extends Schema.TaggedErrorClass<ConnectionError>()("SemanticConnectionError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("SemanticUnavailableError", {
  message: Schema.String,
  progress: optional(Schema.Number),
}) {}

export type SemanticError = RpcError | TimeoutError | ConnectionError | UnavailableError

export function toSemanticError(cause: unknown): SemanticError {
  if (
    cause instanceof RpcError ||
    cause instanceof TimeoutError ||
    cause instanceof ConnectionError ||
    cause instanceof UnavailableError
  ) {
    return cause
  }
  return new ConnectionError({ message: cause instanceof Error ? cause.message : String(cause) })
}

export function describeError(error: SemanticError): string {
  if (error instanceof RpcError) {
    if (error.code === ErrorCode.indexing) {
      const progress = progressOf(error.data)
      return progress === undefined
        ? "semantic engine is still indexing, retry this call shortly."
        : `semantic engine is still indexing (progress: ${Math.round(progress * 100)}%), retry this call shortly.`
    }
    if (error.code === ErrorCode.fileNotFound) {
      return `semantic engine could not find this file (it may not be indexed): ${error.message}`
    }
    if (error.code === ErrorCode.symbolNotFound) {
      return `semantic engine could not resolve symbol (it may not exist or be indexed): ${error.message}`
    }
    if (error.code === ErrorCode.journalRecoveryFailed) {
      return "semantic writes are disabled: journal recovery failed (human intervention required)"
    }
    return `semantic engine error (${error.code}): ${error.message}`
  }
  if (error instanceof UnavailableError) {
    if (error.progress === undefined) return error.message
    return `${error.message} (progress: ${Math.round(error.progress * 100)}%)`
  }
  if (error instanceof TimeoutError) return error.message
  return `semantic engine unavailable: ${error.message}`
}

function progressOf(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const progress = (data as { progress?: unknown }).progress
  return typeof progress === "number" && Number.isFinite(progress) ? progress : undefined
}

export const PingResult = Schema.Struct({
  indexing: Schema.Boolean,
  progress: Schema.Number,
  phase: optional(Schema.String),
  current: optional(Schema.String),
  eta: optional(Schema.Number),
})
export type PingResult = typeof PingResult.Type

export const IndexingNotification = Schema.Struct({
  phase: Schema.String,
  progress: Schema.Number,
  current: optional(Schema.String),
  eta: optional(Schema.Number),
})
export type IndexingNotification = typeof IndexingNotification.Type

export const SubscribeResult = Schema.Struct({ ok: Schema.Boolean })
export type SubscribeResult = typeof SubscribeResult.Type

export const ShutdownResult = Schema.Struct({ ok: Schema.Boolean })
export type ShutdownResult = typeof ShutdownResult.Type

const DiagnosticSeverity = Schema.Literals(["error", "warning"])

export const InlineDiagnostic = Schema.Struct({
  severity: DiagnosticSeverity,
  message: Schema.String,
})
export type InlineDiagnostic = typeof InlineDiagnostic.Type

export const Anchor = Schema.Struct({
  symbol: Schema.String,
  location: Schema.String,
})
export type Anchor = typeof Anchor.Type

export const ContentLine = Schema.Struct({
  line: Schema.Int,
  text: Schema.String,
  diagnostic: optional(InlineDiagnostic),
  anchor: optional(Anchor),
})
export type ContentLine = typeof ContentLine.Type

export const Diagnostic = Schema.Struct({
  line: Schema.Int,
  severity: DiagnosticSeverity,
  message: Schema.String,
})
export type Diagnostic = typeof Diagnostic.Type

export const CoverageRange = Schema.Tuple([Schema.Int, Schema.Int])
export type CoverageRange = typeof CoverageRange.Type

export const DeltaOps = ["context", "added", "removed"] as const
export type DeltaOp = (typeof DeltaOps)[number]

// 行级对账 delta（有界，与 Java Reconcile 行口径一致）：removed 带 old_line，added 带 new_line，
// context 两者皆有。
const DeltaLine = Schema.Struct({
  op: Schema.Literals(DeltaOps),
  old_line: optional(Schema.Int),
  new_line: optional(Schema.Int),
  text: Schema.String,
})
export type DeltaLine = typeof DeltaLine.Type

const DeltaHunk = Schema.Struct({
  lines: Schema.Array(DeltaLine),
})
export type DeltaHunk = typeof DeltaHunk.Type

// 有界 delta 对账载荷；编辑侧 VERSION_MISMATCH 额外附 current_version，read_view 省略。
export const ReconciliationDelta = Schema.Struct({
  mode: Schema.Literal("delta"),
  from_version: Schema.String,
  to_version: Schema.String,
  hunks: Schema.Array(DeltaHunk),
  current_version: optional(Schema.String),
}).annotate({ identifier: "ReconciliationDelta", parseOptions: { onExcessProperty: "error" } })
export type ReconciliationDelta = typeof ReconciliationDelta.Type

// 大变更降级标记：全量视图或 full 再读提示。
export const ReconciliationFull = Schema.Struct({
  mode: Schema.Literal("full"),
  current_version: optional(Schema.String),
}).annotate({ identifier: "ReconciliationFull", parseOptions: { onExcessProperty: "error" } })
export type ReconciliationFull = typeof ReconciliationFull.Type

export const Reconciliation = Schema.Union([ReconciliationDelta, ReconciliationFull]).annotate({
  identifier: "Reconciliation",
  parseOptions: { onExcessProperty: "error" },
})
export type Reconciliation = typeof Reconciliation.Type

// 版本一致时的微响应：不重发内容，调用方保留既有视图。
export const ReadViewUnchanged = Schema.Struct({
  unchanged: Schema.Literal(true),
  version: Schema.String,
}).annotate({ identifier: "ReadViewUnchanged", parseOptions: { onExcessProperty: "error" } })
export type ReadViewUnchanged = typeof ReadViewUnchanged.Type

// 读时对账的有界 delta 响应：只带 file/version/reconciliation，不重发内容。
export const ReadViewDeltaView = Schema.Struct({
  file: Schema.String,
  version: Schema.String,
  reconciliation: ReconciliationDelta,
}).annotate({ identifier: "ReadViewDeltaView", parseOptions: { onExcessProperty: "error" } })
export type ReadViewDeltaView = typeof ReadViewDeltaView.Type

// Strict decoding: the frozen read_view contract must not silently accept
// fields the daemon is not supposed to send.
export const ReadViewContent = Schema.Struct({
  file: Schema.String,
  version: Schema.String,
  size: Schema.Struct({ lines: Schema.Int, symbols: Schema.Int }),
  status: Schema.Struct({ modified: Schema.Boolean, errors: Schema.Int }),
  position: optional(
    Schema.Struct({
      current: Schema.Int,
      total: Schema.Int,
      in_symbol: optional(Schema.String),
      remaining_symbols: Schema.Int,
    }),
  ),
  content: Schema.Array(ContentLine),
  coverage: Schema.Struct({
    read: Schema.Array(CoverageRange),
    unread: Schema.Array(CoverageRange),
  }),
  diagnostics: Schema.Array(Diagnostic),
  // 发行版不完整等场景下分析节降级的可操作提示（有界、去重）；健康时省略。
  warnings: optional(Schema.Array(Schema.String)),
  reconciliation: optional(ReconciliationFull),
}).annotate({ identifier: "ReadViewContent", parseOptions: { onExcessProperty: "error" } })
export type ReadViewContent = typeof ReadViewContent.Type

export const ReadViewResult = Schema.Union([ReadViewUnchanged, ReadViewDeltaView, ReadViewContent]).annotate({
  identifier: "ReadViewResult",
  parseOptions: { onExcessProperty: "error" },
})
export type ReadViewResult = typeof ReadViewResult.Type

export function isReadViewUnchanged(result: ReadViewResult): result is ReadViewUnchanged {
  return "unchanged" in result
}

export function isReadViewDelta(result: ReadViewResult): result is ReadViewDeltaView {
  return !("unchanged" in result) && !("size" in result)
}

export interface ReadViewRequest {
  readonly file: string
  readonly view: View
  readonly position?: { readonly line: number }
  readonly symbol?: string
  // 读时对账：上次读到的版本戳；与当前一致时引擎只回 unchanged 微响应。
  readonly known_version?: string
}

export const BlastRadiusRisks = ["low", "medium", "high"] as const
export type BlastRadiusRisk = (typeof BlastRadiusRisks)[number]

const BlastRadiusDefinition = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  kind: Schema.String,
})

const BlastRadiusCaller = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  context: Schema.String,
  is_test: Schema.Boolean,
})

const BlastRadiusCallee = Schema.Struct({
  symbol: Schema.String,
  file: Schema.String,
  line: Schema.Int,
})

const BlastRadiusEntryPoint = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  context: Schema.String,
  reason: Schema.String,
})

const BlastRadiusTest = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  name: Schema.String,
})

const BlastRadiusSummary = Schema.Struct({
  callers_count: Schema.Int,
  callers_total: optional(Schema.Int),
  callees_count: Schema.Int,
  files_count: Schema.Int,
  has_public_api_usage: Schema.Boolean,
  risk: Schema.Literals(BlastRadiusRisks),
})

// Strict decoding: the frozen blast_radius contract must not silently accept
// fields the daemon is not supposed to send.
export const BlastRadiusResult = Schema.Struct({
  symbol: Schema.String,
  definition: BlastRadiusDefinition,
  callers: Schema.Array(BlastRadiusCaller),
  callees: Schema.Array(BlastRadiusCallee),
  affected_files: Schema.Array(Schema.String),
  entry_points: Schema.Array(BlastRadiusEntryPoint),
  tests_affected: Schema.Array(BlastRadiusTest),
  summary: BlastRadiusSummary,
}).annotate({ identifier: "BlastRadiusResult", parseOptions: { onExcessProperty: "error" } })
export type BlastRadiusResult = typeof BlastRadiusResult.Type

export interface BlastRadiusRequest {
  readonly symbol: string
  readonly scope?: string
}

export const EditBatchErrorCode = {
  anchorNotFound: -32010,
  anchorNotUnique: -32011,
  versionMismatch: -32012,
  pathProtected: -32013,
  contentImpure: -32014,
  writeFailed: -32015,
  changeConflict: -32016,
  lockTimeout: -32017,
} as const

export type EditBatchErrorCode = (typeof EditBatchErrorCode)[keyof typeof EditBatchErrorCode]

const EditBatchErrorCodes = [
  EditBatchErrorCode.anchorNotFound,
  EditBatchErrorCode.anchorNotUnique,
  EditBatchErrorCode.versionMismatch,
  EditBatchErrorCode.pathProtected,
  EditBatchErrorCode.contentImpure,
  EditBatchErrorCode.writeFailed,
  EditBatchErrorCode.changeConflict,
  EditBatchErrorCode.lockTimeout,
] as const

export const EditBatchChange = Schema.Struct({
  oldString: Schema.String,
  newString: Schema.String,
  description: optional(Schema.String),
})
export type EditBatchChange = typeof EditBatchChange.Type

export interface EditBatchRequest {
  readonly file: string
  readonly changes: ReadonlyArray<EditBatchChange>
  readonly baseVersion: string
  // 并发锁可选项：客户端原样透传，由守护进程校验与执行。
  readonly options?: { readonly lock_timeout_ms?: number }
}

export const EditBatchLineActions = ["inserted", "modified", "deleted"] as const
export type EditBatchLineAction = (typeof EditBatchLineActions)[number]

export const EditBatchLineChange = Schema.Struct({
  line: Schema.Int,
  action: Schema.Literals(EditBatchLineActions),
})
export type EditBatchLineChange = typeof EditBatchLineChange.Type

export const EditBatchDiagnostics = Schema.Struct({
  errors: Schema.Int,
  warnings: Schema.Int,
})
export type EditBatchDiagnostics = typeof EditBatchDiagnostics.Type

// D3 写时对账：逐变更块的旧→新行偏移（有界）。
export const PositionMapEntry = Schema.Struct({
  old_start: Schema.Int,
  old_end: Schema.Int,
  delta: Schema.Int,
})
export type PositionMapEntry = typeof PositionMapEntry.Type

// 变更区域新内容的有界摘录（行区间 + 文本 + 截断标记）。
export const ChangedExcerpt = Schema.Struct({
  start_line: Schema.Int,
  end_line: Schema.Int,
  text: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "ChangedExcerpt", parseOptions: { onExcessProperty: "error" } })
export type ChangedExcerpt = typeof ChangedExcerpt.Type

export const EditBatchSuccess = Schema.Struct({
  file: Schema.String,
  applied: Schema.Literal(true),
  changes_applied: Schema.Int,
  changes_total: Schema.Int,
  old_version: Schema.String,
  new_version: Schema.String,
  diagnostics_delta: EditBatchDiagnostics,
  diagnostics_after: EditBatchDiagnostics,
  line_changes: Schema.Array(EditBatchLineChange),
  version: optional(Schema.String),
  changed: optional(ChangedExcerpt),
  position_map: optional(Schema.Array(PositionMapEntry)),
}).annotate({ identifier: "EditBatchSuccess", parseOptions: { onExcessProperty: "error" } })
export type EditBatchSuccess = typeof EditBatchSuccess.Type

export const EditBatchDetail = Schema.Struct({
  change_index: optional(Schema.Int),
  oldString: optional(Schema.String),
  match_count: optional(Schema.Int),
  locations: optional(Schema.Array(Schema.Int)),
  current_version: optional(Schema.String),
  content: optional(Schema.String),
  path: optional(Schema.String),
  marker: optional(Schema.String),
  conflict_with_index: optional(Schema.Int),
  reason: optional(Schema.String),
  file: optional(Schema.String),
  waited_ms: optional(Schema.Int),
}).annotate({ identifier: "EditBatchDetail", parseOptions: { onExcessProperty: "error" } })
export type EditBatchDetail = typeof EditBatchDetail.Type

export const EditBatchError = Schema.Struct({
  code: Schema.Literals(EditBatchErrorCodes),
  message: Schema.String,
  detail: optional(EditBatchDetail),
  hint: optional(Schema.String),
  reconciliation: optional(Reconciliation),
}).annotate({ identifier: "EditBatchError", parseOptions: { onExcessProperty: "error" } })
export type EditBatchError = typeof EditBatchError.Type

export const EditBatchFailure = Schema.Struct({
  applied: Schema.Literal(false),
  file: optional(Schema.String),
  changes_total: Schema.Int,
  error: EditBatchError,
}).annotate({ identifier: "EditBatchFailure", parseOptions: { onExcessProperty: "error" } })
export type EditBatchFailure = typeof EditBatchFailure.Type

// 与 blast_radius 相同的严格性：discriminated union 也必须拒绝多余字段。
export const EditBatchResult = Schema.Union([EditBatchSuccess, EditBatchFailure]).annotate({
  identifier: "EditBatchResult",
  parseOptions: { onExcessProperty: "error" },
})
export type EditBatchResult = typeof EditBatchResult.Type

export const EditTransactionErrorCode = {
  anchorNotFound: -32010,
  anchorNotUnique: -32011,
  versionMismatch: -32012,
  pathProtected: -32013,
  contentImpure: -32014,
  writeFailed: -32015,
  changeConflict: -32016,
  lockTimeout: -32017,
  duplicateFile: -32019,
} as const

export type EditTransactionErrorCode = (typeof EditTransactionErrorCode)[keyof typeof EditTransactionErrorCode]

// -32018 (JOURNAL_RECOVERY_FAILED) 只作为 JSON-RPC 错误返回（只读门），不属于结果联合。
const EditTransactionErrorCodes = [
  EditTransactionErrorCode.anchorNotFound,
  EditTransactionErrorCode.anchorNotUnique,
  EditTransactionErrorCode.versionMismatch,
  EditTransactionErrorCode.pathProtected,
  EditTransactionErrorCode.contentImpure,
  EditTransactionErrorCode.writeFailed,
  EditTransactionErrorCode.changeConflict,
  EditTransactionErrorCode.lockTimeout,
  EditTransactionErrorCode.duplicateFile,
] as const

export interface EditTransactionFileChange {
  readonly file: string
  readonly baseVersion: string
  readonly changes: ReadonlyArray<EditBatchChange>
}

export interface EditTransactionRequest {
  readonly changes: ReadonlyArray<EditTransactionFileChange>
  // 并发锁可选项：客户端原样透传，由守护进程校验与执行。
  readonly options?: { readonly lock_timeout_ms?: number }
}

const EditTransactionDiagnostics = Schema.Struct({
  errors: Schema.Int,
  warnings: Schema.Int,
}).annotate({ identifier: "EditTransactionDiagnostics", parseOptions: { onExcessProperty: "error" } })

export const EditTransactionFile = Schema.Struct({
  file: Schema.String,
  old_version: Schema.String,
  new_version: Schema.String,
  changes_applied: Schema.Int,
  line_changes: optional(Schema.Array(EditBatchLineChange)),
  version: optional(Schema.String),
  changed: optional(ChangedExcerpt),
  position_map: optional(Schema.Array(PositionMapEntry)),
}).annotate({ identifier: "EditTransactionFile", parseOptions: { onExcessProperty: "error" } })
export type EditTransactionFile = typeof EditTransactionFile.Type

// 与 blast_radius 相同的严格性：顶层与嵌套都必须拒绝多余字段。
export const EditTransactionSuccess = Schema.Struct({
  applied: Schema.Literal(true),
  files_changed: Schema.Int,
  changes_applied: Schema.Int,
  changes_total: Schema.Int,
  files: Schema.Array(EditTransactionFile),
  diagnostics_delta: Schema.Record(Schema.String, EditTransactionDiagnostics),
  diagnostics_after: Schema.Record(Schema.String, EditTransactionDiagnostics),
}).annotate({ identifier: "EditTransactionSuccess", parseOptions: { onExcessProperty: "error" } })
export type EditTransactionSuccess = typeof EditTransactionSuccess.Type

export const EditTransactionDetail = Schema.Struct({
  file: optional(Schema.String),
  path: optional(Schema.String),
  change_index: optional(Schema.Int),
  changes_total: optional(Schema.Int),
  oldString: optional(Schema.String),
  match_count: optional(Schema.Int),
  locations: optional(Schema.Array(Schema.Int)),
  current_version: optional(Schema.String),
  content: optional(Schema.String),
  marker: optional(Schema.String),
  conflict_with_index: optional(Schema.Int),
  waited_ms: optional(Schema.Int),
  reason: optional(Schema.String),
}).annotate({ identifier: "EditTransactionDetail", parseOptions: { onExcessProperty: "error" } })
export type EditTransactionDetail = typeof EditTransactionDetail.Type

export const EditTransactionError = Schema.Struct({
  code: Schema.Literals(EditTransactionErrorCodes),
  message: Schema.String,
  detail: optional(EditTransactionDetail),
  hint: optional(Schema.String),
  reconciliation: optional(Reconciliation),
}).annotate({ identifier: "EditTransactionError", parseOptions: { onExcessProperty: "error" } })
export type EditTransactionError = typeof EditTransactionError.Type

export const EditTransactionFailure = Schema.Struct({
  applied: Schema.Literal(false),
  error: EditTransactionError,
}).annotate({ identifier: "EditTransactionFailure", parseOptions: { onExcessProperty: "error" } })
export type EditTransactionFailure = typeof EditTransactionFailure.Type

export const EditTransactionResult = Schema.Union([EditTransactionSuccess, EditTransactionFailure]).annotate({
  identifier: "EditTransactionResult",
  parseOptions: { onExcessProperty: "error" },
})
export type EditTransactionResult = typeof EditTransactionResult.Type

export const VerifyTestSummary = Schema.Struct({
  passed: Schema.Int,
  failed: Schema.Int,
  skipped: Schema.Int,
  total: Schema.Int,
}).annotate({ identifier: "VerifyTestSummary", parseOptions: { onExcessProperty: "error" } })
export type VerifyTestSummary = typeof VerifyTestSummary.Type

export const VerifyTestFailure = Schema.Struct({
  test: Schema.String,
  file: optional(Schema.String),
  line: optional(Schema.Int),
  message: optional(Schema.String),
}).annotate({ identifier: "VerifyTestFailure", parseOptions: { onExcessProperty: "error" } })
export type VerifyTestFailure = typeof VerifyTestFailure.Type

export const VerifyTestOptions = Schema.Struct({
  cwd: optional(Schema.String),
  timeout_ms: optional(NonNegativeInt),
  env: optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "VerifyTestOptions", parseOptions: { onExcessProperty: "error" } })
export type VerifyTestOptions = typeof VerifyTestOptions.Type

export interface VerifyTestRequest {
  readonly command: string
  readonly options?: VerifyTestOptions
}

// Strict decoding: the frozen verify_test contract must not silently accept
// fields the daemon is not supposed to send.
export const VerifyTestResult = Schema.Struct({
  command: Schema.String,
  exit_code: Schema.Int,
  duration_ms: Schema.Number,
  summary: Schema.NullOr(VerifyTestSummary),
  failures: Schema.Array(VerifyTestFailure),
  output_head: Schema.String,
  output_tail: Schema.String,
  parsed: Schema.Boolean,
  framework: Schema.NullOr(Schema.String),
  timeout: optional(Schema.Boolean),
  total_failures: optional(Schema.Int),
}).annotate({ identifier: "VerifyTestResult", parseOptions: { onExcessProperty: "error" } })
export type VerifyTestResult = typeof VerifyTestResult.Type

export const ProjectMapViews = ["structure", "dependencies", "hot"] as const
export type ProjectMapView = (typeof ProjectMapViews)[number]

export interface ProjectMapRequest {
  readonly view?: ProjectMapView
  readonly scope?: string
}

// 三种 view 都可能处于构建中：各数组为空、project 计数为 0，并由 building/progress 标记。
const projectMapBuilding = {
  building: optional(Schema.Literal(true)),
  progress: optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
}

const ProjectMapProject = Schema.Struct({
  root: Schema.String,
  total_files: Schema.Int,
}).annotate({ identifier: "ProjectMapProject", parseOptions: { onExcessProperty: "error" } })

const ProjectMapModule = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  files: Schema.Array(Schema.String),
  is_entry: Schema.Boolean,
  hot: Schema.Boolean,
}).annotate({ identifier: "ProjectMapModule", parseOptions: { onExcessProperty: "error" } })

const ProjectMapEntryPoint = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  symbol: Schema.String,
  kind: Schema.String,
}).annotate({ identifier: "ProjectMapEntryPoint", parseOptions: { onExcessProperty: "error" } })

// Strict decoding: the frozen project_map contract must not silently accept
// fields the daemon is not supposed to send.
export const ProjectMapStructure = Schema.Struct({
  ...projectMapBuilding,
  project: Schema.Struct({
    root: Schema.String,
    total_files: Schema.Int,
    total_modules: Schema.Int,
  }).annotate({ identifier: "ProjectMapStructureProject", parseOptions: { onExcessProperty: "error" } }),
  modules: Schema.Array(ProjectMapModule),
  entry_points: Schema.Array(ProjectMapEntryPoint),
  root_files: Schema.Array(Schema.String),
}).annotate({ identifier: "ProjectMapStructure", parseOptions: { onExcessProperty: "error" } })
export type ProjectMapStructure = typeof ProjectMapStructure.Type

const ProjectMapDependency = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  count: Schema.Int,
}).annotate({ identifier: "ProjectMapDependency", parseOptions: { onExcessProperty: "error" } })

export const ProjectMapDependencies = Schema.Struct({
  ...projectMapBuilding,
  project: ProjectMapProject,
  dependencies: Schema.Array(ProjectMapDependency),
  cycles: Schema.Array(Schema.Array(Schema.String)),
}).annotate({ identifier: "ProjectMapDependencies", parseOptions: { onExcessProperty: "error" } })
export type ProjectMapDependencies = typeof ProjectMapDependencies.Type

const ProjectMapHotFile = Schema.Struct({
  file: Schema.String,
  read_count: Schema.Int,
  edit_count: Schema.Int,
  last_access: Schema.String,
}).annotate({ identifier: "ProjectMapHotFile", parseOptions: { onExcessProperty: "error" } })

export const ProjectMapHot = Schema.Struct({
  ...projectMapBuilding,
  project: ProjectMapProject,
  hot_files: Schema.Array(ProjectMapHotFile),
  hot_modules: Schema.Array(Schema.String),
}).annotate({ identifier: "ProjectMapHot", parseOptions: { onExcessProperty: "error" } })
export type ProjectMapHot = typeof ProjectMapHot.Type

// 分支靠必需键区分：modules / dependencies / hot_files。
export const ProjectMapResult = Schema.Union([ProjectMapStructure, ProjectMapDependencies, ProjectMapHot]).annotate({
  identifier: "ProjectMapResult",
  parseOptions: { onExcessProperty: "error" },
})
export type ProjectMapResult = typeof ProjectMapResult.Type

export function decodeOption<S extends Schema.Codec<unknown, unknown>>(schema: S, value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value)) as S["Type"] | undefined
}

export * as Protocol from "./protocol"
