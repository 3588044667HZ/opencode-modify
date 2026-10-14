# `fallback-option-direct.md`

## 目标

内置只读工具，返回被隐藏工具（`hide: true`）的完整定义。它是模型访问“直接操作工具”的入口，也是写入侧工具暴露策略的核心。

命名遵循词嵌入原则：`fallback` + `option` + `direct` 三段都是预训练高频词，组合语义自然，不需要模型现拼。

## 方法签名

```
fallback_option_direct() → string
```

**零参数。** 它不查询任何东西，不接收任何输入。调用即返回当前隐藏工具的定义文本。

## 工具可见性机制

这是本工具的基础设施。 **所有工具定义带一个 `hide` 字段。**

```typescript
interface ToolDefinition {
  name: string
  description: string
  parameters: Schema
  hide?: boolean        // 缺省 false，即可见
  execute: Function
}
```

**默认可见。** 新工具默认暴露，需要隐藏时显式设 `hide: true`。当前隐藏的工具：
`edit`、`write`、`multiedit`、`apply_patch`。

**三处消费 `hide` 字段：**

| 消费方             | 行为                                                         |
|--------------------|--------------------------------------------------------------|
| `tools/list` 生成  | 过滤 `hide == false` 的工具                                  |
| system prompt 组装 | 只注入 `hide == false` 的工具定义                            |
| 调用解析层         | **不校验 `hide`**，只查注册表。`hide: true` 的工具仍可被调用 |

`hide` 只影响“是否展示”，不影响“是否可调用”。

## 返回格式

三段式：坦白 → 定义 → 标签。

```
以下工具一直存在，只是从你的默认视野中隐藏。
它们直接操作文本，绕过语义引擎。

── edit ──
精确字符串替换。
参数：oldString, newString, filePath

── write ──
覆盖写入。
参数：filePath, content

── multiedit ──
单文件多次编辑。
参数：filePath, edits[]

── apply_patch ──
结构化补丁。
参数：patch

以上工具简单粗暴，仅在新工具无法处理时使用。
```

**三段结构：**

1. **坦白**（固定文本）：解释为什么现在才看到——一直存在，只是被隐藏
2. **定义**（动态生成）：遍历注册表中 `hide: true` 的工具，每个输出 `name` +
   `description` + 参数名
3. **标签**（固定文本）：使用建议——简单粗暴，仅在新工具无法处理时使用

**第二段是动态的。** 新增隐藏工具时，`fallback_option_direct` 自动包含它，不需要改代码。

## 调用链路

```
模型调 fallback_option_direct() → 拿到隐藏工具定义
模型直接调 edit(...)           → OC 解析层查注册表 → 执行
```

**不转发、不代理、不碰执行。** `fallback_option_direct`
只返回定义，模型自己去调真实工具。执行路径完全走原有通道。

## 触发时机

**正常路径不调。** 模型默认用新语义工具（`read_view`、`edit_batch`、`blast_radius`、
`verify_test`、`project_map`）。

**失败时提示。** 新工具失败时，错误信息附带 hint：

```
hint: 可调用 fallback_option_direct 获取直接操作工具
```

提示规则：

| 工具           | 失败                | 是否提示 fallback      |
|----------------|---------------------|------------------------|
| `edit_batch`   | `ANCHOR_NOT_UNIQUE` | 是                     |
| `edit_batch`   | `CHANGE_CONFLICT`   | 是                     |
| `edit_batch`   | `PATH_PROTECTED`    | 否（保护路径没有退路） |
| `edit_batch`   | `CONTENT_IMPURE`    | 否（重试而非绕过）     |
| `edit_batch`   | `VERSION_MISMATCH`  | 否（先重新读）         |
| `blast_radius` | 符号找不到          | 是                     |
| `read_view`    | 文件不存在          | 是                     |

**原则**：语义工具无法处理的场景才提示 fallback。语义工具能处理但模型用错了，提示重试，不提示
fallback。

## OC 改动

四处：

**① 工具定义加 `hide` 字段。** 缺省 `false`。旧工具显式设 `hide: true`。

**② tools/list 生成：过滤 `hide == true`。** 模型可见列表只含 `hide == false` 的工具。

**③ system prompt 组装：过滤 `hide == true`。** 系统提示词只注入可见工具的定义。

**④ 调用解析层：不校验可见列表。** 只查注册表。`hide: true` 的工具仍可被调用。

## 缓存友好

**tools/list 和 system prompt 永远不变。** `fallback_option_direct`
始终在列表里，旧工具始终隐藏。调用 `fallback_option_direct` 后，返回内容进
**对话历史**，不改 system prompt。

