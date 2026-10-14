# `verify-test.md`

## 目标

运行测试命令，解析输出，返回结构化结果。这是写入侧闭环的另一半——`edit_batch` 改完，
`verify_test` 验证。它替代数据里 `bash→edit→bash` 706 次、`write→bash→write→bash`
332 次中的“验”部分。

## 方法签名

```
verify_test(command: string, options?: VerifyOptions) 
→ VerifyTestResult
```

- `command`：要执行的测试命令（如 `pytest`、`npm test`、`go test ./...`）
- `options`：
  - `cwd?: string` — 工作目录，缺省项目根
  - `timeout_ms?: number` — 超时，缺省 300000（5 分钟）
  - `env?: Record<string, string>` — 额外环境变量

## 返回格式

**成功（测试通过）：**

```json
{
  "command": "pytest",
  "exit_code": 0,
  "duration_ms": 12400,
  "summary": {
    "passed": 42,
    "failed": 0,
    "skipped": 3,
    "total": 45
  },
  "failures": [],
  "output_head": "...",
  "output_tail": "...",
  "parsed": true,
  "framework": "pytest"
}
```

**失败（测试未通过）：**

```json
{
  "command": "pytest",
  "exit_code": 1,
  "duration_ms": 12400,
  "summary": {
    "passed": 40,
    "failed": 2,
    "skipped": 3,
    "total": 45
  },
  "failures": [
    {
      "test": "test_engine.py::test_load_invalid_path",
      "file": "test_engine.py",
      "line": 42,
      "message": "AssertionError: expected ValueError, got None"
    },
    {
      "test": "test_api.py::test_timeout",
      "file": "test_api.py",
      "line": 88,
      "message": "TimeoutError: request took 5.2s, limit 3s"
    }
  ],
  "output_head": "...",
  "output_tail": "...",
  "parsed": true,
  "framework": "pytest"
}
```

**解析失败（未知框架或输出异常）：**

```json
{
  "command": "./custom-test.sh",
  "exit_code": 1,
  "duration_ms": 3000,
  "summary": null,
  "failures": [],
  "output_head": "...",
  "output_tail": "...",
  "parsed": false,
  "framework": null
}
```

解析失败时，`summary` 和 `failures` 为 null/空，模型只能看 `output_head`/
`output_tail`。

## 执行与解析

**执行：透传。** 命令原样交给 shell，不做任何包装或改写。工作目录、环境变量、超时由
options 控制。

**解析：薄层。** 不试图理解所有框架，只识别常见测试框架的输出模式：

| 框架       | 识别特征                                  | 提取                                   |
|------------|-------------------------------------------|----------------------------------------|
| pytest     | `===== N passed, M failed =====`          | 计数 + 失败列表（`FAILED path::test`） |
| jest       | `Tests: N passed, M failed`               | 计数 + 失败列表（`✕ test name`）      |
| go test    | `--- FAIL: TestName`                      | 失败列表                               |
| cargo test | `test result: FAILED. N passed; M failed` | 计数 + 失败列表                        |
| mocha      | `N passing, M failing`                    | 计数 + 失败列表                        |
| vitest     | 同 jest 格式                              | 同 jest                                |

**解析失败时**：`parsed: false`，模型看到原始输出，自行判断。

## 渲染层输出

**成功：**

```
verify_test pytest → PASS (12.4s)
  42 passed, 0 failed, 3 skipped
  exit 0
```

**失败：**

```
verify_test pytest → FAIL (12.4s)
  40 passed, 2 failed, 3 skipped
  FAILED test_engine.py::test_load_invalid_path (L42)
    AssertionError: expected ValueError, got None
  FAILED test_api.py::test_timeout (L88)
    TimeoutError: request took 5.2s, limit 3s
  exit 1
```

**解析失败：**

```
verify_test ./custom-test.sh → FAIL (3.0s, 未识别框架)
  exit 1
  output (last 20 lines):
    ...
```

紧凑形式，模型一眼知道通过/失败、失败在哪、原因是什么。

## 实现要点

- **超时处理**：超时 → 杀掉进程 → 返回 `exit_code: -1`，`timeout: true` 字段
- **输出截断**：`output_head` 和 `output_tail` 各保留 100 行，中间省略
- **失败列表截断**：超过 20 个失败只返回前 20 + `total_failures` 字段
- **框架识别**：按顺序尝试，命中即停
- **退出码优先**：即使解析成功，`exit_code != 0` 也标记为 FAIL
- **不修改文件**：只读执行，不做任何写操作

## 与其他原语的关系

| 原语            | 关系                                               |
|-----------------|----------------------------------------------------|
| `edit_batch`    | 典型的“改完就验”配对。edit 成功 → verify_test 确认 |
| `read_view`     | 提供文件内容和诊断，verify_test 提供运行结果       |
| `blast_radius`  | 提供影响范围，verify_test 验证修改是否安全         |
| `verify_syntax` | 静态检查（已嵌入 read），verify_test 是动态检查    |

## 实现顺序

```
1. Java 端：命令执行 + 超时 + 输出捕获
2. 框架解析器：pytest / jest / go test / cargo test
3. 客户端：协议解码 + 渲染
4. fixtures + 双向契约测试
5. 失败列表截断 + 输出截断
```

前 3 步是 MVP。

## 约束

- **透传命令**——不包装、不改写
- **薄解析**——只识别常见框架，解析失败降级为原始输出
- **无自动重试**——失败就是失败，不自动重跑
- **无缓存**——每次调用都真实执行
- **无并发控制**——第一版串行，多 agent 场景留给后续
- **只读执行**——不碰源文件

## 验收标准

- [ ] `pytest` 成功：返回 `exit_code: 0`，`summary.passed > 0`
- [ ] `pytest` 失败：返回失败列表，含文件名、行号、错误信息
- [ ] `jest` 识别并解析
- [ ] `go test` 识别并解析
- [ ] 未知命令：`parsed: false`，返回原始输出
- [ ] 超时：正确杀掉进程，返回 `timeout: true`
- [ ] 输出截断：超过 100 行时只保留头尾
- [ ] 失败列表截断：超过 20 个只返回前 20
- [ ] 渲染层输出与样例格式一致
- [ ] 协议 fixtures：`fixtures/verify_test/input.json` + `output.json`
- [ ] Java 端契约测试 + 客户端契约测试

## 验收证据要求

- [ ] 真实链路跑通：在 `sample-project` 上跑 `pytest`，返回结构化结果
- [ ] 失败路径验证：故意让测试失败，返回失败详情
- [ ] 解析失败验证：用未知框架命令，降级到原始输出
- [ ] 超时验证：用一个长时间命令，确认超时杀进程
- [ ] 契约测试双向通过

---

## 一个需要你确认的点

`verify_test` 的执行环境和权限。它本质上是 `bash` 的受限版本——同样执行命令，但只针对测试。两个问题：

1. **它和 `bash` 的关系**：是独立工具（模型直接调 `verify_test("pytest")`），还是
   `bash` 的语法糖（内部走 bash）？我倾向独立工具——它有专属的解析和渲染，不是简单透传。

2. **权限边界**：`verify_test` 能跑任意命令吗？还是只允许测试框架白名单？我倾向
   **允许任意命令**，但路径保护仍然生效（比如 `cwd` 不能在 `.venv` 里）。这和 `bash`
   的权限模型一致。

你确认这两点后，就可以交给 AI 实现了。
