# semantic-server —— IntelliJ 无头语义守护（MVP）

按 `LLM-IDE-SPEC/`（main / intellij-headless / jsonrpc-channel / adapter-layer）实现的 IntelliJ
无头语义守护：JSON-RPC 2.0 over AF_UNIX（NDJSON），提供 `ping` / `subscribe` / `read_view` / `shutdown`。
Java 实现，无 Kotlin，可在无 Gradle、无网络的条件下用本地 IDEA 平台 jar 直接构建。

## 目录

```
semantic-server/
├── src/main/java/opencode/semantic/
│   ├── SemanticServerStarter.java   # appStarter 入口（command: semantic-server），继承 ModernApplicationStarter
│   ├── Launcher.java                # 可执行 jar 入口：定位 IDEA/JBR、自装插件到 sandbox、拉起平台
│   ├── JsonRpcServer.java           # AF_UNIX JSON-RPC 服务（accept/读线程/推送/空闲超时/socket 清理）
│   ├── IndexMonitor.java            # DumbService 轮询 → notifications/indexing（阶段近似进度）
│   ├── ReadViewService.java         # read_view 聚合：PSI/VFS/引用 resolve/诊断
│   └── Log.java
├── src/main/resources/META-INF/plugin.xml   # appStarter EP + 最小依赖
├── script/build-local.sh            # javac + jar 打包 + 安装到 .sandbox/plugins
├── script/gradle-build.sh           # Gradle 离线构建（依赖固化在 .gradle-home/）
├── script/run-local.sh              # 用本地 IDEA 平台 + JBR 启动守护（镜像 bin/idea.bat）
├── script/probe.ts                  # Bun 探针：ping/subscribe/read_view/shutdown
├── script/protocol-conformance.ts   # 跨实现协议一致性测试（真实守护 ↔ OC 客户端）
├── sample-project/                  # 跨文件调用样例（Main/Greeter + 故意报错的 Broken，含 .idea/iml）
├── build.gradle.kts / settings.gradle.kts   # org.jetbrains.intellij.platform 2.2.1 + local IDEA 平台
├── .gradle-home/                    # Gradle 依赖仓库（项目本地，gitignore）
└── README.md
```

## 构建（已验证可用，无需网络）

```bash
bash script/build-local.sh
```

- 用本机 IDEA 的 `lib/*` + `plugins/java/lib/*`(+modules) 作 classpath，`javac --release 21` 编译；
- 产物：`build-local/semantic-server.jar`（含 `META-INF/plugin.xml` 与 `Main-Class`），
  同时安装到 `.sandbox/plugins/semantic-server/lib/`。

### Gradle 构建（依赖已固化，离线可用）

依赖全部落在本目录 `.gradle-home/`（已 gitignore），默认离线构建、不触网：

```bash
bash script/gradle-build.sh                   # --offline buildPlugin
GRADLE_ONLINE=1 bash script/gradle-build.sh   # 仅首次拉取依赖时需要
```

- 产物：`build/distributions/semantic-server.zip`（IntelliJ Platform Gradle Plugin 2.2.1 打包）；
- Gradle 8.5 运行在 JBR 21（`D:/Android Studio/jbr`，可用 `GRADLE_JAVA_HOME` 覆盖），
  编译由 `build.gradle.kts` fork `D:/jdk25` 的 javac 完成——IDEA 2026.2 平台类文件是
  Java 25（class file 69），Java 21 的 javac 读不了，而 Gradle 8.5 自身又不能跑在 Java 25 上；
- `buildSearchableOptions` 在无头构建环境禁用（不需要拉起 IDE 界面）；
- 已实测：`rm -rf build && bash script/gradle-build.sh` → 离线 `BUILD SUCCESSFUL`（约 2 分钟）。

## 运行

### 方式 A：脚本（推荐，插件在仓库 `.sandbox`）

```bash
bash script/run-local.sh [project_path] [socket_path] [--idle-seconds N]
# 默认: sample-project  .tmp/semantic.sock  1800s
```

### 方式 B：冻结接口 CLI 形式（插件自装到用户目录 sandbox）

```bash
java -Djava.awt.headless=true -jar build-local/semantic-server.jar <project> <socket> [--idle-seconds N]
# sandbox: ~/.opencode-semantic/sandbox（可用 SEMANTIC_SANDBOX 覆盖；IDEA 位置用 IDEA_HOME，默认 D:/IntelliJ IDEA 2026.2.0.1）
```

