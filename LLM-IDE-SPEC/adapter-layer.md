### 目标

适配层，实现 `read_view`，聚合 IntelliJ 语义数据，返回结构化中间格式。

### 方法签名

```
read_view(file: string, view: "entry" | "sequential" | "continue" | "definition", 
          position?: {line: number}, symbol?: string) 
→ ReadViewResult
```

### 返回格式

```json
{
  "file": "engine.ts",
  "version": "a3f9c2",
  "size": {
    "lines": 320,
    "symbols": 6
  },
  "status": {
    "modified": true,
    "errors": 2
  },
  "position": {
    "current": 42,
    "total": 320,
    "in_symbol": "load",
    "remaining_symbols": 4
  },
  "content": [
    {
      "line": 40,
      "text": "def load(self, path):"
    },
    {
      "line": 41,
      "text": "    data = open(path)",
      "diagnostic": {
        "severity": "warning",
        "message": "type mismatch"
      }
    },
    {
      "line": 42,
      "text": "    return json.load(data)",
      "anchor": {
        "symbol": "json.load",
        "location": "json/__init__.py:120"
      }
    }
  ],
  "coverage": {
    "read": [
      [
        1,
        44
      ]
    ],
    "unread": [
      [
        45,
        320
      ]
    ]
  },
  "diagnostics": [
    {
      "line": 41,
      "severity": "warning",
      "message": "type mismatch"
    }
  ]
}
```

### 实现要点

- 调用 IntelliJ 的 PSI 获取文件内容
- 调用 Daemon Analyzer 获取诊断
- 调用 Stub 索引获取符号位置
- 调用 LSP 获取锚点（定义位置）
- 聚合、去重、按行号排序
- 版本戳来自 VFS 的 modification stamp

### 验收标准

- [ ] 返回内容包含行号、文本、诊断、锚点
- [ ] 位置感字段正确（`in_symbol`、`remaining_symbols`）
- [ ] 诊断按行号对齐到内容
- [ ] 锚点指向正确的定义位置
- [ ] 版本戳在文件修改后变化
