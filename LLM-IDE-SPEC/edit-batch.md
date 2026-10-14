## 目标

单文件、多区域的原子批量编辑。这是写入侧的第一个原语，也是写路径基础设施的首次落地——版本戳校验、路径保护、源文件纯度校验，都在这里定义。

它替代的是数据里 5,960 对 `edit→edit` 链和 3,962 串 `edit³`——模型反复小步修改的碎片化行为。

## 方法签名

```
edit_batch(file: string, changes: Change[], baseVersion: string) 
→ EditBatchResult
```

- `file`：目标文件路径（单文件）
- `changes`：变更列表，每项含 `oldString`、`newString`、可选 `description`
- `baseVersion`：调用者读取该文件时拿到的版本戳（来自 `read_view` 的 `version` 字段）

## 返回格式

**成功：**

```json
{
  "file": "engine.ts",
  "applied": true,
  "changes_applied": 3,
  "changes_total": 3,
  "old_version": "a3f9c2",
  "new_version": "b7e1d4",
  "diagnostics_delta": {
    "errors": -2,
    "warnings": 0
  },
  "line_changes": [
    {
      "line": 42,
      "action": "modified"
    },
    {
      "line": 67,
      "action": "modified"
    },
    {
      "line": 89,
      "action": "inserted"
    }
  ]
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
      "change_index": 1,
      "oldString": "return json.load(data)",
      "match_count": 3,
      "locations": [
        42,
        67,
        89
      ]
    },
    "hint": "提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具"
  }
}
```

## 事务语义

**全成功或全失败。** 流程：

1. 校验 `baseVersion` 与当前文件版本匹配
2. 校验路径不在保护列表
3. 校验每个 `newString` 不含元语标记
4. 在内存中依次应用所有 changes
5. 任一 change 失败 → 整体拒绝，不写盘
6. 全部成功 → 原子写入（临时文件 + rename）
7. 更新版本戳、触发索引/诊断失效

**原子写入**：写到 `<file>.tmp`，fsync，rename 覆盖。崩溃时要么旧版要么新版，不会半写。

## 锚点匹配

第一版用 **文本锚点**：

- `oldString` 必须在当前文件内容中 **恰好出现一次**
- 出现 0 次 → `ANCHOR_NOT_FOUND`（可能版本已变）
- 出现多次 → `ANCHOR_NOT_UNIQUE`（需要更多上下文）
- 恰好 1 次 → 替换为 `newString`

**失败数据驱动升级**：如果 `ANCHOR_NOT_UNIQUE` 占比高，后续加符号锚点；如果
`ANCHOR_NOT_FOUND` 占比高，可能是版本校验的时机问题。

## 错误码

| 码     | 名称                | 触发                         |
|--------|---------------------|------------------------------|
| -32010 | `ANCHOR_NOT_FOUND`  | `oldString` 在文件中找不到   |
| -32011 | `ANCHOR_NOT_UNIQUE` | `oldString` 匹配多处         |
| -32012 | `VERSION_MISMATCH`  | `baseVersion` 与当前版本不符 |
| -32013 | `PATH_PROTECTED`    | 路径在保护列表内             |
| -32014 | `CONTENT_IMPURE`    | `newString` 含元语标记       |
| -32015 | `WRITE_FAILED`      | 磁盘写入失败                 |

## 写路径基础设施（首次落地）

这四个契约在 `edit_batch` 里第一次实现，后续所有写操作共享：

### ① 版本戳校验

- `read_view` 返回 `version`（VFS modification stamp 或内容 hash）
- `edit_batch` 必须携带 `baseVersion`
- 服务端比对当前文件版本：
  - 匹配 → 继续
  - 不匹配 → `VERSION_MISMATCH`，返回最新版本戳和内容

**不做文件系统主动监听**——只在写前校验。这是之前定的“被动一致性层”。

### ② 路径保护

保护列表（默认，可配置）：

```
.venv/, venv/, env/
node_modules/
.git/
dist/, build/, target/, out/
__pycache__/, .pytest_cache/, .mypy_cache/
*.lock, *.min.js, *.min.css
```

命中 → `PATH_PROTECTED`，硬拒绝。不做覆盖选项——覆盖是后续增强。

### ③ 源文件纯度校验

`newString` 不能包含渲染层元语：

```
[err: ...]     诊断标记
→ def@...      锚点标记
L\d+ \[...\]   行级标记
pos: L\d+      位置标记
```

命中 → `CONTENT_IMPURE`，拒绝。这是防止模型从渲染视图复制元语回源文件。

### ④ 版本戳更新

写入成功后：