两者最终都以 `com.intellij.idea.Main semantic-server <project> <socket> --idle-seconds N` 启动平台并加载本插件。

### Bun 探针

```bash
bun script/probe.ts [socket_path] [--file path] [--symbol Name] [--early-read] [--shutdown] [--timeout secs] [--no-wait]
```

探针内置 OC 客户端的预期行为：`-32000` 轮询重试；连接卡住 15s 超时后重连重试。

### sample-project 的 JDK

`sample-project/.idea/misc.xml` 引用名为 `semantic-jdk` 的项目 SDK；`run-local.sh` / `Launcher`
首次运行会在 sandbox `config/options/jdk.table.xml` 生成该 JDK（home 默认 `D:/jdk25`，可用
`SEMANTIC_JDK_HOME` 覆盖）。**注意**：改过项目模型（.idea/iml）后要删除 `<sandbox>/system`
才能让平台重建 workspace model，否则沿用旧缓存。

## 已验证（本机，Windows + JBR 25）

- `bash script/build-local.sh`：编译通过，无错误（仅 build-local 后 jar 无警告）。
- 启动：socket 绑定后平台继续启动，项目打开约 1.3s，索引/扫描完成后 ready。
- `ping`：索引期 `{"indexing":true,"progress":0.2,"phase":"indexing","eta":45}` → ready
  `{"indexing":false,"progress":1,"phase":"ready"}`（进度为阶段近似，见"偏差"）。
- `subscribe`：`{"ok":true}`，随后持续收到 `notifications/indexing`
  （starting → indexing 递增 → ready）。
- 索引未就绪时 `read_view` 返回 `{"code":-32000,"message":"indexing","data":{"progress":0.02}}`。
- `read_view` 样例（Main.java entry，节选）：

```json
{
  "file": "src/main/java/demo/Main.java",
  "version": "1a1393c3bd9",
  "size": {"lines": 11, "symbols": 2},
  "status": {"modified": false, "errors": 0},
  "position": {"current": 1, "total": 11, "in_symbol": "Main", "remaining_symbols": 0},
  "content": [
    {"line": 3, "text": "import java.util.List;",
     "diagnostic": {"severity": "warning", "message": "Unused import statement"}},
    {"line": 7, "text": "        Greeter greeter = new Greeter(\"world\");",
     "anchor": {"symbol": "Greeter", "location": "src/main/java/demo/Greeter.java:3"}},
    {"line": 8, "text": "        String message = greeter.greet();",
     "anchor": {"symbol": "greeter.greet", "location": "src/main/java/demo/Greeter.java:10"}},
    {"line": 9, "text": "        System.out.println(message);",
     "anchor": {"symbol": "message", "location": "src/main/java/demo/Main.java:8"}}
  ],
  "coverage": {"read": [[1, 11]], "unread": []},
  "diagnostics": [{"line": 3, "severity": "warning", "message": "Unused import statement"}]
}
```

- `definition`：`{"view":"definition","symbol":"Greeter"}` → `file: src/main/java/demo/Greeter.java`，
  `position.current: 3`，`in_symbol: Greeter`（跨文件定位正确）。
- 版本戳变化：同一文件读两次（中间磁盘追加一行）`version: "1a1393ac8f5"` → `"c"`，
  `size.lines: 11 → 12`。
- `shutdown` → `{"ok":true}`，进程退出、socket 文件删除。
- 空闲超时：`--idle-seconds 10`，10s 无请求后日志 `idle timeout (10s)` → 进程退出、socket 删除。
- 诊断（headless best-effort）可用：行内诊断（如 `Unused import statement`）对齐到 content，
  `status.errors` 计数正确。

## 协议一致性测试

真实守护 ↔ 真实 OC 客户端（`packages/opencode/src/semantic`）跨实现一致性，
含原始 NDJSON 线级帧校验（严格 schema：多余字段即判失败）：

```bash
bun run semantic-server/script/protocol-conformance.ts
```

覆盖 10 类用例 / 62 条断言：ping 与索引期解码、subscribe 推送、索引未就绪 -32000、
entry 的 size.lines/覆盖/诊断/锚点对齐（含与磁盘逐行比对）、error 级诊断（`Broken.java`）、
-32001、definition 跨文件、shutdown 后 socket 关闭、原始帧 id 回显/顶层字段精确/严格解码。
当前状态：**CONFORMANCE PASS 62/62**。