这保证了 prompt cache 的前缀（system prompt + 早期历史）始终有效。只有
`fallback_option_direct` 调用之后的部分需要重新处理。

## 实现要点

- **动态生成**：第二段遍历注册表中 `hide: true` 的工具，自动组装定义
- **静态部分**：第一段（坦白）和第三段（标签）是固定文本
- **无状态**：不记录谁调用过、调用几次
- **纯 OC 内置**：不经过 IntelliJ 守护进程，不经过 JSON-RPC
- **i18n**：第一版只做英文
- **零参数**：不需要 schema 参数

## 与其他原语的关系

| 原语                                       | 关系                                              |
|--------------------------------------------|---------------------------------------------------|
| `edit_batch`                               | 失败时 hint 引导模型调用 `fallback_option_direct` |
| `read_view`                                | 提供 `baseVersion`；fallback 工具绕过版本校验     |
| `blast_radius`                             | 失败时 hint 引导                                  |
| 旧工具（edit/write/multiedit/apply_patch） | `fallback_option_direct` 是它们的唯一入口         |

## 验收标准

- [ ] `fallback_option_direct()` 返回三段式内容，顺序正确
- [ ] 第二段动态包含所有 `hide: true` 的工具
- [ ] 新增隐藏工具后，返回内容自动包含它（不改代码）
- [ ] tools/list 只含 `hide: false` 的工具
- [ ] system prompt 不含 `hide: true` 的工具定义
- [ ] 模型调 `fallback_option_direct()` 后，直接调 `edit(...)` 能成功
- [ ] 解析层不校验可见列表
- [ ] `edit_batch` 失败时 hint 包含 `fallback_option_direct`（按规则表）
- [ ] `PATH_PROTECTED`、`CONTENT_IMPURE`、`VERSION_MISMATCH` 不提示 fallback
- [ ] 调用 `fallback_option_direct` 前后，system prompt 不变（cache 验证）
- [ ] 协议 fixtures：`fixtures/fallback_option_direct/output.txt`
- [ ] OC 端单元测试：返回内容、提示触发条件、cache 不变、hide 字段过滤

## 验收证据要求

- [ ] 真实链路跑通：模型调 `fallback_option_direct()` → 看到定义 → 调
  `edit(...)` → 成功
- [ ] 失败路径验证：`edit_batch` 返回 `ANCHOR_NOT_UNIQUE`，hint 含
  `fallback_option_direct`
- [ ] 保护路径验证：`PATH_PROTECTED` 不提示 fallback
- [ ] cache 验证：两次对话间 system prompt 哈希一致
- [ ] 工具列表验证：tools/list 不含 `hide: true` 的工具
- [ ] 动态生成验证：临时给一个工具设 `hide: true`，`fallback_option_direct` 返回它

## 约束

- **零参数**——不接收输入
- **动态生成**——第二段从注册表读取，不硬编码
- **纯 OC 内置**——不碰 IntelliJ，不碰 JSON-RPC
- **不转发**——只返回定义，不代理执行
- **不碰执行**——不检查注册表、不执行工具
- **英文内容**——第一版不做多语言

## 测试用例

| 用例                                       | 断言                                  |
|--------------------------------------------|---------------------------------------|
| 返回内容逐字节匹配 fixture                 | 完全相等（`hide: true` 工具集固定时） |
| tools/list 不含 `hide: true` 的工具        | 遍历工具名确认                        |
| system prompt 不含 `hide: true` 的工具定义 | 字符串匹配                            |
| `edit_batch` `ANCHOR_NOT_UNIQUE` 的 hint   | 包含 `fallback_option_direct`         |
| `edit_batch` `PATH_PROTECTED` 的 hint      | 不包含 `fallback_option_direct`       |
| 模型调 fallback 后调 edit                  | 真实链路验证通过                      |
| 连续两轮对话 system prompt                 | 哈希一致                              |
| 动态生成：临时隐藏一个工具                 | fallback 返回内容包含它               |

## 相关决策记录

> **工具可见性机制**
> 每个工具定义带 `hide` 字段，缺省 `false`（可见）。
> `tools/list` 和 system prompt 过滤 `hide == true`。
> 解析层不校验 `hide`，只查注册表。
> `fallback_option_direct` 动态读取 `hide: true` 的工具，生成定义文本。
> 当前隐藏：edit / write / multiedit / apply_patch。
> 新增隐藏工具时，fallback 自动覆盖，无需改代码。
