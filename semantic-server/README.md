# semantic-server —— IntelliJ 无头语义守护（MVP）

按 `LLM-IDE-SPEC/`（main / intellij-headless / jsonrpc-channel / adapter-layer / tcp-transport）
实现的 IntelliJ 无头语义守护：JSON-RPC 2.0 over TCP `127.0.0.1`（NDJSON + `hello` 握手），
提供 `ping` / `subscribe` / `read_view` /
`blast_radius` / `edit_batch` / `edit_transaction` / `verify_test` / `project_map` / `shutdown`。
Java 实现，无 Kotlin，可在无 Gradle、无网络的条件下用本地 IDEA 平台 jar 直接构建。

## 授权与支持范围

本项目需要你本机安装并**合法授权**的 JetBrains IDE（IDE 与授权均由使用者自行提供）。
本项目不捆绑、不下载、不修改、不绕过任何 JetBrains 软件与授权，也不会添加此类功能；
任何"配合未授权/破解版 IDE 使用"的支持请求不在受理范围。与 JetBrains 无官方关联。

## 目录

```
semantic-server/
├── src/main/java/opencode/semantic/
│   ├── SemanticServerStarter.java   # appStarter 入口（command: semantic-server），继承 ModernApplicationStarter
│   ├── Launcher.java                # 可执行 jar 入口：多源发现/选择 IDE、自装插件到 sandbox、拉起平台
│   ├── JavaSupport.java             # Java 能力探测（Class.forName 缓存）+ 项目 SDK 指派（semantic-jdk）
│   ├── JdkDiscovery.java            # JDK 发现：SEMANTIC_JDK_HOME > JAVA_HOME > 常见安装目录
│   ├── JsonRpcServer.java           # TCP JSON-RPC 服务（accept/读线程/hello 握手/推送/空闲超时/locator 读写）
│   ├── IndexMonitor.java            # DumbService 轮询 → notifications/indexing（阶段近似进度）
│   ├── ReadViewService.java         # read_view 聚合：PSI/VFS/引用 resolve/诊断
│   ├── BlastRadiusService.java      # blast_radius 聚合：定义/引用分类/入口/测试/callees/风险 + 缓存
│   ├── EditBatchService.java        # edit_batch：文件级公平锁/版本戳/路径保护/纯度/锚点/重叠 + 原子写 + 诊断增量
│   ├── EditTransactionService.java  # edit_transaction：多文件锁/journal/rename/启动恢复 + 复用 edit_batch 的校验与计算
│   ├── WriteGate.java               # 写路径共享门：journal 恢复失败 → 写拒绝（RPC -32018），读不受影响
│   ├── VerifyTestService.java       # verify_test：shell 透传/超时杀进程树/输出截断 + 六框架薄解析
│   ├── ProjectMapService.java       # project_map：项目级地图（模块/入口/依赖/环 + 项目级缓存/异步构建）
│   └── Log.java
├── src/main/resources/META-INF/plugin.xml   # appStarter EP + 最小依赖
├── script/resolve-env.sh            # 共享 IDE/JDK 发现（环境变量覆盖 + 注册表/Toolbox/常见路径）
├── script/build-local.sh            # javac + jar 打包 + 安装到 .sandbox/plugins
├── script/gradle-build.sh           # Gradle 离线构建（依赖固化在 .gradle-home/）
├── script/run-local.sh              # 用本地 IDEA 平台 + JBR 启动守护（镜像 bin/idea.bat）
├── script/connect.ts                # 共享连接入口：读 locator + TCP 连接 + hello 握手（各探针共用）
├── script/probe.ts                  # Bun 探针：ping/subscribe/read_view/shutdown
├── script/blast-probe.ts            # Bun 探针：blast_radius（fixtures 生成/缓存/scope 证据）
├── script/edit-probe.ts             # Bun 探针：edit_batch（模板块 copy/版本注入/并发 N 路/锁超时/fixtures 生成/raw NDJSON）
├── script/edit-txn-probe.ts         # Bun 探针：edit_transaction（模板重置/逐文件版本注入/并发 N 路/fixtures 归一/raw NDJSON）
├── script/verify-probe.ts           # Bun 探针：verify_test（raw NDJSON/超时/cwd 错误/fixtures 归一）
├── script/map-probe.ts              # Bun 探针：project_map（building 轮询/并发比较/fixtures 归一）
├── script/python-probe.ts           # Bun 探针：Python project_map/blast_radius（PyCharm + fixtures/python-project）
├── script/js-probe.ts               # Bun 探针：JS/TS project_map/blast_radius（IDEA/WebStorm + fixtures/js-project）
├── script/protocol-conformance.ts   # 跨实现协议一致性测试（真实守护 ↔ OC 客户端）
├── fixtures/blast_radius/           # 协议 fixtures：input.json + output.json（真实守护响应）
├── fixtures/edit_batch/             # 协议 fixtures：template.java + input.json + output.json（版本归一）+ lock_timeout.json（手写）
├── fixtures/edit_transaction/       # 协议 fixtures：input.json + output.json（版本归一）+ templates/{Alpha,Beta}.java（样本重置/恢复重跑）
├── fixtures/verify_test/            # 协议 fixtures：input.json + output.json（duration/输出归一）
├── fixtures/project_map/            # 协议 fixtures：input.json + output.json（project.root 归一）
├── sample-project/                  # 跨文件调用样例（Main/Greeter + 故意报错的 Broken + demo/txn 跨文件事务样本，含 .idea/iml；tests/ 1 过 1 败、tests_many/ 21 败，verify_test 用）
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
- Gradle 8.5 需要 Java 8–21 运行（不能跑在 Java 25 上）：缺省在 `SEMANTIC_JDK_HOME`/`JAVA_HOME`/
  常见 JDK 目录/IDE 自带 JBR 中发现，可用 `GRADLE_JAVA_HOME` 覆盖；编译由 `build.gradle.kts`
  fork 编译 JDK（`SEMANTIC_JDK_HOME` > `JAVA_HOME`，缺省当前 Gradle JVM）的 javac 完成——
  IDEA 2026.2 平台类文件是 Java 25（class file 69），低版本 javac 读不了；
- `buildSearchableOptions` 在无头构建环境禁用（不需要拉起 IDE 界面）；
- 已实测：`rm -rf build && bash script/gradle-build.sh` → 离线 `BUILD SUCCESSFUL`（约 2 分钟）。

## 运行

### 方式 A：脚本（推荐，插件在仓库 `.sandbox`）

```bash
bash script/run-local.sh [project_path] [locator_path] [--idle-seconds N]
# 默认: sample-project  .tmp/semantic.port  1800s
```

### 方式 B：冻结接口 CLI 形式（插件自装到按项目+发行版隔离的 sandbox）

```bash
java -Djava.awt.headless=true -jar build-local/semantic-server.jar <project> <locator> [--idle-seconds N]
# IDE 发现与选择见下节；sandbox 命名为
#   ~/.opencode-semantic/sandbox-<hash10>-<productCode><platformMajor>（如 -IU262 / -PY261），
#   可用 SEMANTIC_SANDBOX 覆盖（覆盖值原样使用）
```

**每项目 + 每发行版一个沙箱**：sandbox 目录按项目路径哈希（`hash10 = SHA-1(canonical project path)`
前 10 位十六进制，Windows 下 canonical 统一小写）与发行版后缀（`productCode` + `buildNumber` 前导数字段，
如 `IU262`）隔离；四个路径 config/system/plugins/log 都在该目录下，插件也装到该项目自己的 sandbox。
多个项目并发拉起守护时不再共享同一个平台沙箱，避免 IDEA 平台单实例锁把后启动的实例当成
`External instance command received` 转发后秒退；不同平台版本（261 vs 262）混用同一个 system
缓存会损坏，隔离是硬要求。

**迁移备注**：旧的 `sandbox-<hash10>`（无产品后缀）与更早的共享 `~/.opencode-semantic/sandbox`
都不再被 CLI/Launcher 引用，可直接删除；新目录首次启动会自动重建（含 jdk.table.xml 与插件安装）。
dev 直启（不经 Launcher，因而没有注入 `SEMANTIC_SANDBOX_PATH`）时 `exclusionsSandbox()` 仍回退旧命名
`sandbox-<hash10>`，仅作开发用途。

### IDE 发现与选择（Launcher）

优先级（冻结，高→低）：

1. 显式路径：`SEMANTIC_IDE_HOME` > `IDEA_HOME` > `IDEA_DIR`（legacy 别名）；`SEMANTIC_IDE` 的值含
   路径分隔符（`/` 或 `\`）时也按路径处理；
2. 产品选择器：`SEMANTIC_IDE` = `auto | idea | pycharm | webstorm | clion | goland | phpstorm | datagrip |
   rider | rubymine`（映射 `idea→IU/IC`、`pycharm→PY/PC`、`webstorm→WS`、`clion→CL`、`goland→GO`、
   `phpstorm→PS`、`datagrip→DB`、`rider→RD`、`rubymine→RM`；未装对应产品时报错并列出全部候选）；
3. 自动发现 + 按项目语言自动选择：分层信号扫描（有界：跳过隐藏目录与排除默认目录
   `venv/node_modules/build/out/target/dist/__pycache__`，深度 ≤4，条目上限 5000）：
   - **tier-1 决定性信号**（任一命中即定性，优先于计数）：标准布局根 `src/main/java`/
     `src/test/java`/`src/main/kotlin`；根 `*.iml` 或 `.idea/*.iml` 中 `type="JAVA_MODULE"`；
     构建清单 `pom.xml`/`build.gradle*`/`settings.gradle*`→Java，`pyproject.toml`/`setup.py`/
     `requirements*.txt`→Python，`package.json`/`tsconfig.json`→JS/TS（`*.html` 单独不作数，弱信号）；
   - **tier-2 回退/补充**：无 tier-1 命中时按合并扩展名计数取主导语言（`.java`/`.py`/`.ts,.tsx`/
     `.js,.jsx`/`.html`）；计数同时进入日志证据。
   能力校验按发行版 `plugins/` 目录（python* / javascript-plugin / java / html-tools）。决策：
   tier-1 命中直接决定语言集合，否则取主导计数语言；选"覆盖语言数最多"的发行版，平票按偏好序
   `IU > PY > WS > PC`（JS/TS/HTML: `IU>WS`；Python: `PY>PC`；Java: `IU`）；无单一发行版能全覆盖
   （混合仓库）时按偏好序选靠前者，并在日志提示"可用 `semantic.ide` 显式指定"。stderr 日志给出完整
   证据（tier-1 命中、各语言计数、选中产品与原因），如
   `auto: tier1=[java: src/main/java] counts={java=2} needed=[java] -> IU covers 1/1 (reason=tier-1 evidence)`。

发现源（Windows 优先，其余平台为轻量兜底）：Windows 卸载表注册项（HKLM + HKCU
`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`，`DisplayName` 匹配 JetBrains 产品族，取
`InstallLocation`；本机实测为主可靠源）、Toolbox（`%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\`
与 `scripts\*.cmd` 垫片提示）、常见路径（`C:\Program Files\JetBrains\*`、
`%LOCALAPPDATA%\Programs\JetBrains\*`）；macOS `/Applications/*.app`；Linux
`~/.local/share/JetBrains/Toolbox/apps`。每个候选都必须通过 `product-info.json`（可读
`productCode`/`buildNumber`）与 `<dir>/lib` 校验；发现/选择过程会把全部候选与选中原因打到 stderr 日志。
发现逻辑只回答"装在哪"，不读取任何授权状态。

### App 侧自动发现与免 JDK 启动（客户端）

目标机可能没有系统 JDK。用户配置 `semantic.enabled=true`（默认 false，可在全局
`opencode.json` 或分发默认配置中开启）且**未配置 `semantic.command`** 时，客户端在
实例物化阶段自动组装启动命令：

1. **jar**：`semantic.jar` > `OPENCODE_SEMANTIC_JAR` / `SEMANTIC_JAR` > 打包资源
   `resources/semantic-server/semantic-server.jar` > 开发目录 `semantic-server/build-local/`；
2. **IDE**：发现源与 Launcher 相同（显式 `semantic.ide_home`/`semantic.ide` 路径 > 卸载表注册项 >
   Toolbox > 常见路径），每个候选校验 `product-info.json`、`lib/` 与 `jbr/`；
3. **选择**：显式 selector（`semantic.ide=idea|pycharm|webstorm|...`）优先，否则按项目语言
   （tier-1 清单/布局优先，tier-2 扩展名计数回退）与固定偏好序 `IU > PY > WS > PC`；
4. **命令**：`<IDE>/jbr/bin/java[.exe] -Djava.awt.headless=true -jar <jar>`，并把选中的
   `SEMANTIC_IDE_HOME` 注入守护环境，Launcher 复用同一 IDE；目标机无需系统 JDK，但仍需用户
   自行安装/授权 JetBrains IDE。

自动选择会为 locator 追加 `-<ideKey>`（与显式 IDE 一致），避免自动选择变化时复用错误的守护；
显式命令且未指定 IDE 时维持原名。发现结果进程内缓存 60s；新装 IDE 可等待缓存过期或重启应用。
显式 `semantic.command` 完全保持原行为，不触发上述发现。

**项目 SDK 指派**：Java 能力可用的发行版打开项目后，若项目尚无 SDK（裸目录项目没有 `.idea/misc.xml`），
按 `SEMANTIC_JDK_HOME` > `JAVA_HOME` > 常见 JDK 目录（`C:\Program Files\Java\*`、
`C:\Program Files\Eclipse Adoptium\*` 等）发现 JDK，在 `ProjectJdkTable` 查找/创建 `semantic-jdk`
（与 Launcher 生成 `jdk.table.xml` 的名字一致，可直接复用）并 `setProjectSdk`（EDT + WriteAction，
失败仅警告）。SDK 指派是必要而非充分条件：`PsiShortNamesCache` 只遍历 Java source root，SDK 已指派
但模块没有 source root（仓库根 `WEB_MODULE` iml、裸目录默认模块）时项目类仍不可解析——所以同一
步骤还会补齐 source root（见下）。无 Java 模块的发行版
（PyCharm/WebStorm）下 `com.intellij.modules.java` 为 optional 依赖：`blast_radius` /
`project_map` 在 Java、Python 或 JS/TS 能力任一可用时开放（按被分析对象语言分派，W7/W8）；
三者都不可用才返回
`-32603 java/python/javascript support unavailable in this IDE distribution`；read_view 语言无关
（见"偏差与已知限制"的语言支持条目），其余功能不受影响。

**Java source root 补齐**：打开项目后（与 SDK 指派同一步）对每个模块 content entry：已有 source root
的不动；否则在 content root 下（有界：深度 ≤4、跳过隐藏与排除默认目录、最多访问 50 个目录）搜索
`src/main/java` / `src/test/java`，命中即 `addSourceFolder`（`src/test/java` 标记为测试源）；找不到
布局根但存在 `.java` 文件时把 content root 本身加为 source root（覆盖裸 A.java/B.java 目录）。不做
模块类型转换、不触碰既有 source root；EDT + WriteAction、幂等、失败仅告警。失败/新增情况在守护日志
`java source roots ensured` / `java source root added` 可见。

两者最终都以 `com.intellij.idea.Main semantic-server <project> <locator> --idle-seconds N` 启动平台并加载本插件。

### 传输与握手（locator / hello）

- 传输：JSON-RPC 2.0 over TCP `127.0.0.1`（ephemeral port，port 0 由系统分配；无 TLS），
  NDJSON 帧（一行一个对象，UTF-8）；方法语义、错误码、事件推送与 AF_UNIX 时代一致；
- locator 文件：守护绑定成功后**原子写入**（同目录临时文件 + `ATOMIC_MOVE`），单行 JSON：

  ```json
  {"v":1,"port":51337,"token":"<32 hex>","pid":12345}
  ```

  token 每次守护启动由 `SecureRandom` 生成 128-bit（32 hex），只写入 locator 文件；
  优雅退出（`shutdown` / 空闲超时）删除 locator；硬杀残留由客户端在连接失败后删除；
- 握手：每条连接的**第一个**请求必须是

  ```json
  {"jsonrpc":"2.0","id":1,"method":"hello","params":{"token":"<32 hex>"}}
  ```

  成功回 `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`，此后该连接可调用全部方法；
  token 不匹配或 hello 之前调用任何其他方法 → `{"code":-32019,"message":"unauthorized"}`
  并在响应发出后关闭连接；`hello` 幂等；`notifications/indexing` 只推送给已握手的连接
  （`subscribe` 语义不变）。

### Bun 探针

```bash
bun script/probe.ts [locator_path] [--file path] [--symbol Name] [--early-read] [--shutdown] [--timeout secs] [--no-wait]
```

探针内置 OC 客户端的预期行为：`-32000` 轮询重试；连接卡住 15s 超时后重连重试。

### sample-project 的 JDK

`sample-project/.idea/misc.xml` 引用名为 `semantic-jdk` 的项目 SDK；`run-local.sh` / `Launcher`
首次运行会在 sandbox `config/options/jdk.table.xml` 生成该 JDK（JDK 按 `SEMANTIC_JDK_HOME` >
`JAVA_HOME` > 常见目录发现，见"IDE 发现与选择"；Launcher 未发现或无 jmods 时跳过生成，改由插件
打开项目后经 `ProjectJdkTable` API 指派）。**注意**：改过项目模型（.idea/iml）后要删除
`<sandbox>/system` 才能让平台重建 workspace model，否则沿用旧缓存。

### 目录排除与空闲超时（环境变量）

- `OPENCODE_SEMANTIC_EXCLUDE`：JSON 字符串数组（opencode manager 在 `semantic.exclude` 非空时
  注入）；与内置 defaults（`venv node_modules build out target __pycache__ dist`）取并集。
  模式语义：不含 `/` 且不含 glob 元字符（`*?[{`）的条目按目录名匹配（任意层级；Windows 忽略
  大小写）；其余按项目相对路径（`/` 分隔）做 `PathMatcher` `glob:` 匹配（支持 `**`；Windows 下
  模式与路径先转小写）。只匹配目录、从不匹配文件；`.` 开头的隐藏目录与目录符号链接天然跳过。
  作用：① 项目模型——所有模块 content root 下的命中目录在打开项目后自动加为 Exclude Folder，
  并按 `<sandbox>/exclusions.json`（sandbox = `SEMANTIC_SANDBOX_PATH`，Launcher 注入；
  dev 直启缺省回退 `~/.opencode-semantic/sandbox-<sha1-10(小写 canonical 项目路径)>`）对账（不再命中且仍存在的
  移除、新命中的新增）；② `project_map` 扫描与失效指纹（命中目录不入模块、不下钻、目录项集合
  不记录）。显式 `read_view` / `edit_batch` / `edit_transaction` 仍可读写被排除文件（IntelliJ 语义）。
- `OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS`：整数毫秒，仅在未传 `--idle-seconds` 时生效
  （idleSeconds = ceil(ms/1000)）；缺失/非法回退默认 1800s。

## 已验证（本机，Windows + JBR 25）

- `bash script/build-local.sh`：编译通过，无错误（仅 build-local 后 jar 无警告）。
- 启动：TCP 绑定 + locator 写入后平台继续启动，项目打开约 1.3s，索引/扫描完成后 ready。
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
- `shutdown` → `{"ok":true}`，进程退出、locator 文件删除。
- 空闲超时：`--idle-seconds 10`，10s 无请求后日志 `idle timeout (10s)` → 进程退出、locator 删除。
- 诊断（headless best-effort）可用：行内诊断（如 `Unused import statement`）对齐到 content，
  `status.errors` 计数正确。

## 协议一致性测试

真实守护 ↔ 真实 OC 客户端（`packages/opencode/src/semantic`）跨实现一致性，
含原始 NDJSON 线级帧校验（严格 schema：多余字段即判失败）：

```bash
bun run semantic-server/script/protocol-conformance.ts
```

覆盖 43 类用例 / 162 条断言：ping 与索引期解码、subscribe 推送、索引未就绪 -32000、
entry 的 size.lines/覆盖/诊断/锚点对齐（含与磁盘逐行比对）、error 级诊断（`Broken.java`）、
-32001、definition 跨文件、edit_batch、verify_test（真 pytest 与 fixture 归一后深度一致、
未知命令降级、超时杀进程、失败/输出截断、cwd -32013/-32001、渲染逐字节）、shutdown 后
连接关闭、原始帧 id 回显/顶层字段精确/严格解码、读时对账与 warnings。
当前状态：**CONFORMANCE PASS 162/162**。

Python 语义工具（project_map / blast_radius）用独立探针验证（不依赖 Java 夹具）：

```bash
SEMANTIC_IDE=pycharm SEMANTIC_JAR=semantic-server/.tmp/semantic-server-w7.jar \
  bun semantic-server/script/python-probe.ts
```

探针启动 PyCharm 守护（默认 `SEMANTIC_IDE=pycharm`，可用 `--ide-home` 覆盖），对
`fixtures/python-project` 校验目录模块、路由/main 入口、import 依赖、定义/调用者/callees/
测试标记、`file:` scope 与未知符号 -32002；当前状态 **PYTHON PROBE PASS 15/15**。

JS/TS 语义工具同样有独立探针（默认 `SEMANTIC_IDE=idea`，可设 `webstorm` 验证无 Java/Python
发行版）：

```bash
SEMANTIC_IDE=idea SEMANTIC_JAR=semantic-server/.tmp/semantic-server-w7.jar \
  bun semantic-server/script/js-probe.ts
```

覆盖 `package.json` main、Express 路由、`main` 入口、tsconfig 别名依赖、名称级调用者/测试标记、
`file:` scope、未知符号 -32002 与“< 30s 无卡死”；当前状态 **JS PROBE PASS 16/16**（IDEA 与
WebStorm 均通过）。

## blast_radius（符号影响面）

`blast_radius(params)`：`{"symbol": string, "scope"?: string}`。scope 只识别 `file:<项目相对路径>`
（限定全部 ReferencesSearch；文件不存在 → `-32001 file not found`），其他前缀忽略（全项目搜索；
scope 非字符串 → `-32603`）。

响应字段（冻结协议）：

- `definition: {file, line, kind}`（kind 小写：method/class/field/parameter/unknown；line 从 1 起）；
- `callers: [{file, line, context, is_test}]`：全量按“生产优先 → file → line”排序；>20 截断为前 20，
  此时 `summary.callers_count=20` 且出现 `summary.callers_total=全量数`（未截断时无该字段）。
  context=引用点最近外层 PsiMethod 名，无则最近 PsiClass 名，再无则文件名；
  is_test=小写路径含 test/spec/__tests__；
- `callees: [{symbol, file, line}]`：定义体（PsiMethod）内可解析到项目源码（有 VirtualFile 且非
  PsiCompiledElement）的 method/field/class；目标类与定义类不同时 symbol=`ClassName.name`；
  去重 (symbol,file,line)、按 file,line 排序、上限 50；PsiClass 定义时 callees=[];
- `affected_files: [string]`：定义文件 + 非测试 caller 文件，去重、字典序；
- `entry_points: [{file, line, context, reason}]`：level1（caller 的 context 本身就是 main）或
  level2（对每个非测试 context 方法做一次 ReferencesSearch，其使用点 context 为 main）；
  reason 固定 `reached_from_main`；去重 (file,line)、上限 10；
- `tests_affected: [{file, line, name}]`：从全量测试 caller 提取（不受 callers 截断影响），
  name=context，按 file,line 去重排序；
- `summary: {callers_count, callers_total?, callees_count, files_count, has_public_api_usage, risk}`：
  risk = has_public_api_usage → high；否则生产 caller 数=0 → low；否则 medium。
  has_public_api_usage = 任一 caller 的最近外层方法/类声明带 public。

缓存与限时：静态 Map，键 `symbol|scope`，以 `PsiModificationTracker.getInstance(project).getModificationCount()`
为失效基准（2026.2 中该 API 在 `com.intellij.psi.util`，已用 `javap` 核实），上限 100 条（LRU）；
命中/未命中分别打日志。每次查询时间预算 1.5s：累计超时后停止 level2 入口追踪并吞掉剩余 callees。

校验证据（真实守护 + sample-project）：

- fixtures：`fixtures/blast_radius/input.json`（`{"symbol":"run"}`）+
  `fixtures/blast_radius/output.json`（真实响应原样美化落盘）；
  生成命令：`bash script/build-local.sh` →
  `bash script/run-local.sh sample-project .tmp/blast.port --idle-seconds 600` →
  `bun script/blast-probe.ts .tmp/blast.port --early --out fixtures/blast_radius/output.json`；
- `{"symbol":"run"}` → definition `TaskEngine.java:4 method`；callers 全量 23（ManyCallers 21 +
  TaskWorker 1 + TaskEngineTest 1）截断为 20，`callers_total=23`；callees `format @ TaskEngine.java:8`；
  affected 3 files（ManyCallers/TaskEngine/TaskWorker）；entry `TaskRunner.java:5 main`；
  tests `TaskEngineTest.java:5 runIsStable`；`has_public_api_usage=false`，risk medium；
- `{"symbol":"greet"}` → caller `Main.java:8 main`（public）→ `has_public_api_usage=true`，risk high；
- scope `file:src/main/java/demo/tasks/TaskEngineTest.java` → 仅测试 caller（runIsStable），risk low；
- 错误码：索引期 `-32000`（`data.progress`，与 read_view 相同）；`{"symbol":"nosuch"}` → `-32002
  symbol not found`；缺失 scope 文件 → `-32001`；非字符串 scope → `-32603`；
- 缓存：连续 3 次同 modificationCount 查询日志为 `cache hit`（首次 `cache miss (computed)`，modCount
  不变）；磁盘把 ManyCallers 的 `run` 调用从 21 处改为 22 处并刷新 VFS 后查询 → `cache miss` 且
  `callers_total` 23→24；还原后回到 23（两种情况下 callers 列表均正确截断到 20）。

偏差说明：

- `callers` 按调用点去重（不按文件合并），以保留每个调用点的行号；
- `is_public_api` 不作为 caller 字段输出，仅聚合进 `summary.has_public_api_usage`；
- `callees` 不包含 JDK/库编译类（PsiCompiledElement），只保留可解析到项目源码的目标；
- 实现注记：`blast_radius` 分支加在 `SemanticServerStarter` 的 handler switch（`JsonRpcServer`
  只提供通用传输层与分发），就绪检查与 read_view 一致；
- 冷启动竞态：向项目新增文件后首次打开时，短名索引更新可能略滞后于 ready 判定，此时查询可能
  返回 `-32002`；稍候重试即可（索引预热后本机未复现）。

## edit_batch（单文件多区域原子编辑）

`edit_batch(params)`：`{"file": string, "changes": [{"oldString": string, "newString": string,
"description"?: string}], "baseVersion": string, "options"?: {"lock_timeout_ms"?: number}}`。
单文件、文本锚点、全成功或全失败的原子编辑；写路径基础设施（文件级互斥锁、版本戳校验、路径保护、
纯度校验、原子写）在此首次落地。`options.lock_timeout_ms` 为可选文件锁等待上限（毫秒，缺省
30000；出现时必须 ≥1，否则 RPC -32603）。

成功结果：

- `file / applied / changes_applied / changes_total / old_version / new_version`；
- `diagnostics_delta: {errors, warnings}`：改前 vs 改后的诊断差异（delta = after - before）；
- `diagnostics_after: {errors, warnings}`：扩展字段（渲染“改前→改后”需要，冻结协议只要求 delta）；
- `line_changes: [{line, action}]`：新内容坐标、逐行输出；action 规则：`newString` 为空 →
  `deleted`（删除点 1 条）；新行数 > 旧行数 → `inserted`（逐行）；否则 `modified`（k 行 k 条）。

失败结果（仍是 JSON-RPC 成功响应，`result.applied=false`）：

```json
{"applied": false, "file": "src/main/java/demo/tasks/EditableSample.java", "changes_total": 1,
 "error": {"code": -32011, "message": "ANCHOR_NOT_UNIQUE",
           "detail": {"change_index": 0, "oldString": "count", "match_count": 2, "locations": [4, 6]},
           "hint": "提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具"}}
```

| 码 | 名称 | 触发 | detail |
|----|------|------|--------|
| -32010 | `ANCHOR_NOT_FOUND` | `oldString` 在文件中找不到 | change_index, oldString |
| -32011 | `ANCHOR_NOT_UNIQUE` | `oldString` 匹配多处 | change_index, oldString, match_count, locations（行号） |
| -32012 | `VERSION_MISMATCH` | `baseVersion` 与当前版本不符 | current_version, content |
| -32013 | `PATH_PROTECTED` | 路径命中保护列表 | path |
| -32014 | `CONTENT_IMPURE` | `newString` 含渲染层元语 | change_index, marker |
| -32015 | `WRITE_FAILED` | 临时文件写入/rename 失败 | reason |
| -32016 | `CHANGE_CONFLICT` | 两个 change 的锚点区间相交（spec 要求拒绝但未定义码，本实现新增） | change_index, conflict_with_index |
| -32017 | `LOCK_TIMEOUT` | 等待文件锁超过 `options.lock_timeout_ms`（缺省 30s） | file, waited_ms |

-32011 的 hint 为 spec 原文；其余为同风格中文短提示。文件不存在仍是 RPC 错误 `-32001`
（与 read_view 一致）；参数缺失/类型错/空 changes/空 oldString 是 RPC `-32603`。

处理顺序（冻结）：

① 参数校验（-32603，含 `options.lock_timeout_ms` ≥ 1 校验）→ ② 路径保护（保护段 `.venv/ venv/
env/ node_modules/ .git/ .idea/ dist/ build/ target/ out/ __pycache__/ .pytest_cache/ .mypy_cache/`，
后缀 `*.lock *.min.js *.min.css *.iml`；命中即 -32013，**先于存在性检查**）→ ③ 文件不存在 → RPC
-32001 → ④ **规范化绝对路径后获取文件互斥锁**（公平队列，超时 `lock_timeout_ms`；超时 → -32017）
→ 锁内：读内容 + 当前版本（先按 mtime 差异 refresh VFS）→ ⑤ `baseVersion` 不匹配 → -32012
（返回 current_version + content）→ ⑥ 纯度（`[err:`、`→ def@`、`L\d+ \[`、`pos: L\d+`）→ ⑦ 锚点
恰好出现 1 次（非重叠计数；0 → -32010，>1 → -32011）→ ⑧ 两锚点区间相交 → -32016（相邻不算）
→ ⑨ 从后往前内存应用 → ⑩ 诊断 before 计数 → ⑪ 原子写 → ⑫ VFS refresh + 新版本 → ⑬ 诊断
after、delta、line_changes → `finally` 释放锁。

原子写：同目录 `<file>.tmp` → `FileChannel.force(true)` fsync → `Files.move(ATOMIC_MOVE,
REPLACE_EXISTING)` 覆盖；任何失败清理 .tmp 并返回 -32015（本机 Windows 实测
ATOMIC_MOVE+REPLACE_EXISTING 可用）。写入绕过平台保存路径，写后执行 VFS refresh，并在 EDT 上
按需 `FileDocumentManager.reloadFromDisk` + `PsiDocumentManager.commitAllDocuments`，保证
PSI/诊断基于新内容重算；诊断计数复用 ReadViewService 的 `collectDiagnostics` 与手动高亮缓存
（缓存键含 VFS modificationStamp，写后自动 miss）。

缓存失效：写入触发 PSI 变更 → `PsiModificationTracker` modCount 变化，`BlastRadiusService`
静态缓存自动失效（无需显式通知）——实测连续查询 `cache hit`（modCount=16）后编辑一次，
再查询为 `cache miss (computed)`（modCount=20）。

### 并发写保护（文件级公平锁 + 锁内版本校验 = 串行等价）

多 agent 并发编辑同一文件时保证串行等价——不会出现"两个写者基于同一版本，后写覆盖先写"的
静默覆盖。机制：

- **锁**：`ConcurrentHashMap<String, ReentrantLock>`（fair=true，FIFO），key 为与 `resolvePath`
  同口径规范化后的绝对路径（`./x`、`x`、反斜杠均归一为同一把锁）；锁保留在 map（避免频繁
  创建），仅写路径加锁；等待 >1s 记录 WARN，等待超时（缺省 30s，`options.lock_timeout_ms`
  可配）返回 -32017。
- **锁内校验**：获得锁后才读内容、取当前版本、校验 `baseVersion`，随后应用并原子写——读+
  校验+写之间没有窗口期。只有锁没有校验会串行写错版本；只有校验没有锁存在窗口期；两者
  缺一不可。
- **FIFO / 无死锁**：公平队列按到达顺序授予，避免饥饿；edit_batch 只锁单个文件，不会出现
  "A 持 X 等 Y、B 持 Y 等 X"。锁不跨文件、不跨进程、不持久化。
- **顺序**：参数校验、路径保护、存在性检查都在锁外（失败快速返回，不占锁）；从读内容+版本
  校验开始的全部步骤在锁内；`finally` 无条件释放。
- **平台写路径执行门（无头环境适配）**：无头守护里多个 manual highlight（`runMainPasses` →
  `ExternalToolPass`）会形成平台锁环——manual pass 持读许可空等外部注解任务、后台注解任务
  等读许可、VFS refresh 等写意图，实测每个等待者要空等 `ExternalToolPass` 的 60s 超时才返回
  （thread dump 实证；并发 `read_view` 同样会空等 30s+）。因此"读内容 → 校验 → 写 → VFS
  refresh → 诊断"这段由进程内一把公平门串行执行。文件锁与锁内版本校验语义完全不变（同文件
  仍按 FIFO 排队，-32017 仍只由文件锁等待产生）；影响是不同文件的并发编辑会依次完成。
- **-32017 失败结果**（仍为 JSON-RPC 成功响应，`result.applied=false`）：

```json
{"applied":false,"file":"src/main/java/demo/tasks/EditableSample.java","changes_total":2,
 "error":{"code":-32017,"message":"LOCK_TIMEOUT",
          "detail":{"file":"src/main/java/demo/tasks/EditableSample.java","waited_ms":30000},
          "hint":"文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本"}}
```

- **读不加锁**：`read_view` / `blast_radius` / `project_map` / `verify_test` 不获取写锁，可能
  读到旧版本，但返回的版本戳标注了这一点。
- **崩溃后锁消失**：锁只存在守护进程内存中，进程退出/被 kill 即全部消失，重启后同一文件可
  正常写入（没有需要清理的残留状态）。
- **回显口径**：`detail.file` 回显请求的 `file` 值（与其它失败码一致）；`./x` 与 `x` 两个并发
  请求锁是同一把，各自 `detail.file` 回显自己的请求写法。
- **fixture**：`fixtures/edit_batch/lock_timeout.json` 为按冻结形状手写的 -32017 样例（顶层
  `file` + `changes_total`，`detail.waited_ms` 固定 30000，hint 为 spec 原文），由协议一致性
  测试做客户端严格解码 + 渲染逐字节校验。

并发验收证据（真实守护 + 独立连接 raw 探针 + 真实 OC 客户端复刻）：

- 同版本 10 路并发：先读版本 v，10 个独立连接同时提交 `baseVersion=v` → 恰好 1 个
  `applied:true`、9 个 -32012，磁盘内容只生效一次（实测 summary `applied=1
  codes={"-32012":9}`，elapsed 342..347ms）；
- 不同文件 10 路并行：10 个文件各自读版本后并发编辑 → 10/10 `applied:true`，无 -32017
  （实测真实客户端 elapsed≈3.4s，依次完成，见上方执行门说明）；
- LOCK_TIMEOUT 现场：持锁请求发出后立即（~50ms 内）另一独立连接带 `options.lock_timeout_ms=1`
  → -32017，`detail={file,waited_ms}`、hint 为 spec 原文，持锁者随后 `applied:true`（实测
  首次即命中：`waited_ms:1`，daemon 日志 `lock contended ... waiting up to 1ms`）；
- 路径规范化：`path` 与 `./path` 两种写法并发 → 同一把锁，恰好 1 成功（另一个 -32012）；
- 顺序无等待：同一文件连续两次（第二次用新版本、新锚点）均成功，单次 ~330ms（版本链
  13b→147→156）；
- 崩溃后不泄漏：编辑成功 → `taskkill /F` 杀 java 进程（PID 实测）→ 重启守护 → 同一文件再编辑
  成功（value 3→4，杀进程，value 4→5）；
- 夹具：`lock_timeout.json` 经真实客户端 `EditBatchResult` 严格解码通过，`renderEditBatch`
  逐字节等于预期（`edit_batch FAILED: lock timeout / ...: lock timeout after 30000ms / hint`）。

偏差：

- 真实"持锁中 kill"无法在探针层确定性编排（单次写操作窗口 <数秒），采用的等价验证是
  "编辑成功后 kill → 重启 → 再编辑成功"——锁在内存、进程死亡即消失，不持久化，结论一致；
- 平台写路径执行门是无头环境的让步：并发不同文件时写路径按序执行（不再交叉），以便绕开
  IntelliJ manual highlight / VFS 写意图的 60s 平台锁环；文件级锁语义（FIFO、-32017 只来自
  文件锁等待、锁内版本校验）不受影响。

fixtures：`fixtures/edit_batch/template.java`（固定模板）＋ `input.json`（**故意不含
baseVersion**，由探针/契约测试经 read_view 注入）＋ `output.json`（真实守护响应；其中
`old_version`/`new_version` 两个值替换为字串 `"<version>"`，其余原样美化缩进）＋
`lock_timeout.json`（**手写**的 -32017 样例，非守护生成）。生成命令：

```bash
bash script/build-local.sh
bash script/run-local.sh sample-project .tmp/edit.port --idle-seconds 600
bun script/edit-probe.ts .tmp/edit.port --normalize-versions --out fixtures/edit_batch/output.json
```

探针：`bun script/edit-probe.ts [locator] [--params file | --params-json '{...}'] [--file path]
[--changes-json '[{...}]'] [--lock-timeout-ms n] [--parallel n] [--base-version v] [--out file]
[--normalize-versions] [--raw] [--copy|--no-copy] [--no-inject] [--no-wait] [--timeout secs]
[--shutdown] [--cleanup]`；默认 copy template → 目标、read_view 取 version、注入 baseVersion 后
发送；`--file/--changes-json/--lock-timeout-ms` 为免 params 文件的薄覆盖（后两者分别覆盖
`changes` 与 `options.lock_timeout_ms`，0/负数会原样发出以验证 -32603）；`--parallel N` 开 N 个
独立连接，所有 worker 先并发取版本（或共用 `--base-version`），就绪后同时发送同一请求，
请求 JSON 中的 `{i}` 替换为 worker 序号（1 起，便于一次对 N 个不同文件并发），逐路打印
`applied`/错误码/耗时并输出 summary；`--raw` 打印原始 NDJSON 请求/响应帧。

验收证据（真实守护 + sample-project；成功用例的 target 是生成物，跑完已删除）：

- a) 成功：copy template → read_view `version=1a139f262e6` → 发送两条 changes → `applied:true`、
  `changes_applied:2`、`changes_total:2`，`line_changes=[{4,modified},{6,modified}]`，
  `diagnostics_delta={errors:-1,warnings:0}`，`diagnostics_after={errors:0,warnings:2}`，
  `new_version=a ≠ old_version`；磁盘内容变为 `int count = 7; / return count + 1;`；
- b) `--base-version deadbeef` → -32012，`detail.current_version:"a"` + 全文 content；
- c) -32010（锚点缺失）、-32011（`count` 匹配 2 处，locations `[4,6]`，hint 为 spec 原文）、
  -32016（`int total() {` 与 `total() {` 区间相交：change 1 ↔ 0）、-32014（marker `[err:`）；
- d) `node_modules/x.js`（文件不存在）→ -32013（保护先于存在性）；
- e) `src/main/java/demo/NoSuch.java` → RPC -32001 `file not found`；
- f) 事务性：成功前跑一次故意失败的批次（-32010），目标文件 md5 前后一致、目录无 `.tmp` 残留；
- g) 成功后再用旧 `baseVersion`（`1a139f262e6`）→ -32012（证明版本戳已更新为 `a`）；
- 附加：连续编辑（`+1`→`+2`）后 before/after 诊断计数正确跟随；插入/删除批次
  `line_changes=[{5,inserted},{6,inserted},{7,deleted}]` 且磁盘内容正确；
- 缓存失效证据：如上实测（modCount 16 → 20，`cache hit` → `cache miss`）。

偏差说明：

- -32016 为 spec 未定义的新增码（spec 只要求“重叠拒绝”）；
- `diagnostics_after` 为冻结协议的扩展字段（渲染“改前→改后”需要），delta = after - before；
- 锚点匹配为非重叠计数（`indexOf` 按 oldString 长度步进）；
- 失败结果的 `file` 回显请求值，成功结果同样回显请求值（与 read_view 的 displayPath 风格可能
  不同：绝对路径输入时回显绝对路径）；
- `line_changes` 的 action 只有三档（一个 change 内所有行同 action）：多行替换为少行时报
  `modified`（按新内容行数输出）；
- 路径保护按“相对项目根的路径段”判定（项目根目录名本身不参与），后缀按文件名判定；
- 写入是 NIO 原子写（非平台保存），不触发平台 formatter/保存钩子；无自动格式化、无内容
  规范化、无撤销（与 spec 约束一致）。

## edit_transaction（跨文件原子编辑）

`edit_transaction(params)`：`{"changes": [{"file": string, "baseVersion": string,
"changes": [{"oldString": string, "newString": string, "description"?: string}]}],
"options"?: {"lock_timeout_ms"?: number}}`。一次调用提交跨多个文件的变更集：**要么全部成功，
要么全部回滚**；最多 10 个文件（超过按参数错误 RPC -32603 拒绝）。`options.lock_timeout_ms`
缺省 30000，出现时必须 ≥1（否则 RPC -32603），且是**每把文件锁独立**的等待上限。
v1 不支持新建文件（只修改已存在文件；不存在是 RPC -32001），也不做嵌套事务/跨项目事务。

失败结果是 JSON-RPC 成功响应里的 `{"applied": false, "error": {code, message, detail, hint}}`
（**没有**顶层 `file`/`changes_total`；与 edit_batch 的失败形状不同）。失败时所有文件均未写入
（rename 阶段故障除外，见偏差）。

处理顺序（冻结）：

① 参数校验（空 `changes` / 某文件空 `changes` / 类型错 / 文件数 >10 → RPC -32603）
→ ② 同一规范路径重复 → **-32019 DUPLICATE_FILE**（detail.file）→ ③ 路径保护（与 edit_batch
同一套保护段/后缀；事务另要求文件位于项目根内——journal 用项目相对路径）→ **-32013**（detail.file，
先于存在性）→ ④ 文件不存在 → RPC **-32001**（此时所有文件均已通过保护检查）→ ⑤ 按规范化路径
字典序排序 → ⑥ 按序获取文件锁（公平 FIFO；每把独立等待 `lock_timeout_ms`，超时 → **-32017**
detail{file, waited_ms} 并释放已持有）→ ⑦ 锁内校验全部 `baseVersion`（任一不匹配 → **-32012**
detail{file, current_version, content}，释放全部）→ ⑧ 全部 `newString` 纯度 → **-32014**
detail{file, change_index, changes_total, marker} → ⑨ 逐文件锚点（0 → **-32010**；多 →
**-32011** 含 match_count/locations；与 edit_batch 相同的非重叠匹配）+ 同文件重叠 → **-32016**
→ ⑩ 内存应用（任一失败整体拒绝）→ ⑪ 写阶段：每文件 `<file>.tmp` + fsync → 写 journal（fsync）
→ 依次 rename → 删 journal → ⑫ 每文件重算版本/诊断 → 锁按逆序释放。
**写入阶段之前任何失败都是零副作用**（无 tmp、无 journal、文件字节与版本不变）。

成功结果：`applied / files_changed / changes_applied / changes_total`，
`files: [{file, old_version, new_version, changes_applied, line_changes}]`（**按字典序**，每个文件
都带 `line_changes`；计算与 edit_batch 共用同一实现），`diagnostics_delta: {<file>: {errors,
warnings}}` 与扩展字段 `diagnostics_after`（before 在写阶段前采集、after 在全部 rename 后采集；
delta = after - before，与 edit_batch 口径一致）。`file` 回显请求值。

锁与死锁避免：所有事务按规范化路径字典序加锁，任意两个事务对同一文件集的获取顺序一致，
不会出现"A 等 B、B 等 A"；事务与 edit_batch **共用同一把文件锁表**（key = 规范化绝对路径），
事务与单文件写争用同一文件时按 FIFO 串行；锁在内存、进程退出即消失，崩溃后无需清理。
写阶段在 edit_batch 同一把进程内执行门内（无头平台 manual highlight/VFS 写意图锁环的规避），
文件锁与锁内版本校验语义不变。

journal 与启动恢复：

- 目录 `<project>/.opencode/txn-journal/<uuid>.json`（gitignore），内容
  `{started_at, files: [{tmp, target}]}`，路径为项目相对、`/` 分隔；
- 启动时扫描 journal 目录：全部 tmp 在 → 重放全部 rename；部分 tmp 在（缺失 tmp 的目标存在）
  → 续传剩余；清单 tmp 缺失且目标未更新（目标不存在）→ 清理残留 tmp + journal（fsync 前中断）；
- 重放幂等：按"tmp 是否还在"判断，目标已存在则跳过（已 rename 的条目不会重复处理）；
- 恢复异常（非法 JSON、路径逃逸、目录不可读、rename 失败）→ **保留 journal + 置只读 + 日志**，
  守护继续启动。

只读门（-32018）：journal 恢复失败的守护进程照常启动并服务；`edit_batch`/`edit_transaction`
入口检查共享门 `WriteGate`，命中返回 RPC **-32018**（message `journal recovery failed`，
`error.data` 含 journal 路径与原因）；`read_view` / `blast_radius` / `project_map` / `verify_test`
不受影响。只读状态在进程内生效、重启前不可解除（等待人工处理 journal 后重启）。

错误码汇总（事务）：-32010 / -32011 / -32012 / -32013 / -32014 / -32016 / -32017 与 edit_batch
同名同风格；-32011 的 hint 为 spec 原文（`提供更多上下文使锚点唯一，或调用
fallback_option_direct 获取直接操作工具`）；**-32019** 为 spec 新增码；**-32018** 见只读门；
文件数 >10 用 RPC **-32603**（不是结果错误码）。

fixtures / 探针：

- `fixtures/edit_transaction/input.json`：**不含 baseVersion**（由探针/契约测试经 read_view 注入），
  2 文件 × 2 changes：Alpha 修一处类型错误（`return "zero";` → `return 0;`，使 errors delta 稳定
  -1）并改 `return 10;`；Beta 改 `Alpha.base() * 2` 与 `Math.min(...)`（锚点唯一）；
- `fixtures/edit_transaction/output.json`：真实成功结果，`files[].old_version`/`new_version`
  归一为 `"<version>"`，其余原样；
- `fixtures/edit_transaction/templates/{Alpha,Beta}.java`：与 `sample-project` 样本初始内容
  **逐字节一致**，供每轮测试重置与恢复重跑；
- `bun script/edit-txn-probe.ts [locator] [--params file.json | --params-json '{...}']
  [--base-version v | --base-version N=v] [--lock-timeout-ms n] [--out file] [--normalize]
  [--raw] [--copy|--no-copy] [--no-inject] [--no-wait] [--timeout secs] [--parallel n]
  [--shutdown]`：默认按请求把 templates copy 回目标（重置），逐文件 read_view 取版本并注入
  baseVersion，发送事务；`--out` 落盘、`--normalize` 归一版本；`--base-version N=v` 覆盖第 N 个
  文件（1 起）用于制造 stale；`--parallel N` 开 N 个独立连接、共享同一组 baseline 版本后
  barrier 同时发送（并发争用验证）；`--no-inject` 跳过 read_view（用于不存在/保护路径用例）。

验收证据（真实守护 + sample-project，raw NDJSON；每轮开始前用 templates 重置样本）：

- 成功（`input.json`）：`applied:true`、`files_changed:2`、`changes_applied/changes_total:4`、
  两文件 `new_version ≠ old_version`，`line_changes=[{5,modified},{9,modified}]`（两文件同形），
  `diagnostics_delta: Alpha {errors:-1,warnings:0} / Beta {0,0}`，
  `diagnostics_after: Alpha {0,0} / Beta {0,3}`；磁盘内容已变；journal 目录无残留文件；
- 稳定性：连续两轮（重置后）归一化结果 `diff` 逐字节一致（RUNS_IDENTICAL）；
- 回滚：第二文件换坏锚点 → `-32010`，detail `{file: Beta.java, change_index: 0, changes_total: 1,
  oldString: "NO_SUCH_ANCHOR_TXN"}`；两文件 `cmp` 字节不变、read_view 版本仍为注入值（dd/eb）；
- 版本不匹配：第二文件 stale（`--base-version 2=stale00`）→ `-32012` detail
  `{file: Beta.java, current_version: "eb", content: <全文>}`；第一文件字节未变；
- `-32019`（同一文件两次，detail.file）；`-32603`（11 个文件 →
  `invalid params: changes: at most 10 files`）；`-32013`（`node_modules/x.js`，保护先于存在性）；
  `-32001`（`NoSuch.java`，RPC 错误）；
- 并发：`--parallel 2`（同组文件、同一 baseline 版本、独立连接）→
  `summary total=2 applied=1 codes={"-32012":1,"applied":1}`、elapsed 667..672ms，无死锁、
  journal 无残留；
- journal 恢复 a)（手工编排 rename 中途崩溃：两个 tmp 就绪、只 rename Alpha、写对应 journal）→
  启动日志 `replayed journal ... renames=1`，两目标均为新内容、journal 删除、无 tmp；
- journal 恢复 b)（tmp 不完整：Beta.java.tmp 在、Alpha.java.tmp 缺失且目标不存在）→
  启动日志 `cleaned incomplete journal ...`，Beta.java.tmp + journal 删除，两目标保持旧内容；
  另一份"全部 tmp 缺失、目标齐全"的 journal → `replayed ... renames=0`（幂等跳过）后删除；
- journal 恢复 c)（非法 JSON + 路径逃逸 `../../escape.java.tmp`）→ 守护照常启动、journal 保留，
  `edit_batch`/`edit_transaction` 均返回 `-32018 journal recovery failed`（data 含 journal 与
  reason），`read_view` 正常返回（version 3）；
- 构建：`bash script/build-local.sh` 编译通过并安装到 `.sandbox`。

偏差与注记：

- journal 无内容指纹，恢复时"目标未更新"以**目标文件不存在**判定（v1 不建文件，该分支用于
  journal 指向的目标缺失的异常/损坏状态；正常崩溃模型下 tmp 缺失即已 rename）；
- rename 阶段某个 rename 失败时采取 **commit-forward**：逐个尝试剩余 rename、保留 journal，
  本次返回 `-32015 WRITE_FAILED{file, reason}`（下次启动续传）；不回滚——回滚会把已提交文件
  再改回去，扩大不一致窗口；
- 路径保护对**项目根外**文件同样拒绝（-32013）：journal 需要项目相对路径，spec 约束"所有文件
  在同一项目内"；
- 诊断 before/after 按文件独立计数（before 全部在写阶段前、after 全部在 rename 后），
  跨文件诊断影响的解释口径与 edit_batch 相同（重算变更文件）；
- `diagnostics_delta`/`diagnostics_after` 的键与 `files[].file` 均为请求回显值；
- journal 目录在首次写入事务后保持存在（空目录）；`.gitignore` 已忽略
  `sample-project/.opencode/`。

## verify_test（运行测试命令 + 薄解析）

`verify_test(params)`：`{"command": string, "options"?: {"cwd"?: string, "timeout_ms"?: number,
"env"?: {string: string}}}`。命令原样透传给 shell；`cwd` 缺省项目根；`timeout_ms` 缺省 300000
（0 = 不限时）；`env` 在继承环境上叠加。

结果字段（冻结协议）：

- `command / exit_code / duration_ms / parsed / framework`；
- `summary: {passed, failed, skipped, total} | null`——go 拿不到计数时为 null（`parsed` 仍 true）；
- `failures: [{test, file?, line?, message?}]`——超过 20 条只返回前 20，并出现 `total_failures`
  （未截断时无该字段）；
- `output_head` / `output_tail`：stdout+stderr 合并、去尾部空行；总行 ≤100 时 head=全文、tail=""；
  否则 head=前 100 行、tail=后 100 行（中段省略）；
- `timeout: true` 仅超时出现：杀掉进程树、`exit_code: -1`、`summary: null`、`parsed: false`。

shell 选择：`SEMANTIC_SHELL` 环境变量可覆盖（值是 shell 可执行文件，按 `-c` 传命令）；Windows
优先 Git bash（PATH 扫描 + `%ProgramFiles%`/`%LOCALAPPDATA%\\Programs` 下的 `Git/bin|usr/bin`），
以 `bash -s` + stdin 送脚本（见偏差）；找不到降级 `cmd.exe /d /s /c`；POSIX 用 `/bin/sh -c`。
命令文本字节原样交给 shell，不做包装或改写。

RPC 错误：`cwd` 命中保护列表（与 edit_batch 同一套保护段/后缀）→ `-32013`，**先于存在性判断**；
`cwd` 不存在或非目录 → `-32001`；参数非法（缺/空 command、负/小数 timeout_ms、cwd/env 类型错）
→ `-32603`；索引未就绪 → `-32000`（与其他方法相同的就绪门槛，按 `data.progress` 重试）。

解析规则（顺序 pytest → jest/vitest → go → cargo → mocha，命中即停）：

- **pytest**：footer `===== 1 failed, 1 passed in 0.30s =====` 取计数；`FAILED path::test - msg`
  （`ERROR` 同样计入失败）取失败条目；文件取 node id 前缀，行号/回退消息用失败块头
  `____ test_fail ____` 之后的 `path:line: ...` 行关联；映射 errors→failed、xfailed→skipped、
  xpassed→passed；
- **jest/vitest**：`Tests:`（jest）/ `Tests`（vitest）汇总行取计数，`✕`/`×` 行取失败名；
- **go**：`--- FAIL: Test` / `ok|FAIL pkg` 识别（无计数 → summary=null）；
- **cargo**：`test result: FAILED. N passed; M failed; K ignored` 取计数（ignored→skipped），
  `test name ... FAILED` 取失败；
- **mocha**：`N passing/failing/pending` 取计数，`N) name` 取失败；
- 未识别：`parsed: false`、`summary/framework` 为 null，模型直接看原始输出。

fixtures：`fixtures/verify_test/input.json`（`{"command":"python -m pytest tests"}`）+
`output.json`（真实守护响应；归一约定：`duration_ms → -1`、`output_head/output_tail → "<output>"`，
其余（含 failures 的 file/line/message）原样）。生成命令：

```bash
bash script/build-local.sh
bash script/run-local.sh sample-project .tmp/verify.port --idle-seconds 1800
bun script/verify-probe.ts .tmp/verify.port --normalize --out fixtures/verify_test/output.json
```

探针：`bun script/verify-probe.ts [locator] [--params file | --params-json '{...}']
[--command cmd] [--cwd dir] [--timeout-ms n] [--out file] [--normalize] [--raw] [--no-wait]
[--timeout secs] [--shutdown]`。

验收证据（真实守护 + sample-project，raw NDJSON）：

- 失败：`python -m pytest tests` → exit 1、summary `{1,1,0,2}`，failures
  `[{test:"tests/test_sample.py::test_fail", file, line:6, message:"assert (1 + 1) == 3"}]`，
  parsed true、framework pytest；
- 成功：`python -m pytest tests/test_sample.py::test_pass` → exit 0、`{1,0,0,1}`、failures []；
- 截断：`python -m pytest tests_many` → 21 failed、failures 20 条（test_fail_01..20）+
  `total_failures: 21`，output_head/output_tail 各 100 行；
- 未知命令：`./custom-test.sh` → exit 127、parsed false、framework null、原始 bash 报错；
- 超时：`sleep 5` 或 `python -c "..."` + `timeout_ms` → exit -1、`timeout: true`、
  ~超时长、进程树已杀（无残留进程）；
- 长输出：`python -c "for i in range(300): print(i)"` → parsed false、head/tail 各 100 行（中段省略）；
- cwd：`.venv`（不存在）→ -32013（保护先于存在性）；`no-such-dir` → -32001；`tests`（合法）
  → 生效（rootdir、node id 相对 cwd）；空 command、负/小数 timeout → -32603；
- 就绪门槛与重试：冷启动 `--no-wait` 直发 → `{"code":-32000,"message":"indexing",
  "data":{"progress":…}}`，探针轮询至 ready 后成功。

本机限制与偏差：

- 本机只装了 pytest（9.1.1，`python -m pytest`）；jest/vitest/go/cargo/mocha 未安装，
  解析器按样例输出实现、未做真实链路验证；
- Windows 的 Git bash 用 `-s`（stdin 送脚本）而不是 `-c`：JVM 把含内嵌双引号的 `-c` 参数
  交给 msys2 时引号会被吞掉（已用最小 Java 程序复现，与 verify_test 自身无关），stdin 传字节
  与命令原文完全一致（`python -c "..."` 已实测 + conformance 用例 22/24 覆盖）；`SEMANTIC_SHELL`
  覆盖与 cmd 降级仍按 `-c` 传参；
- 捕获上限 5 万行（超出丢弃最旧行；footer/失败列表在末尾，优先保留）；
- 失败列表顺序 = pytest 短摘要（`-rf`）顺序；
- 测试进程自身产生的缓存目录（`__pycache__`/`.pytest_cache`）由测试工具管理，不在本服务控制范围。

## project_map（项目级只读地图）

`project_map(params)`：`{"view"?: "structure"|"dependencies"|"hot"（缺省 structure）, "scope"?: string}`。
项目级、只读、跨 agent 共享；项目级缓存 + `ReentrantReadWriteLock`，首次查询启动后台构建线程并
立即返回 `building:true, progress:0`（数组为空、project 计数为 0），构建中后续查询返回进度，
完成后返回不带 `building` 的缓存结果。`root` 为项目绝对路径；所有项目相对路径以 `/` 分隔；
modules / 根文件 / 依赖边 / 入口点均升序。错误：索引未就绪 `-32000`（同 read_view，
`data.progress` 重试）；未知 view / 参数类型错 `-32603`。

三种视图（严格字段；三形均可附 `building:true` + `progress`）：

- structure：`{project:{root,total_files,total_modules}, modules:[{name,path,files,is_entry,hot}],
  entry_points:[{file,line,symbol,kind}], root_files:[string]}`
- dependencies：`{project:{root,total_files}, dependencies:[{from,to,count}], cycles:[[modulePath...]]}`
- hot：`{project:{root,total_files}, hot_files:[], hot_modules:[]}`（v1 恒空，作者选 A）

模块划分：多 IntelliJ 模块项目用模块；单模块项目（sample-project）降级为目录约定——每个
直接包含文件的目录是一个模块（隐藏目录与 `node_modules/venv/build/out/target/__pycache__/dist`
排除；目录符号链接不跟随），`name=` 路径末段、
`path=` 项目相对目录；`files` 只含该目录直接子文件（不递归、升序；显示上限 200，`total_files`
计全量）；项目根常规文件（不含隐藏）列入 `root_files`；`total_files = 模块文件数 + root_files 数`；
模块数 >20 时只返回前 20（升序），`total_modules` 仍为全量。

入口点：Java `public static void main(String[])` → `kind:"main"`；方法注解 simple name 匹配
`Get/Post/Put/Delete/Patch/RequestMapping/Path`（忽略大小写）→ `kind:"route"`；`is_entry` =
模块含 ≥1 入口。

依赖：对每个模块内 `.java` 文件取 `PsiImportStatement`（含 static/on-demand），import 目标按
“最长项目包前缀”映射到属主模块（包名从各文件 `package` 声明收集；JDK/外部自动忽略，不做
resolve）；`from≠to`；`count=` import 语句数（同一文件多行同一目标计多）；边按 from/to 升序。
`cycles` 用迭代版 Tarjan SCC 找 size>1 强连通分量，成员按模块 path 升序；根目录 `.java` 文件的
import 不计（无来源模块）。

缓存与失效：项目级缓存由 `ReentrantReadWriteLock` 保护；无头沙箱禁用了原生文件监听
（日志 `Native file watcher is disabled`），因此每个 ready 查询用磁盘指纹做被动检测——已扫描
目录的“相关目录项集合”变化（新增/删除/移动/重命名）→ 全量失效；已记录文件 mtime 变化 → 仅
dependencies 失效（structure/hot 保留缓存并立即命中；重建依赖前按需 refresh VFS 让 PSI 看到
新内容）。**例外（模型文件）**：`*.iml`（项目根与目录内均记录 mtime）或 `.idea/` 下 `*.xml`
（追加进指纹）内容变化 → 视同结构变化，`invalidated (model changed: …)` 全量失效（structure
与 dependencies 都重建）——引擎依赖 `.idea`/`*.iml` 项目模型，模型变化不能只重建 dependencies。
规格“文件内容修改不失效”对 structure 生效；无法廉价区分 import 变化，模型文件外的内容修改一律
重建 dependencies（偏差）。scope（`module:<name或path>`）只过滤展示、不缓存；无前缀/未知前缀
忽略；未匹配到模块时返回空列表（不报错）。scope 下 structure 只列出该模块（含其入口点，
root_files 空），project 计数仍为全量；dependencies 只返回涉及该模块的边（cycles 保留全量）；
hot 忽略 scope。构建在后台线程 `ReadAction.computeBlocking` 内扫描 VFS/PSI；`project.root` 取
CLI 项目路径的绝对规范化形式。

探针：`bun script/map-probe.ts [locator] [--view ...] [--scope s] [--out file] [--normalize-root]
[--wait-ready] [--parallel N] [--raw] [--params-json '{...}'] [--fail-fast] [--timeout secs]
[--no-wait] [--shutdown]`；`--wait-ready` 对 `building:true` 轮询到 ready；`--parallel N` 开 N 条
连接并发同一请求并比较结果；`--fail-fast` 跳过就绪等待且不重试（用于采集 -32000 原始帧）。

fixtures：`fixtures/project_map/input.json`（`{"view":"structure"}`）+ `output.json`（真实 ready
结果，`project.root` 归一为 `"<root>"`，其余原样美化）。生成命令：

```bash
bash script/build-local.sh
bash script/run-local.sh sample-project .tmp/map.port --idle-seconds 1800
bun script/map-probe.ts .tmp/map.port --normalize-root --wait-ready --out fixtures/project_map/output.json
```

验收证据（真实守护 + sample-project，raw NDJSON）：

- structure：8 模块（demo[3]/api/cyclea/cycleb/tasks[6]/txn[2]/tests/tests_many）、root_files
  `["sample-project.iml"]`、total_files 17、total_modules 8；入口 2 个 main（Main.java:6、
  TaskRunner.java:4）；失效后首查返回 `building:true, progress:0`（计数 0、数组空）；
- dependencies：3 条边（`demo.api→demo.tasks`、`demo.cyclea↔demo.cycleb`，值为模块 path，形如
  `src/main/java/demo/api`），cycles `[[…/demo/cyclea, …/demo/cycleb]]`；
- hot：`hot_files:[]、hot_modules:[]`；
- 并发：`--parallel 10 --wait-ready`（structure 与 dependencies）→ 均为 `all_equal=true errors=0`
  （40–84ms）；mods 删除后的 rebuild 并发中 building 阶段也一致收敛到同一结果；
- 缓存：首次（失效后）构建日志 `build done in 530ms`、`540ms`（mods 场景 223ms）之后连续查询
  均为 `cache hit` 且探针耗时 5–10ms；dependencies 重建日志 761ms（人工加 import 后 4 条边）→
  还原后 183ms（3 条边），期间 structure 始终 `cache hit`；
- 失效 a) 内容修改：直接写盘给 cyclea/A.java 增加 `import demo.tasks.TaskEngine` → 日志
  `dependencies dirty (content changed: 1 files)` + `cache hit view=structure`；dependencies
  查询重建出新边 `cyclea→tasks (1)`；还原后回到 3 条边；
- 失效 b) 结构变化：新增 `mods/m01..m21`（各 1 个 .java）→ `invalidated (structure changed at .)`
  → 全量重建 `modules=28 files=36`，返回 20 个模块（m01..m20），total_modules 28、total_files 36；
  删除 mods 后恢复 8/17；
- 路由：临时 `RouteApi.java`（`@Get/@Path`）→ entry `…/RouteApi.java:19 listUsers (route)`
  （验证后已删除）；
- 错误：冷启动 `--fail-fast` → `{"code":-32000,"message":"indexing","data":{"progress":0.02}}`；
  `view:"bogus"` / `view:123` / `scope:123` → -32603；未知前缀 scope 忽略（全项目）。
  （以上计数为当前样本快照：edit_transaction 任务新增了 `demo/txn/{Alpha,Beta}.java`，
  `fixtures/project_map/output.json` 已按新样本重新生成以保持一致。）

偏差与注记：

- Python 入口/依赖已实现（W7）：模块级 `main` / `if __name__ == "__main__"` 守卫 /
  `@*.get/post/...` 路由装饰器；`import` / `from ... import`（含相对导入与 `src/` 源根折算）。
  JS/Go 入口规则仍未实现；Java 路由只按注解识别（`RequestMapping`/`Path` 精确名；
  Spring `@GetMapping` 等派生注解不计）；
- `dependencies.from/to` 与 `cycles` 使用模块 `path`（spec 样例口径），而非 name；
- scope 过滤按上文的展示口径（spec 只写了 `module:core`）；未匹配模块返回空而非错误；
- 内容修改仅失效 dependencies（无法廉价区分 import 变化；spec 的“符号增删失效 structure”未单独实现）；
  模型文件（`*.iml` / `.idea` 下 `*.xml`）例外，按上方缓存与失效说明全量失效；
- 无原生监听，被动失效检测成本 O(已扫描目录数 + 文件数) 次磁盘元数据读取（目录项 + stat），
  大项目每次 ready 查询有固定开销；
- `files` 上限 200 仅影响展示，`total_files` 为全量；`hot` 恒空（作者选择 A）。

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
- **传输**：TCP `127.0.0.1`（ephemeral port），不再使用 AF_UNIX；locator 文件为单行 JSON
  （`{v,port,token,pid}`）原子写入、优雅退出删除，token 为每守护 128-bit 随机值（32 hex），
  握手契约见「传输与握手（locator / hello）」。
- Java PSI 依赖 `com.intellij.modules.java`（plugin.xml 中为 `optional=true`；IDEA 自带 Java 插件，
  已验证加载；PyCharm/WebStorm 等无 Java 模块的发行版下 Java 专有功能（blast_radius /
  project_map / 项目 SDK 指派 / read_view 的 Java 定义解析）自动降级，见下条）。
- **语言支持与降级（W4 定稿）**：read_view 语言无关（跨发行版可用：PyCharm/WebStorm 只要
  语言能力即可返回内容/位置/覆盖/符号）；手动高亮与 PSI 锚点解析（含 2s 锚点预算）仅对
  `JAVA` 与 `Python` 语言执行。TS/HTML/CSS 等仍降级：其 resolve/检查经语言服务（跨进程）
  完成，headless 冷启动可阻塞数十秒且持读许可（W3 线程 dump 证据），这些文件 `anchors`
  不可用、`diagnostics` 仅取 daemon 缓存（repo 根 TS 文件实测 p50 5ms、p95 453ms、无 >30s）。
  Python（PyCharm 2026.1 / PY-261 实测）：符号 + 跨文件锚点 + 跨文件 definition 正常，
  冷启 1.2s、p50 3ms、无 >30s；诊断可达语法级注解（含语法错误）与本地检查（如
  `Unused import statement`）；undefined-name 检查在 2026.1 由 Python LSP 异步提供，
  headless 手动 passes 不产出（环境限制，非语言门槛）。锚点跳过项目外目标（JDK/.class、
  Python typeshed 等，`location` 保持项目相对路径语义）；261 平台无 262 的 additional
  highlighting session API，按旧版重载反射回退。`blast_radius`/`project_map` 的 Python 路径
  （W7）：project_map 按目录模块 + Python 入口/import 依赖；blast_radius 用词索引找声明、
  `ReferencesSearch` 找引用，索引不覆盖时退化为项目内 `.py` 有界扫描；无解释器的裸项目
  （Python 类型推断不可用，引用无法 resolve）再退化为名称级匹配（精确标识符、跳过声明名），
  并在日志记录 fallback。`blast_radius`/`project_map` 的 JS/TS 路径（W8）：project_map 按目录
  模块 + `package.json` main/bin + 路由调用/装饰器入口 + import/export/require + 最近
  `tsconfig.json` 的 `baseUrl`/`paths` 依赖（不处理 `extends`）；blast_radius **禁用**
  `ReferencesSearch`/`resolve`（TS 语言服务会阻塞），定义/引用/callees 全部走
  词索引 + 文本预筛选 + PSI 名称匹配，索引损坏时退化扫描。语法级近似精度低于 Java/Python，
  且在健康索引缺失时首次查询更慢（repo 根 TS 实测约 2.6s），但不会卡死。Java/Python 不可用的
  WebStorm 上 JS/TS 工具正常工作；PyCharm 有 JS 插件时同样可用；三者都没有才返回
  `-32603 java/python/javascript support unavailable in this IDE distribution`。

## 对 OC 客户端的集成要点

- 启动：`bash semantic-server/script/run-local.sh <项目> <locator> --idle-seconds N`
  或 `java -Djava.awt.headless=true -jar semantic-server.jar <项目> <locator> --idle-seconds N`。
- 客户侧：读 locator（缺失/解析失败视为无守护）→ TCP 连接 `127.0.0.1:<port>` → 发送
  `hello {token}`；成功（`{ok:true}`）即复用/可用，token 错误或首请求非 hello → `-32019` 且连接关闭。
- 握手后先 `subscribe`（收到 `{ok:true}` 与首个 `notifications/indexing`），
  以 `ping.indexing==false` 作为可读信号；`read_view` 返回 -32000 时按 `data.progress` 等待重试。
- 空闲 N 秒（默认 1800）自动退出并删除 locator；`shutdown` 可显式退出。
