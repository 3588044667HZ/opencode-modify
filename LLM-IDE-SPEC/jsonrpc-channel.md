### 目标

JSON-RPC over TCP loopback（`127.0.0.1`，locator 文件 + `hello` 握手，见 `tcp-transport.md`），连接 OC 和 IntelliJ。

### 协议

标准 JSON-RPC 2.0。方法列表：

```
hello(token) → {ok: true}    # 每条连接的首帧；未握手前调用其它方法返回 -32019 并断开
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

- 未握手 / token 错误：返回
  `{error: {code: -32019, message: "unauthorized"}}` 并关闭连接
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
