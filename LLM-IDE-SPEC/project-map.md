# `project-map.md`

## 目标

返回项目结构地图：模块划分、入口点、依赖关系、高频文件。这是第一个**项目级、只读、跨 agent 共享**的语义资源，也是多 agent 并行的认知基线。

它替代的是一连串 `ls -R`、`get-childitem`、目录探索——数据里 `find_paths` 相关调用 2,775 次，glob 空结果率 19.95%。

## 方法签名

```
project_map(view?: "structure" | "dependencies" | "hot", scope?: string) 
→ ProjectMapResult
```

- `view`：缺省 `structure`，返回模块树 + 入口
  - `structure`：模块划分 + 入口点
  - `dependencies`：模块依赖图
  - `hot`：高频访问文件
- `scope`：可选，限定范围（如 `module:core`）

## 返回格式

**`view: "structure"`（缺省）：**

```json
{
  "project": {"root": "/path/to/project", "total_files": 47, "total_modules": 6},
  "modules": [
    {
      "name": "core",
      "path": "src/core",
      "files": ["engine.py", "config.py", "types.py"],
      "is_entry": false,
      "hot": true
    },
    {
      "name": "api",
      "path": "src/api",
      "files": ["routes.py", "handlers.py"],
      "is_entry": false,
      "hot": false
    },
    {
      "name": "tests",
      "path": "tests",
      "files": ["test_engine.py", "test_api.py"],
      "is_entry": false,
      "hot": false
    }
  ],
  "entry_points": [
    {"file": "main.py", "line": 1, "symbol": "main", "kind": "main"},
    {"file": "src/api/routes.py", "line": 24, "symbol": "register", "kind": "route"}
  ],
  "root_files": ["main.py", "README.md", "TODO.md"]
}
```

**`view: "dependencies"`：**

```json
{
  "project": {"root": "/path/to/project", "total_files": 47},
  "dependencies": [
    {"from": "src/api", "to": "src/core", "count": 12},
    {"from": "src/core", "to": "src/utils", "count": 5},
    {"from": "tests", "to": "src/core", "count": 8},
    {"from": "tests", "to": "src/api", "count": 3}
  ],
  "cycles": []
}
```

**`view: "hot"`：**

```json
{
  "project": {"root": "/path/to/project", "total_files": 47},
  "hot_files": [
    {"file": "src/core/engine.py", "read_count": 47, "edit_count": 12, "last_access": "<timestamp>"},
    {"file": "TODO.md", "read_count": 23, "edit_count": 0, "last_access": "<timestamp>"},
    {"file": "src/api/routes.py", "read_count": 18, "edit_count": 4, "last_access": "<timestamp>"}
  ],
  "hot_modules": ["core", "api"]
}
```

## 聚合逻辑（适配层内）

### `structure` 视图

**① 模块划分。** 从项目模型获取模块结构，按 IntelliJ 的 Module 或目录约定划分。单模块项目降级为顶层目录划分。

**② 入口点识别。** 按语言规则：

- Python：`if __name__ == "__main__"`、`__main__.py`
- JavaScript/TypeScript：`package.json` 的 `main`/`bin`、`index.js` 导出
- Java：`public static void main`
- Go：`func main` in `package main`
- 路由注册：被框架的 `register`/`route`/`app.get` 调用的函数

**③ 热度标注。** 从会话历史统计（OC 侧提供，通过 RPC 传入）或文件访问时间戳推断。缺省不标注（第一版可以不做热度，等 OC 侧统计通道建好再加）。

**④ 截断。** 模块数 > 20 或文件数 > 200 时，只返回前 20 个模块 + 总数。

### `dependencies` 视图

**① 提取 import。** 从 PSI 解析每个文件的 import/require/use 语句。

**② 聚合到模块级。** 文件级依赖归并到模块级，统计跨模块依赖次数。

**③ 检测环。** 模块级依赖图的环检测。有环时返回 `cycles`。

### `hot` 视图

**① 数据来源。** 依赖 OC 侧的会话统计（read/edit 次数）。第一版可以只返回空列表或从 IntelliJ 的 VFS 访问时间推断。

**② 排序。** 按 read_count 降序。

## 渲染层输出

**`structure`：**

```
project: 6 modules, 47 files
  src/core/      [engine.py, config.py, types.py]  hot
  src/api/       [routes.py, handlers.py]
  src/utils/     [log.py, io.py]
  tests/         [test_engine.py, test_api.py]
  root:          [main.py, README.md, TODO.md]

entry: main.py:main (main), src/api/routes.py:register (route)
```