## 启动方式尝试记录

1. 经典 `ApplicationStarter.main`：平台在 **EDT** 上调用 main，阻塞 EDT → 平台写操作全部卡死
   （"Cannot execute background write action in 10 seconds"）。→ 改为继承 `ModernApplicationStarter`
   （`getRequiredModality()==NOT_IN_EDT`，`start()` 在非 EDT 上下文执行）后解决。
2. `-Djava.awt.headless=true` 后平台进入 headless/command-line 模式，但需补齐 IDEA `bin/idea64.exe.vmoptions`
   的全部 `--add-opens`（首次缺 `java.desktop/sun.awt` 报 `IllegalAccessError`）。已按 idea.bat 全量补齐。
3. `-cp "<IDEA>/lib/*"` + `com.intellij.idea.Main` 直接启动可用（run-local.sh / Launcher 即此方式），
   无需 Gradle runIde。
4. `bin\idea64.exe` + IDEA_VM_OPTIONS 未采用（脚本方式已验证通过，不引入 GUI 启动器）。

## 偏差与已知限制

- **进度为阶段近似**：平台没有公开"精确索引百分比"API（DumbService 只有布尔量）。phase =
  starting / indexing / ready；indexing 进度按已耗时渐近估算（0.2→0.9），完成后 1.0；
  `eta` 为估算秒数。`current` 字段在 MVP 中省略（拿不到当前索引文件名）。
- **ready 判定有 5s 宽限**：躲开"扫描结束、索引未开始"的间隙；冷启动首轮索引期间 `read_view`
  返回 -32000，由客户端重试。
- **冷启动首个 `read_view`（尤其 definition）需要初始化 Java stub 索引**：本机实测首调约 2–3s，
  之后 ~10ms；与后台索引写操作竞争时可能 >15s。客户端应使用超时+重试（探针已内置）。
- **诊断**：headless 无编辑器时 daemon 不常驻跑；实现为 best-effort 手动跑 main passes
  （DaemonProgressIndicator + additional highlighting session），结果按版本戳缓存。
  某些文件/平台状态下可能为空列表。
- **`status.modified`**：取 `FileDocumentManager.isFileModified`（headless 无未保存文档，恒为 false）。
- **version 戳**：优先 VFS `modificationStamp`（十六进制）；新 VFS 实例上首次读可能为 0，
  退化为磁盘 mtime（同样随修改变化）。读时按 mtime 差异刷新 VFS（不做文件系统主动监听）。
- **view 语义（spec 未细化，MVP 约定）**：固定 80 行窗口；entry 从第 1 行；sequential/continue
  从 `position.line`（无 position 时从 1；状态在 OC，服务端无状态）；definition 解析
  `Class` / `Class#method` / 短名（JavaPsiFacade + PsiShortNamesCache），未命中时退化为从第 1 行读取。
  definition 的 `file` 字段返回定义所在文件（可能不同于请求文件）。
- **锚点**：每行取第一个可 resolve 的引用，跨文件优先；跳过 JDK/库的 `.class`（PsiCompiledElement）；
  `location` 为项目相对路径:行号。
- **`in_symbol` / `remaining_symbols`**：PSI 声明（类/方法/字段）近似；`in_symbol` 取最近的
  方法>类>字段，无声明时取文件名。
- **socket 路径**：Windows AF_UNIX 上限约 108 字符；CLI 会告警。
- Java PSI 依赖 `com.intellij.modules.java`（本机 IDEA 自带 Java 插件，已验证加载）。

## 对 OC 客户端的集成要点

- 启动：`bash semantic-server/script/run-local.sh <项目> <socket> --idle-seconds N`
  或 `java -Djava.awt.headless=true -jar semantic-server.jar <项目> <socket> --idle-seconds N`。
- 连接后先 `subscribe`（收到 `{ok:true}` 与首个 `notifications/indexing`），
  以 `ping.indexing==false` 作为可读信号；`read_view` 返回 -32000 时按 `data.progress` 等待重试。
- 空闲 N 秒（默认 1800）自动退出并删除 socket；`shutdown` 可显式退出。
