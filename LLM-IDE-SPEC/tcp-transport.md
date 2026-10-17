# TCP Loopback 传输（semantic transport 替换 AF_UNIX）

## 背景

现传输为 JSON-RPC over AF_UNIX 文件 socket。打包版桌面的 sidecar 运行在 Electron Node
中，而 Node/libuv 在 Windows 上不支持连接 AF_UNIX 文件 socket（实测 `EACCES`；Bun 正常）。
由此产生整条失败链：

1. manager 复用连接永远失败 → 删除 socket 文件 → 重新 spawn；
2. 若已有守护持有 sandbox（同一 `idea.system.path`），新 JVM 被平台单实例机制转发
   （`External instance command received` / `Only one instance of IDEA can be run at a time.`）
   并以 exit 1 退出 → 弹「启动失败」；
3. 若无守护，新守护就绪后 manager 仍连不上，`socketReadyTimeoutMs`（180s）超时后被
   `Process.stop` 杀掉（静默死亡，实测与 spawn+180s 精确吻合）。

平台自身对照（IDEA 2026.2 `com.intellij.platform.ide.bootstrap.DirectoryLock`）：同构
（Java↔Java）优先 UDS、以 `areUdsSupported` 判定并回退 TCP 端口 + `.port` 文件；
面向异构客户端一律 loopback TCP/HTTP（内置服务器 63342+）。本设计即采用其 TCP 回退路径
的等价形态，并按对端能力（Node/Bun/Java 共同支持）唯一定位到 TCP。

## 目标

- 传输改为 **TCP `127.0.0.1`（ephemeral port）**；NDJSON JSON-RPC 2.0 帧格式、方法语义、
  错误码、事件推送全部不变。
- 用 **locator 文件**发布 `{port, token}`；新增 **`hello` 握手**，作为最小边界防御。
- 消灭 AF_UNIX 相关全部限制：Node 不支持、Windows 路径长度、单实例转发副产物。

## 契约（冻结）

### locator 文件

- 路径：`<socket_dir>/opencode-semantic-<hash>.port`
  - hash 规则与现行 `socketPathFor` 完全一致（resolve/normalize、Windows 小写、SHA-1 前 10 hex）
  - `semantic.socket_dir` 配置含义不变（默认 `os.tmpdir()`）
  - 多语言批次起：显式指定 IDE 时追加 `-<ideKey>`（`opencode-semantic-<hash>-<ideKey>.port`，
    ideKey 规则见 `multilang.md`；auto 时维持原名）
- 内容：单行 JSON，守护绑定成功后**原子写入**（临时文件 + `ATOMIC_MOVE`）：

  ```json
  {"v":1,"port":51337,"token":"<32 hex>","pid":12345}
  ```

- 生命周期：优雅退出时删除；硬杀残留由 manager 在连接失败后删除（现状语义）。
- 旧 `.sock` 残留文件：不读取、不阻塞、不清理（无害）。

### 握手（协议新增 `hello`）

- 每条连接的**第一个**请求必须为：

  ```json
  {"jsonrpc":"2.0","id":1,"method":"hello","params":{"token":"<32 hex>"}}
  ```

- 成功：`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`，此后该连接可调用全部方法。
- 失败（token 不匹配）或 hello 之前调用任何其他方法：
  `{"jsonrpc":"2.0","id":N,"error":{"code":-32019,"message":"unauthorized"}}`，
  响应发出后关闭连接。
- `hello` 幂等（重复返回 ok）。
- token 每次守护启动由 `SecureRandom` 生成 128-bit（32 hex），只写入 locator 文件。
- `notifications/indexing` 只推送给已通过握手的连接；`subscribe` 语义不变。

### 监听与连接

- 守护绑定显式 IPv4 `127.0.0.1`、port 0（不用通配地址与 `::1`）；不使用 TLS。
- 客户侧超时沿用现状：复用探测 500ms；等待就绪 5s 连接超时 + 200ms 重试间隔；
  `socketReadyTimeoutMs` 180s；`indexPollIntervalMs` 1s。
- manager 复用判定：读 locator（缺失/解析失败视为无守护）→ TCP 连接 + `hello`；
  成功即复用；失败则删除 locator 后 spawn（保持现状回退语义）。