**`dependencies`：**

```
dependencies:
  src/api → src/core (12)
  src/core → src/utils (5)
  tests → src/core (8), src/api (3)
  cycles: none
```

**`hot`：**

```
hot files:
  src/core/engine.py      47 reads, 12 edits
  TODO.md                 23 reads
  src/api/routes.py       18 reads, 4 edits
hot modules: core, api
```

## 缓存策略（并行关键）

`project_map` 是**项目级**查询，比文件级查询贵，但变化频率低。缓存策略：

**① 项目级缓存。** 一份地图服务所有 agent。不是会话级，是项目级。

**② 失效触发条件：**

- 文件新增/删除 → 全量失效
- 符号增删 → `structure` 和 `dependencies` 失效
- 文件内容修改 → **不失效**（地图不关心内容）
- 依赖关系变化（import 增删） → `dependencies` 失效

**③ 线程安全。** 多 agent 并发调用时，用读写锁保护缓存。首次构建时加写锁，之后并发读。

**④ 构建成本。** 首次全量扫描可能慢（大项目几秒）。构建期间返回 `building: true, progress: N`，模型可选择等待或降级。

## 实现要点

- **PSI 优先**：模块结构、入口点、import 都从 PSI 提取
- **不读文件内容**：只看结构信息，不读文本
- **热度可选**：第一版可以只返回结构，热度等 OC 侧统计通道建好
- **截断阈值**：模块 20 个、文件 200 个，超过截断
- **根目录文件单独列出**：不在模块内的顶层文件（如 `main.py`、`README.md`）

## 与其他原语的关系

| 原语 | 关系 |
|---|---|
| `read_view` | 提供单文件视图；`project_map` 提供全局视图 |
| `blast_radius` | 用 `project_map` 的模块信息做 scope 限定 |
| `edit_batch` | 跨文件事务的第二版会用 `dependencies` 判断影响 |
| Blackboard | 多 agent 共享 `project_map`，作为共同认知基线 |

## 实现顺序

```
1. Java 端：模块结构 + 入口点（structure 视图）
2. Java 端：依赖提取 + 环检测（dependencies 视图）
3. 缓存 + 线程安全
4. 客户端：协议解码 + 渲染
5. fixtures + 双向契约测试
6. 热度视图（依赖 OC 侧统计通道）
```

前 4 步是 MVP，第 5 步是必须，第 6 步延后。

## 约束

- **只读**——不碰源文件
- **项目级缓存**——跨 agent 共享，线程安全
- **不读文件内容**——只看结构
- **热度延后**——第一版不做，等 OC 侧统计通道
- **单项目**——和 IntelliJ 守护进程的单项目假设一致

## 验收标准

- [ ] `structure` 返回模块列表 + 入口点
- [ ] `dependencies` 返回模块依赖 + 环检测
- [ ] `hot` 返回空列表或真实热度（视第一版范围）
- [ ] 大项目截断（模块 > 20）
- [ ] 多 agent 并发调用无冲突
- [ ] 项目级缓存，文件内容修改不失效
- [ ] 文件增删时缓存失效
- [ ] 渲染层输出与样例格式一致
- [ ] 协议 fixtures：`fixtures/project_map/input.json` + `output.json`
- [ ] Java 端契约测试 + 客户端契约测试

## 验收证据要求

- [ ] 真实链路跑通：对 `sample-project` 返回结构 + 依赖
- [ ] 并发验证：同时发起 10 个 `project_map` 调用，全部成功且结果一致
- [ ] 缓存验证：第二次调用明显快于首次（日志记录耗时）
- [ ] 契约测试双向通过

---

## 两个需要你确认的点

**① 热度数据从哪来。** `hot` 视图依赖“文件被 read/edit 多少次”的统计。这数据在 OC 侧的会话历史里，不在 IntelliJ。第一版可以：

- **A. 不做热度**，`hot` 视图返回空，只做 `structure` + `dependencies`
- **B. OC 侧统计后通过 RPC 传给 IntelliJ**，IntelliJ 把它合并进地图

我倾向 **A**——先做结构，热度等 OC 侧统计通道成熟再加。它不阻塞多 agent 并行这个核心价值。

**② 项目地图给谁看。** 是给模型（通过渲染层输出），还是给 OC 内部（用于 scope 过滤、缓存管理）？我倾向**两者都要**——模型看到渲染后的紧凑地图，OC 内部用结构化数据做导航。

你确认这两点后，就可以交给 AI 实现了。
