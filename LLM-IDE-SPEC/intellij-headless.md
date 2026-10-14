### 目标

IntelliJ 无头守护进程，暴露 JSON-RPC 接口，提供 `read_view` 方法。

### 技术栈

- IntelliJ Platform Gradle Plugin
- 完整 JBR（不裁剪）
- 无头模式：`-Djava.awt.headless=true`
- 不加载 UI 模块

### 启动方式

```
java -Djava.awt.headless=true -jar intellij-semantic-server.jar <project_path> <socket_path>
```

### 生命周期

- 接收 `project_path`，加载项目模型，启动索引
- 索引期间通过 JSON-RPC 发 `indexing` 事件
- 索引完成后监听 socket，等待请求
- 空闲 30 分钟无请求则退出（可配置）

### 验收标准

- [ ] 启动后 10 秒内开始索引
- [ ] 索引期间能响应 `ping`（返回 `{indexing: true, progress: N}`）
- [ ] 索引完成后能响应 `read_view`
- [ ] 关闭时释放 socket 和项目资源

