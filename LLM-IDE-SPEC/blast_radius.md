## 目标

给定一个符号，返回“修改它会影响什么”的聚合视图。这是 `read_view` 的同构复制，但多一层
**聚合逻辑**——`read_view` 取一段内容，`blast_radius` 聚合多处引用，并按重要性分类。

它验证适配层的聚合能力，也为 `edit_batch` 的跨文件影响分析铺路。

## 方法签名

```
blast_radius(symbol: string, scope?: string) 
→ BlastRadiusResult
```

- `symbol`：符号名（如 `load`、`Config`）
- `scope`：可选，限定搜索范围（如 `file:engine.ts`、`module:core`）。缺省时全项目搜索。

## 返回格式

```json
{
  "symbol": "load",
  "definition": {
    "file": "engine.ts",
    "line": 40,
    "kind": "method"
  },
  "callers": [
    {
      "file": "bar.ts",
      "line": 42,
      "context": "handleRequest",
      "is_test": false
    },
    {
      "file": "baz.ts",
      "line": 17,
      "context": "retry",
      "is_test": false
    },
    {
      "file": "test_engine.py",
      "line": 88,
      "context": "test_load",
      "is_test": true
    }
  ],
  "callees": [
    {
      "symbol": "json.load",
      "file": "json/__init__.py",
      "line": 120
    },
    {
      "symbol": "transform",
      "file": "engine.ts",
      "line": 55
    }
  ],
  "affected_files": [
    "bar.ts",
    "baz.ts",
    "engine.ts"
  ],
  "entry_points": [
    {
      "file": "qux.ts",
      "line": 88,
      "context": "main",
      "reason": "reached_from_main"
    }
  ],
  "tests_affected": [
    {
      "file": "test_engine.py",
      "line": 88,
      "name": "test_load"
    }
  ],
  "summary": {
    "callers_count": 3,
    "callees_count": 2,
    "files_count": 3,
    "has_public_api_usage": false,
    "risk": "low"
  }
}
```

## 聚合逻辑（适配层内）

这是 `blast_radius` 区别于 `read_view` 的核心。它内部做六件事：

**① 找定义。** 通过符号名解析定义位置。用 PSI 的 `resolve` 或 Stub 索引。

**② 找引用。** 通过 PSI 的 `ReferencesSearch` 找所有引用点。这一步可能返回大量结果。

**③ 分类。** 每个引用点打标签：

- `is_test`：文件路径含 `test`、`spec`、`__tests__` 等
- `context`：引用点所在的函数名
- `is_public_api`：引用点在导出的公共符号内

**④ 找入口点。** 从定义出发，反向追踪调用链，找是否被 `main`、路由注册、公开 API
直接调用。这是 **可达性分析**的简化版——不做完整图遍历，只查一层或两层。

**⑤ 找受影响测试。** 在 `is_test` 的引用点里，提取测试函数名。

**⑥ 聚合。** 去重（同一文件多行引用合并）、排序（生产代码优先于测试）、截断（超过阈值只返回前
N 个 + 总数）。

## 渲染层输出

适配层返回结构化数据，渲染层翻译成 token 语义：

```
load() @ engine.ts:40 (method)
  callers: 3 [bar.ts:42 handleRequest, baz.ts:17 retry, test_engine.py:88 test_load]
  callees: 2 [json.load @ json/__init__.py:120, transform @ engine.ts:55]
  affected: 3 files
  entry: qux.ts:88 main ← reached_from_main
  tests: 1 [test_engine.py::test_load]
  risk: low
```

紧凑形式，模型一眼能判断“改这个符号的影响面”。

## 实现要点

- **性能**：全项目引用搜索可能慢（大项目几十万行）。适配层要缓存，同一符号短时间内重复查询直接命中。
- **PSI 优先**：优先用 PSI 的 `ReferencesSearch`，只有 PSI 不覆盖的语言才走 LSP。
- **截断阈值**：`callers` 超过 20 个时，只返回前 20 + `total_count`。渲染层显示
  `callers: 20+ (total 47)`。
- **风险评级**：`summary.risk` 由规则计算——公共 API 使用 → high；仅测试引用 →
  low；多处生产引用 → medium。

## 验收标准

- [ ] 给定符号，返回定义位置、调用者、被调用者
- [ ] 测试引用被正确标记 `is_test: true`
- [ ] 入口点能被识别（至少一层可达）
- [ ] 受影响测试被提取
- [ ] `callers` 超过 20 时正确截断
- [ ] 渲染层输出与样例格式一致
- [ ] 大项目下查询耗时 < 2s（PSI 索引已就绪时）
- [ ] 协议 fixtures：`fixtures/blast_radius/input.json` + `output.json`
- [ ] Java 端契约测试 + 客户端契约测试

## 与 `read_view` 的差异

| 维度       | read_view         | blast_radius              |
|------------|-------------------|---------------------------|
| 输入       | 文件路径 + 视图   | 符号名 + 范围             |
| 数据源     | 单文件 PSI + 诊断 | 跨文件引用搜索 + 可达性   |
| 聚合       | 无（渲染即取）    | 分类 + 去重 + 排序 + 截断 |
| 缓存       | 文件级            | 符号级                    |
| 性能敏感度 | 低（单文件）      | 高（跨文件）              |

**聚合逻辑是新增的复杂度。** `read_view` 的适配层是“取数据 + 翻译”，`blast_radius`
的适配层是“取数据 + 计算 + 翻译”。这验证适配层能否承载语义计算，还是只做数据搬运。

## 实现顺序

```
1. Java 端：定义、引用搜索、基础聚合
2. 客户端：协议解码 + 渲染
3. fixtures + 双向契约测试
4. 性能优化（缓存、截断）
5. 风险评级规则
```

前 3 步是 MVP，第 4、5 步是增强。

## 约束

- 不做完整调用图遍历——只查定义周围一层或两层
- 不做跨项目分析——scope 限定在当前项目
- 不做语义级影响（如“改了异常类型可能影响 catch 块”）——只做符号级引用
- 缓存失效跟随版本戳——文件变更时清空相关符号的缓存

## 验收证据要求

- [ ] 真实链路跑通：`blast_radius` 查询一个真实符号，返回聚合结果
- [ ] 渲染层输出包含所有字段
- [ ] 契约测试双向通过
- [ ] 大项目性能测试（如果有）或小项目基准
