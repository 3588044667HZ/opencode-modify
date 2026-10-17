// D6 折叠策略判定：纯函数、无 IO，供 C 窗口与后续折叠运行时调用。
//
// 三重检验（顺序即优先级）：
// 1. 可恢复性：折掉后能否按需复原？不可变源（tool_output 转储）随时可折；可变源只能对账到
//    当前版本（read_view(known_version)）；历史字节是唯一副本且无快照（git/journal/引擎快照）时禁折。
// 2. 消费终点：行动前（oldString/锚点/pending 载荷）禁折；已消费（结论已提取）可折；
//    持续推理中的工作集保留最新版、只折旧版。
// 3. 替代物分辨率：指针桩 path#symbol@version < 语义桩（签名/结构/摘要）< delta；
//    选择任务够用的最强折叠。
//
// 硬边界（任何情况下禁折）：本轮编辑目标区、pending 编辑载荷、用户粘贴的代码、
// 唯一副本且无快照的历史。
//
// D7：热路径只做纯追加（折叠标记也是追加）；真实字节删除/深部合并仅发生在 C 窗口
// （compaction、provider 缓存 TTL 过期、模型切换、会话恢复、任务边界）。本批不执行 C 窗口
// 合并，只在 decide() 上标注 hotPath：marker = 热路径追加标记，none = 本批不动。

export type ContentKind =
  | "pending-edit-payload"
  | "edit-target"
  | "user-paste"
  | "exploration-read"
  | "superseded-read"
  | "duplicate-view"
  | "stable-interface"
  | "working-set"

export type Recoverability = "immutable" | "versioned" | "unique-no-snapshot"

export interface FoldInput {
  kind: ContentKind
  /** 缺省按 versioned（可变源，可对账到当前版本） */
  recoverability?: Recoverability
  /** 结论已提取（消费终点已到） */
  consumed?: boolean
  /** 将作为 oldString/锚点/pending 载荷使用（行动前） */
  pendingAction?: boolean
  /** 同文件已有更新的视图（去重场景） */
  duplicateOfNewer?: boolean
  /** 内容超限（走既有 tool_output 桩模式） */
  oversized?: boolean
  /** 其他 agent/子任务可能引用其锚点 */
  sharedAnchors?: boolean
  /** working-set：是否为最新版 */
  latest?: boolean
}

export type FoldAction =
  | "keep"
  | "pointer"
  | "semantic"
  | "delta"
  | "tool-output"
  | "dedupe-latest"
  | "defer-task-boundary"

export interface FoldDecision {
  readonly action: FoldAction
  readonly reason: string
  readonly hotPath: "marker" | "none"
}

export type RecoverabilityVerdict = "restorable" | "current-version-only" | "forbidden"

export function recoverability(input: FoldInput): RecoverabilityVerdict {
  switch (input.recoverability ?? "versioned") {
    case "immutable":
      return "restorable"
    case "unique-no-snapshot":
      return "forbidden"
    default:
      return "current-version-only"
  }
}

export type ConsumptionVerdict = "before-action" | "consumed" | "in-progress"

export function consumption(input: FoldInput): ConsumptionVerdict {
  if (input.pendingAction) return "before-action"
  if (input.consumed) return "consumed"
  return "in-progress"
}

export function hardBoundary(input: FoldInput): string | undefined {
  if (input.pendingAction) return "action-before content (oldString/anchor/pending payload) must stay verbatim"
  if (input.kind === "pending-edit-payload") return "pending edit payload must stay verbatim"
  if (input.kind === "edit-target") return "current edit target region must stay verbatim"
  if (input.kind === "user-paste") return "user-pasted code must stay verbatim"
  if (recoverability(input) === "forbidden") return "unique history without a snapshot must not be folded"
  return undefined
}

export function resolution(input: FoldInput): FoldAction {
  if (input.oversized) return "tool-output"
  if (input.kind === "duplicate-view") return "dedupe-latest"
  if (input.kind === "stable-interface") return "semantic"
  if (input.kind === "working-set") return input.latest ? "keep" : "delta"
  if (input.kind === "exploration-read" || input.kind === "superseded-read") return "pointer"
  return "keep"
}

export function decide(input: FoldInput): FoldDecision {
  const boundary = hardBoundary(input)
  if (boundary !== undefined) return { action: "keep", reason: boundary, hotPath: "none" }
  if (input.sharedAnchors)
    return {
      action: "defer-task-boundary",
      reason: "other agents may anchor on this content; fold at the task/agent boundary",
      hotPath: "none",
    }
  if (input.oversized)
    return {
      action: "tool-output",
      reason: "oversized content uses the existing tool_output stub mode",
      hotPath: "none",
    }
  if (consumption(input) === "before-action")
    return { action: "keep", reason: "content is still the action input", hotPath: "none" }

  switch (input.kind) {
    case "superseded-read":
      return {
        action: "pointer",
        reason: "superseded read folds immediately to a path#symbol@version pointer stub",
        hotPath: "marker",
      }
    case "duplicate-view":
      return input.duplicateOfNewer
        ? { action: "dedupe-latest", reason: "duplicate view folds into the newest copy", hotPath: "marker" }
        : { action: "keep", reason: "this view is already the newest copy", hotPath: "none" }
    case "exploration-read":
      return input.consumed
        ? {
            action: "pointer",
            reason: "consumed exploration read keeps its conclusion plus a pointer stub",
            hotPath: "marker",
          }
        : { action: "keep", reason: "exploration read is not consumed yet", hotPath: "none" }
    case "stable-interface":
      return { action: "semantic", reason: "stable interface folds to signatures/structure", hotPath: "marker" }
    case "working-set":
      return input.latest
        ? { action: "keep", reason: "working set keeps its newest version", hotPath: "none" }
        : { action: "delta", reason: "working set folds older versions to a bounded delta", hotPath: "marker" }
    default:
      return { action: "keep", reason: "no fold rule matches", hotPath: "none" }
  }
}

export * as FoldPolicy from "./fold-policy"
