# 上下文对账与记忆折叠（context-reconciliation）

## 背景

人类的工作记忆易失：代码一改，旧版本自然淘汰，IDE 只需"画面即真相"。LLM 的上下文是
**追加式、无损**的：旧内容不消失，而是与新内容同场竞争。由此产生三个病灶（不依赖人操作，
纯 AI 闭环同样存在）：

1. **self-stale**：模型自己刚写的新内容与上下文里早先读到的旧内容并存，跨多轮编辑的
   "哪里已被替换"心算必然出错；
2. **位置漂移**：一次编辑使此前所有 `pos: Lx` 失效，模型仍可能引用旧坐标系；
3. **diff-merge 不可靠 + 折叠缺失**：人被编辑器"自动刷新画面"，AI 没有刷新循环；全量
   覆盖某区域后，旧读取成为死重却仍在窗口竞争注意力。compaction 的保留还是非均匀的。

结论：引擎必须补上"渲染循环"的等价物——**写=重绘、读=校验、每轮=对账**。

## 模式：折叠即记忆编辑（tool_output 先例）

opencode 的 `tool_output`（超限 → 存盘 + 消息内截断桩 + `read` 再物化）已是本模式的实例：
**有界内联 + 外部权威源 + 按需再物化**，且折叠发生在**写入时**（不事后改历史）→ 缓存友好。

代码记忆是同一模式换触发轴：

| 维度 | 工具输出折叠 | 代码/上下文对账折叠 |
|---|---|---|
| 触发轴 | 大小（行/字节超限） | **大小 + 新鲜度（version 不符）** |
| 外部权威源 | 转储文件（不可变） | 工作树 + 引擎索引（**会变**） |
| 再物化路径 | `read` | `read_view`（带 version 校验） |
| 桩内容 | 路径 + 截断提示 | 路径/符号 + **折叠时 version** + 摘要 |

唯一实质差异：工具输出不可变，代码会变——所以桩必须带 version，再物化语义从"取回全文"
变为"对账到当前版本"（可能有界 delta）。

## 设计契约（冻结）

### D1 双区上下文契约

| 区域 | 内容 | 策略 | 缓存代价 |
|---|---|---|---|
| A（前缀） | system prompt、工具定义、历史转写 | **只追加、永不编辑**；supersede 用追加标记表达 | 恒定命中 |
| B（尾部） | 每轮对账块（staleness digest 等） | 允许**重写/替换最后一块** | ≈ 尾块大小，与总上下文长度无关 |
| C（重建窗口） | 深部合并、旧块真删除 | 仅在下列时机执行 | 全后缀一次重算 |

不变量：system prompt 与 tools/list 永不因对账改变（沿用 `fallback_option_direct` 的 cache 原则）。

### D2 统一物化契约（stub）

任何大体量外部事实（工具输出/文件视图/项目地图）进入上下文 = 有界桩：

```json
{"kind": "tool_output|file_view|project_map", "ref": "<path 或 path#symbol>",
 "version": "<该源的版本戳；可变源必填>", "bytes": 1234, "excerpt": "…（有界）",
 "rehydrate": "read|read_view"}
```

- 桩必须携带 version（可变源）；再物化 = `read_view(ref, known_version)`。
- 现有 80 行窗口/覆盖区间是该契约在 read_view 上的既有实现，本 spec 将其显式化。

### D3 写时对账（mutation 响应）

`edit_batch` / `edit_transaction` 的响应**逐文件**新增：

- `version`：mutation 后的新版本戳；
- `changed`：有界变更摘要（变更后区域的新内容片段，上限固定）；
- `position_map`：旧→新行偏移（逐变更块 `{old_start, old_end, delta}`，有界）。

目的：模型自己写造成的不一致，在**同一轮内**被对账（编辑器重绘的等价物），使后续引用
（Lx、锚点）可被增量修正。

### D4 读时对账（read_view reconcile）

`read_view` 请求新增可选 `known_version`：

- 与当前版本相等 → `{unchanged: true, version}`（微响应，不重发内容）；
- 不等 → 有界 delta（hunks + 有限上下文行） + 新 `version`；delta 超阈值降级为 full view
  并附 `reconciliation: {mode: "full"}`；
- 引擎实现：维护**有界"已服务视图"缓存**（LRU：上限如 16 文件 / 8MB；key = path+version），
  用于计算 delta；cache miss → full。缓存不落盘、不参与一致性保证。

`VERSION_MISMATCH`（编辑侧）不再裸错：错误载荷附 `reconciliation`（current_version +
有界 delta 或"需 full 再读"提示）。

外部变更（用户手改、git 操作）走同一路径（下次 read_view/digest 时对账）。

### D5 会话账本（OC）