- spawn argv 形状不变：`[...command, <project>, <locator-path>]`（jar 不新增参数）。

## 非目标

- 不做双模（AF_UNIX 与 TCP 并存）；不保留 AF_UNIX 代码路径。
- 不做 TLS、多用户隔离、协议版本协商；`v` 字段仅为 locator 格式演进预留。
- 不改变平台单实例转发行为本身（两 JVM 抢同一 sandbox 时仍会转发退出；本次修复后
  正常路径不再触发它）。

## 变更清单

**Java（semantic-server/src/main/java/opencode/semantic/）**
- `JsonRpcServer`：`ServerSocket(127.0.0.1:0)`；locator 原子写入/退出删除；hello 门禁
  （未认证连接的其它方法一律 -32019 并关闭）；移除 AF_UNIX 与路径长度相关代码与日志。
- `SemanticServerStarter`：第二个 argv 语义 = locator 路径；启动日志
  `listening on 127.0.0.1:<port>`；其余（exclusions/idle fallback/项目打开）不动。
- `Launcher`：仅注释与日志措辞（转发 argv 不变）。

**TS（packages/opencode/src/semantic/ + 测试）**
- `transport.ts`：`connect({host, port}, opts)`（NDJSON 帧逻辑不变）；删除 AF_UNIX path 分支。
- `client.ts`：连接后自动 `hello`；失败/超时 → `ConnectionError`；对外 Client API 不变。
- `manager.ts`：`socketPathFor` → `locatorPathFor`（`.port`）；复用/等待/清理/回退逻辑
  按上文契约；dispose 时删除 locator（spawned 才删）。
- `protocol.ts`：帧级无变更（可选导出 `-32019` 错误码常量供测试引用）。
- 测试：`test/semantic/fake-daemon.ts`、`slow-daemon.ts` 改 TCP 监听 + 写 locator +
  校验 hello；`manager.test.ts` 断言 locator 路径与握手；`test/tool/*` 中复用 fake daemon
  的用例同步；conformance fixtures（方法级）不变。

**脚本（semantic-server/script/）**
- 新增共享 helper：读 locator → TCP 连接 → hello。
- `probe.ts` / `blast-probe.ts` / `edit-probe.ts` / `edit-txn-probe.ts` / `verify-probe.ts` /
  `map-probe.ts` / `protocol-conformance.ts` / `run-local.sh`：改用 helper；仍以 locator
  路径作为 CLI 参数（文件名/参数名更新为 locator）。
- `README.md`：传输、探针用法、环境变量章节同步。

**文档**
- 本 spec；`LLM-IDE-SPEC/jsonrpc-channel.md`（传输与 `hello`）；
  `LLM-IDE-SPEC/main.md` 决策行（连接）。

## 验收标准

- [ ] Electron Node（打包版 sidecar 运行时）能完成 ping / read_view —— 本次修复核心验收
- [ ] 未握手或 token 错误 → `-32019` 且连接关闭；握手后可 subscribe 并收到 `notifications/indexing`
- [ ] locator 原子写入；优雅退出删除；stale locator → 连接失败 → 删除 → spawn
- [ ] 复用路径成立：第二个 opencode 进程直接连接现有守护（不 spawn、不触发单实例转发）
- [ ] `packages/opencode`：manager/工具测试全绿、typecheck 干净（仅既有 provider 错误）
- [ ] `semantic-server`：`build-local.sh` 成功；`protocol-conformance.ts` 全绿
- [ ] 手工：app「预热语义引擎」→ starting→indexing→ready 全链路，进度条正常推进

## 风险与备注

- Windows 防火墙：绑定显式 `127.0.0.1` 不触发防火墙弹窗（通配绑定才触发）。
- token 威胁模型：本机同用户进程可读 locator 文件，token 防的是跨用户/误会话连接与
  误连，非强对抗；与平台 `.lock` 的边界防御同级。
- 升级期两版本互不兼容（旧守护只认 AF_UNIX，新客户端只连 TCP）；同仓库联动发布，
  升级时残留的旧守护由 30 分钟空闲超时自行退出。
