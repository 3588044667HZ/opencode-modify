# `edit-transaction.md`

## 目标

跨文件原子编辑。一次调用提交涉及多个文件的变更集，要么全部成功，要么全部回滚。它覆盖 `edit_batch` 无法处理的场景——改接口同时改实现和调用方、重命名跨文件符号、批量重构。

数据依据：edit 链 5,960 对中，同文件 disjoint 76.8%，跨文件约 23.2%——不是主流，但是常态，且每次都涉及“改一半崩了”的风险。

## 与 edit_batch 的分工

| | edit_batch | edit_transaction |
|---|---|---|
| 文件数 | 单文件 | 多文件 |
| 原子性 | 单文件内 | 跨文件 |
| 锁 | 一把 | 多把（按字典序） |
| 崩溃恢复 | tmp + rename | tmp + journal + rename |
| 用途 | 局部修改 | 跨文件重构 |

**分开命名，不合并。** 单文件场景用 `edit_batch`，多文件场景用 `edit_transaction`。语义清晰，模型选择成本低。

## 方法签名

```
edit_transaction(changes: FileChange[]) 
→ EditTransactionResult
```

```typescript
interface FileChange {
  file: string           // 文件路径
  baseVersion: string    // read_view 返回的版本戳
  changes: {
    oldString: string
    newString: string
    description?: string
  }[]
}
```

## 返回格式

**成功：**

```json
{
  "applied": true,
  "files_changed": 3,
  "changes_applied": 7,
  "changes_total": 7,
  "files": [
    {
      "file": "src/core/engine.ts",
      "old_version": "a3f9c2",
      "new_version": "b7e1d4",
      "changes_applied": 3,
      "line_changes": [
        {"line": 42, "action": "modified"},
        {"line": 67, "action": "modified"},
        {"line": 89, "action": "inserted"}
      ]
    },
    {
      "file": "src/api/routes.ts",
      "old_version": "c1d2e3",
      "new_version": "f4a5b6",
      "changes_applied": 2
    },
    {
      "file": "tests/test_engine.ts",
      "old_version": "1a2b3c",
      "new_version": "4d5e6f",
      "changes_applied": 2
    }
  ],
  "diagnostics_delta": {
    "src/core/engine.ts": {"errors": -2, "warnings": 0},
    "src/api/routes.ts": {"errors": 0, "warnings": 0},
    "tests/test_engine.ts": {"errors": 0, "warnings": 0}
  }
}
```

**失败：**

```json
{
  "applied": false,
  "error": {
    "code": -32011,
    "message": "ANCHOR_NOT_UNIQUE",
    "detail": {
      "file": "src/core/engine.ts",
      "change_index": 1,
      "oldString": "return json.load(data)",
      "match_count": 3,
      "locations": [42, 67, 89]
    },
    "hint": "提供更多上下文使锚点唯一，或调用 fallback_option_direct 获取直接操作工具"
  }
}
```

**失败时，所有文件均未写入。** 版本戳、索引、诊断全部保持事务前状态。

## 执行流程

```
1. 路径规范化：所有文件路径转绝对路径
2. 路径保护校验：任一文件命中保护列表 → PATH_PROTECTED，整体拒绝
3. 按字典序排序文件路径
4. 按序获取每个文件的互斥锁（FIFO 等待，30s 超时）
   —— 字典序保证不会死锁
5. 校验所有文件的 baseVersion（全部匹配才继续）
   —— 任一不匹配 → VERSION_MISMATCH，释放所有锁，整体拒绝
6. 校验所有 newString 的纯度（不含元语）
7. 内存中应用每个文件的所有 changes
   —— 任一文件应用失败 → 释放所有锁，整体拒绝
8. 写入临时文件：每个文件写 <file>.tmp，fsync
9. 写 journal：记录所有 <file>.tmp → <file> 的映射
10. 依次 rename：tmp → 目标文件
11. 删除 journal
12. 更新所有文件的版本戳、触发索引/诊断失效
13. 按逆序释放所有锁
```

**关键：步骤 5-7 全部成功才进入写入阶段。** 在写入阶段之前，任何失败都不产生副作用。

## 死锁避免

**字典序加锁是唯一保证。** 所有 `edit_transaction` 按文件路径的字典序获取锁。这样，任意两个事务如果需要相同的一组文件，会以相同顺序获取，不会出现“A 等 B，B 等 A”。

**与 edit_batch 的交互：** `edit_batch` 只锁一个文件，不会构成死锁环。但 `edit_transaction` 和 `edit_batch` 同时争用某文件时，会串行等待，由 FIFO 保证公平。

## 崩溃恢复

**问题：** 多文件 rename 阶段崩溃，可能出现“部分文件已改、部分未改”——代码不一致，比单文件崩溃危险。

**方案：journal + 启动恢复。**

**journal 格式：**

```
/tmp/opencode-edit-txn-<uuid>.json
{
  "started_at": "<timestamp>",
  "files": [
    {"tmp": "src/core/engine.ts.tmp", "target": "src/core/engine.ts"},
    {"tmp": "src/api/routes.ts.tmp", "target": "src/api/routes.ts"}
  ]
}
```

**恢复时机：** IntelliJ 守护进程启动时，扫描 journal 目录。

**恢复逻辑：**

- journal 不存在 → 无待恢复事务
- journal 存在且所有 tmp 文件存在 → 重放 rename（完成事务）
- journal 存在且部分 tmp 已消失 → 已完成部分 rename，继续剩余
- journal 存在但 tmp 文件不完整 → 事务中断在 fsync 前，清理 tmp + journal

