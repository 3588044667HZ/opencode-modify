### 目标

JSON-RPC over Unix socket，连接 OC 和 IntelliJ。

### 协议

标准 JSON-RPC 2.0。方法列表：

```
ping() → {indexing: bool, progress: number}
read_view(file, view, position?, symbol?) → ReadViewResult
shutdown() → {ok: true}
```

### 事件流

IntelliJ → OC 的推送：

```
notifications/indexing {phase: string, progress: number, current: string, eta: number}
```

OC 订阅方式：连接后发送 `subscribe` 请求，IntelliJ 持续推送。

### 错误处理

- 索引未就绪：返回
  `{error: {code: -32000, message: "indexing", data: {progress: N}}}`
- 文件不存在：返回 `{error: {code: -32001, message: "file not found"}}`
- IntelliJ 内部错误：返回 `{error: {code: -32603, message: "internal error"}}`

### 验收标准

- [ ] OC 能连接 socket 并发送 `ping`
- [ ] IntelliJ 能推送 `indexing` 事件
- [ ] OC 能发送 `read_view` 并收到结果
- [ ] 索引未就绪时返回正确错误码
- [ ] 连接断开后 IntelliJ 能感知（空闲退出）

---