- 状态（main.md"状态全在 OC"的扩展）：`seen[file] = {version, lastUse, role: read|edit,
  consumed?: boolean, superseded?: boolean}`，来源为工具结果中的 version 戳与 mutation 响应；
- **每轮 digest**（append-only，B 区）：仅当存在变化时注入，有界（条数/字节上限）：

  ```
  stale: src/a.ts (you read v3; now v7)
  superseded: src/b.ts (your v2 fully replaced by your edit -> v5)
  ```

- 消费终点信号：模型继续写该文件 → 保留；切换任务/长时间未引用 → 标记可折。

### D6 折叠策略（谁可折）

三重检验：

1. **可恢复性**：折掉后能否按需复原？不可变源随时可折；可变源只能恢复到**当前**版本——
   上下文里的**历史字节是唯一副本**时，折前必须确认快照存在（git/journal/引擎快照），否则禁折；
2. **消费终点**：行动前（oldString/锚点/pending 载荷）**禁折**；已消费（结论已提取）可折；
   持续推理中的工作集保留最新版、只折旧版；
3. **替代物分辨率**：指针桩 `path#symbol@version` < 语义桩（签名/结构/摘要） < delta。选
   "任务够用"的最强折叠。

判定表：

| 内容 | 判定 |
|---|---|
| 本轮编辑目标区、pending 编辑载荷、用户贴的代码 | **禁折** |
| 已消费的探索性读取 | 优先折（留结论 + 指针桩） |
| 被取代的旧读取（superseded） | 立即折；唯一副本且无快照 → 禁折 |
| 重复视图（同文件多处读到） | 去重，留最新 |
| 稳定第三方接口/已评审大文件 | **语义折**（签名/结构） |
| 超限大段 | 走既有 `tool_output` 桩模式 |
| 其他 agent 可能引用锚点的内容 | 折到任务/agent 边界 |

### D7 缓存平衡（记忆编辑规则）

- 热路径 = **纯追加**（折叠标记也是追加）；
- **尾部重写**：只动最后一块，代价 ≈ 尾块大小；
- **深部编辑仅限 C 窗口**，成本判据：编辑点距尾 T token → 重算成本 ≈ T；收益 = 删除内容 ×
  预期剩余轮数 + 陈旧干扰消除；不划算则推迟（追加 supersede 标记）；
- **C 窗口清单**：compaction、provider 缓存 TTL 过期、模型切换、会话恢复/重启、任务边界。

## 实现切分

- **W1 引擎（Java）**：D3 写时对账 + D4 读时对账（served-view 缓存 + 行级 delta + 降级规则）；
  渲染字段。拥有 `semantic-server/src/main/java/**`。
- **W2 协议/工具层（TS semantic）**：协议新字段贯通（`known_version`、mutation 新字段、
  错误载荷 `reconciliation`）、工具输出渲染、conformance fixtures 更新（严格 schema）。
  拥有 `packages/opencode/src/semantic/**`、`tool/{read-view,edit-batch,edit-transaction}.ts`、
  `semantic-server/fixtures/**`、`script/protocol-conformance.ts`。
- **W3 会话账本（OC session）**：D5 账本 + 每轮 digest 注入 + 消费状态推断。
- **W4 折叠运行时**：D6 判定 + D7 规则落地（热路径标记、C 窗口合并）+ 验收。

依赖：W1/W2 接口以本 spec 冻结、可并行；W3 依赖 W2 字段；W4 依赖 W3。

## 验收标准

- [ ] 多轮 edit 后：`position_map` 使模型可修正行号；测试场景不引用已失效 Lx
- [ ] 版本冲突不失败：`VERSION_MISMATCH` 返回可继续的对账信息（current + delta/提示）
- [ ] 外部修改后 `read_view(known_version)` 返回有界 delta；相同版本返回 `unchanged`
- [ ] 每轮 digest 仅在存在过期时出现、格式有界；**前缀（system/tools/历史）不因对账改变**
- [ ] 硬边界不被违反：行动前 verbatim 保留；无快照不折历史
- [ ] 缓存验证：对账前后 system prompt 与历史前缀哈希一致（追加不破坏前缀）
- [ ] `protocol-conformance` 全绿（含新增字段的严格 schema）；manager/工具测试全绿；typecheck 干净

## 非目标

- 不操作 provider 缓存；不实现历史版本存储（唯一副本判定依赖 git/journal，无则禁折）；
- 本批不做对话消息真删除——真删除只发生在 C 窗口的 compaction 中；
- 不改变 system prompt / tools/list 的内容。

## 分支与流程

- 用户指令：实现开新分支 **`context-reconciliation`**；本 spec 完成后**直接实施**（无需再确认）。
