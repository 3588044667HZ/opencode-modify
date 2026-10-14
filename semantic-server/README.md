# semantic-server —— IntelliJ 无头语义守护（MVP）

按 `LLM-IDE-SPEC/`（main / intellij-headless / jsonrpc-channel / adapter-layer）实现的 IntelliJ
无头语义守护：JSON-RPC 2.0 over AF_UNIX（NDJSON），提供 `ping` / `subscribe` / `read_view` /
`blast_radius` / `edit_batch` / `shutdown`。
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
│   ├── BlastRadiusService.java      # blast_radius 聚合：定义/引用分类/入口/测试/callees/风险 + 缓存
│   ├── EditBatchService.java        # edit_batch：版本戳/路径保护/纯度/锚点/重叠 + 原子写 + 诊断增量
│   └── Log.java
├── src/main/resources/META-INF/plugin.xml   # appStarter EP + 最小依赖
├── script/build-local.sh            # javac + jar 打包 + 安装到 .sandbox/plugins
├── script/gradle-build.sh           # Gradle 离线构建（依赖固化在 .gradle-home/）
├── script/run-local.sh              # 用本地 IDEA 平台 + JBR 启动守护（镜像 bin/idea.bat）
├── script/probe.ts                  # Bun 探针：ping/subscribe/read_view/shutdown
├── script/blast-probe.ts            # Bun 探针：blast_radius（fixtures 生成/缓存/scope 证据）
├── script/edit-probe.ts             # Bun 探针：edit_batch（模板块 copy/版本注入/fixtures 生成/raw NDJSON）
├── script/protocol-conformance.ts   # 跨实现协议一致性测试（真实守护 ↔ OC 客户端）
├── fixtures/blast_radius/           # 协议 fixtures：input.json + output.json（真实守护响应）
├── fixtures/edit_batch/             # 协议 fixtures：template.java + input.json + output.json（版本归一）
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
  `bash script/run-local.sh sample-project .tmp/blast.sock --idle-seconds 600` →
  `bun script/blast-probe.ts .tmp/blast.sock --early --out fixtures/blast_radius/output.json`；
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
"description"?: string}], "baseVersion": string}`。单文件、文本锚点、全成功或全失败的原子编辑；
写路径基础设施（版本戳校验、路径保护、纯度校验、原子写）在此首次落地。

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

-32011 的 hint 为 spec 原文；其余为同风格中文短提示。文件不存在仍是 RPC 错误 `-32001`
（与 read_view 一致）；参数缺失/类型错/空 changes/空 oldString 是 RPC `-32603`。

处理顺序（冻结）：

① 参数校验（-32603）→ ② 路径保护（保护段 `.venv/ venv/ env/ node_modules/ .git/ dist/ build/
target/ out/ __pycache__/ .pytest_cache/ .mypy_cache/`，后缀 `*.lock *.min.js *.min.css`；命中即
-32013，**先于存在性检查**）→ ③ 文件不存在 → RPC -32001 → ④ 读内容 + 当前版本（先按 mtime
差异 refresh VFS）→ ⑤ `baseVersion` 不匹配 → -32012（返回 current_version + content）→ ⑥ 纯度
（`[err:`、`→ def@`、`L\d+ \[`、`pos: L\d+`）→ ⑦ 锚点恰好出现 1 次（非重叠计数；0 → -32010，
>1 → -32011）→ ⑧ 两锚点区间相交 → -32016（相邻不算）→ ⑨ 从后往前内存应用 → ⑩ 诊断 before
计数 → ⑪ 原子写 → ⑫ VFS refresh + 新版本 → ⑬ 诊断 after、delta、line_changes。

原子写：同目录 `<file>.tmp` → `FileChannel.force(true)` fsync → `Files.move(ATOMIC_MOVE,
REPLACE_EXISTING)` 覆盖；任何失败清理 .tmp 并返回 -32015（本机 Windows 实测
ATOMIC_MOVE+REPLACE_EXISTING 可用）。写入绕过平台保存路径，写后执行 VFS refresh，并在 EDT 上
按需 `FileDocumentManager.reloadFromDisk` + `PsiDocumentManager.commitAllDocuments`，保证
PSI/诊断基于新内容重算；诊断计数复用 ReadViewService 的 `collectDiagnostics` 与手动高亮缓存
（缓存键含 VFS modificationStamp，写后自动 miss）。

缓存失效：写入触发 PSI 变更 → `PsiModificationTracker` modCount 变化，`BlastRadiusService`
静态缓存自动失效（无需显式通知）——实测连续查询 `cache hit`（modCount=16）后编辑一次，
再查询为 `cache miss (computed)`（modCount=20）。

fixtures：`fixtures/edit_batch/template.java`（固定模板）＋ `input.json`（**故意不含
baseVersion**，由探针/契约测试经 read_view 注入）＋ `output.json`（真实守护响应；其中
`old_version`/`new_version` 两个值替换为字串 `"<version>"`，其余原样美化缩进）。生成命令：

```bash
bash script/build-local.sh
bash script/run-local.sh sample-project .tmp/edit.sock --idle-seconds 600
bun script/edit-probe.ts .tmp/edit.sock --normalize-versions --out fixtures/edit_batch/output.json
```

探针：`bun script/edit-probe.ts [socket] [--params file | --params-json '{...}']
[--base-version v] [--out file] [--normalize-versions] [--raw] [--copy|--no-copy] [--no-inject]
[--no-wait] [--timeout secs] [--shutdown] [--cleanup]`；默认 copy template → 目标、read_view 取
version、注入 baseVersion 后发送；`--raw` 打印原始 NDJSON 请求/响应帧。

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