**恢复的原子性：** rename 本身是原子的。重放 rename 是幂等的——已 rename 的目标文件再次 rename 会失败，跳过即可。

## 错误码

复用已有错误码，新增一个：

| 码 | 名称 | 触发 |
|---|---|---|
| -32010 | `ANCHOR_NOT_FOUND` | 某文件的某 change 找不到锚点 |
| -32011 | `ANCHOR_NOT_UNIQUE` | 某文件的某 change 锚点不唯一 |
| -32012 | `VERSION_MISMATCH` | 某文件的 baseVersion 不匹配 |
| -32013 | `PATH_PROTECTED` | 某文件命中保护列表 |
| -32014 | `CONTENT_IMPURE` | 某文件的 newString 含元语 |
| -32016 | `CHANGE_CONFLICT` | 同一文件内两个 change 锚点重叠 |
| **-32017** | `LOCK_TIMEOUT` | 等待文件锁超时 |
| **-32018** | `JOURNAL_RECOVERY_FAILED` | 启动时 journal 恢复失败（需人工介入） |
| **-32019** | `DUPLICATE_FILE` | changes 里同一文件出现多次（应合并） |

## 聚合逻辑

- **跨文件诊断 delta**：事务提交后，重新分析每个变更文件，收集诊断变化
- **line_changes**：每个文件独立计算
- **失败时返回第一个失败点**：不返回所有失败（避免噪音），只返回触发拒绝的那个

## 渲染层输出

**成功：**

```
edit_transaction applied 7/7 changes across 3 files
  src/core/engine.ts:    L42-44, L67, L89 (3 changes)
  src/api/routes.ts:     L24, L31 (2 changes)
  tests/test_engine.ts:  L88, L95 (2 changes)
  diagnostics: 2 err → 0 err (engine.ts)
```

**失败：**

```
edit_transaction FAILED: anchor not unique in src/core/engine.ts (change 2/3)
  "return json.load(data)" matches 3 locations [L42, L67, L89]
  hint: 提供更多上下文使锚点唯一，或调用 fallback_option_direct
  所有文件均未修改
```

紧凑形式，模型一眼知道哪些文件、多少改动、失败在哪、是否回滚。

## 与其他原语的关系

| 原语 | 关系 |
|---|---|
| `read_view` | 提供每个文件的 `baseVersion` |
| `edit_batch` | 单文件场景仍用 edit_batch；事务只用于多文件 |
| `blast_radius` | 提供影响面，帮助模型决定事务涉及哪些文件 |
| `project_map` | `dependencies` 视图辅助判断跨模块变更范围 |
| `verify_test` | 事务提交后，模型可调 verify_test 做完整验证 |
| `fallback_option_direct` | 事务失败时 hint 引导 |

## 实现顺序

```
1. Java 端：多文件锁获取（字典序）+ 版本校验
2. Java 端：内存多文件应用 + tmp 写入
3. Java 端：journal + rename + 恢复逻辑
4. 客户端：协议解码 + 渲染
5. fixtures + 双向契约测试
6. 崩溃恢复测试
```

前 3 步是 MVP，第 4、5 步是必须，第 6 步是加固。

## 约束

- **最多 10 个文件**——超过则拒绝，防止事务过大
- **文本锚点**——和 edit_batch 一致，失败数据驱动升级
- **不做嵌套事务**——事务内不调其他事务
- **不做跨项目**——所有文件在同一项目内
- **journal 目录**：`<project>/.opencode/txn-journal/`，被 gitignore

## 验收标准

- [ ] 两个文件，一个成功一个失败，整体回滚，无文件被修改
- [ ] 所有文件版本匹配才执行，任一不匹配整体拒绝
- [ ] 按字典序加锁，无死锁
- [ ] 锁超时返回 `LOCK_TIMEOUT`
- [ ] 同一文件在 changes 里出现两次返回 `DUPLICATE_FILE`
- [ ] 超过 10 个文件返回错误
- [ ] 保护路径命中返回 `PATH_PROTECTED`
- [ ] 成功后所有文件版本戳更新
- [ ] 跨文件诊断 delta 正确计算
- [ ] 崩溃恢复：模拟 rename 中途崩溃，重启后事务完整
- [ ] 渲染层输出与样例格式一致
- [ ] 协议 fixtures：`fixtures/edit_transaction/input.json` + `output.json`
- [ ] Java 端契约测试 + 客户端契约测试

## 验收证据要求

- [ ] 真实链路：对 `sample-project` 的两个文件做跨文件事务，成功
- [ ] 回滚验证：故意让第二个文件失败，第一个文件保持原样
- [ ] 并发验证：两个事务争用同一组文件，串行执行，无死锁
- [ ] 崩溃恢复验证：模拟 rename 中途 kill，重启后事务完整
- [ ] 契约测试双向通过

---

## 需要你确认的三点

**① 最多 10 个文件合理。
**② journal 恢复失败的处理。** 如果启动时 journal 
恢复不了（比如 tmp 文件损坏），返回 `JOURNAL_RECOVERY_FAILED` 后，守护进程应该继续启动（拒绝后续写操作）还是直接崩溃？我倾向**继续启动但标记项目为只读**，人类介入后再恢复。

**③ 事务内是否允许新文件创建。** `write` 可以创建文件，`edit_transaction` 是否也支持？如果支持，changes 里需要一个 `create: true` 标记。如果不支持，模型需要先 `write` 创建再 `edit_transaction` 修改——但那破坏了原子性。我倾向**第一版不支持创建**，只修改现有文件。