- 新版本戳 = 新内容的 hash / VFS stamp
- 返回给调用者
- 触发该文件的索引失效、诊断失效

## 渲染层输出

**成功：**

```
edit_batch applied 3/3 changes
  engine.ts: L42-44 (modified), L67 (modified), L89 (inserted)
  diagnostics: 2 err → 0 err
  version: a3f9c2 → b7e1d4
```

**失败：**

```
edit_batch FAILED: change 2/3 anchor not unique
  engine.ts: "return json.load(data)" matches 3 locations [L42, L67, L89]
  hint: 提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具
```

紧凑形式，模型一眼知道改了什么、效果如何、失败原因。

## 聚合逻辑

`edit_batch` 本身不做语义聚合（不像 `blast_radius`），但 **结果里要包含影响摘要**：

- `diagnostics_delta`：改前 vs 改后的诊断差异。这要求适配层在应用 changes
  后重新跑一次该文件的 Daemon Analyzer。
- `line_changes`：每个 change 实际影响了哪些行。这是应用前后 diff 的副产品。

**诊断 delta 是 `edit_batch` 的核心价值**——它让模型立刻知道“我的修改有没有引入错误”，不需要再跑一次
`read_view`。数据里 `edit→read→edit` 677 次，一部分就是模型在手动验证。

## 实现要点

- **内存应用**：先在内存中构造新内容，全部 change 应用成功后再写盘
- **锚点定位**：从后往前应用 changes（避免前面的 change 影响后面 change 的行号）
- **冲突检测**：如果两个 change 的 `oldString` 在同一区域重叠 → 拒绝
- **诊断重跑**：写入后用 PSI 重新分析该文件，拿诊断 delta
- **缓存失效**：写入成功后，通知 `blast_radius` 的符号缓存清空该文件相关条目

## 验收标准

- [ ] 单文件多区域 changes 原子应用，全成功
- [ ] 任一 change 失败，整体拒绝，不写盘
- [ ] `baseVersion` 不匹配时返回 `VERSION_MISMATCH` + 最新内容
- [ ] `.venv` 等路径返回 `PATH_PROTECTED`
- [ ] `newString` 含 `[err:` 等元语返回 `CONTENT_IMPURE`
- [ ] `oldString` 匹配 0 次 → `ANCHOR_NOT_FOUND`
- [ ] `oldString` 匹配多次 → `ANCHOR_NOT_UNIQUE` + 位置列表
- [ ] 成功后返回 `diagnostics_delta` 和 `line_changes`
- [ ] 成功后版本戳更新，索引/诊断失效
- [ ] 渲染层输出与样例格式一致
- [ ] 协议 fixtures：`fixtures/edit_batch/input.json` + `output.json`
- [ ] Java 端契约测试 + 客户端契约测试
- [ ] 崩溃恢复：模拟写入中途中断，文件要么旧版要么新版

## 与其他原语的关系

| 原语           | 关系                                                      |
|----------------|-----------------------------------------------------------|
| `read_view`    | 提供 `baseVersion`；`edit_batch` 成功后触发 read 缓存失效 |
| `blast_radius` | 提供符号缓存失效通知；`edit_batch` 是它的“写”对偶         |
| `map()`        | 失败时 hint 引导模型使用直接操作工具                      |
| `verify_test`  | 模型可以在 edit_batch 后调 verify_test 做完整验证         |

## 实现顺序

```
1. Java 端：变更模型 + 原子写入 + 版本戳校验
2. 写路径基础设施：路径保护 + 纯度校验
3. 诊断 delta：写入后重跑 Daemon Analyzer
4. 客户端：协议解码 + 渲染
5. fixtures + 双向契约测试
6. 崩溃恢复测试
```

前 3 步是 MVP，第 4、5 步是必须，第 6 步是加固。

## 约束

- **单文件**——不做跨文件事务
- **文本锚点**——不做符号锚点，失败数据驱动升级
- **无自动格式化**——不跑 formatter，只做字符串替换
- **无内容规范化**——不做换行符转换、缩进调整
- **无撤销**——回滚是后续功能，第一版只保证原子性

## 验收证据要求

- [ ] 真实链路跑通：对 `sample-project` 的一个文件做多区域 edit_batch，返回成功
- [ ] 失败路径验证：故意传错 `baseVersion`、错误锚点、保护路径，各返回对应错误码
- [ ] 契约测试双向通过
- [ ] 诊断 delta 真实反映修改效果
- [ ] 原子性验证：模拟中途崩溃，文件完整

---

要我把这份 spec 放进 `spec/` 目录吗？还是你直接交给 AI 实现？
