# 多语言支持（Python / HTML / JS / TS）

## 背景

评审结论：旗舰能力（read_view 的锚点/诊断、blast_radius、project_map 入口）目前实际只在
Java 上兑现。实测定位到两个具体缺口，而非"能力缺失"：

1. **仓库根守护 Java 全 "Cannot resolve symbol"**：根因有两层，都不是 Java-only：
   ① 守护从不指派项目 SDK（代码中无 `ProjectRootManager` 使用）；② 即使 SDK 指派之后，
   `PsiShortNamesCache` 只遍历 Java source root，而仓库根 `WEB_MODULE` iml 与裸目录默认模块
   都没有 Java source root，项目类仍不可解析（JDK 类已可解析）。sample-project 能用只是因为
   它同时提交了 `.idea/misc.xml`（引用 `semantic-jdk`）与 `JAVA_MODULE` iml + `src/main/java`
   source root；任意裸目录项目两层都缺。此外自动选择早前只按深度 ≤2 扫描 `*.py`/`*.java` 等
  文件信号，`src/main/java/**`（深度 3+）不可见，Java 项目会被 `tests/*.py` 误判为 Python 项目
   ——信号判定需要分层（标准布局根/模块清单为决定性的 tier-1）。
2. **TS 文件 read_view 卡死**：repo 根守护（IDEA dist）对 TS 文件 read_view 反复重连超时
   （probe `read_view stalled, reconnecting and retrying`，守护 2.8GB RSS / 253s CPU）。
   需要诊断根因（JS 插件解析开销/阻塞）后修复或降级。

同时已确认：IDEA Ultimate 发行版**本就捆绑** `javascript-plugin` / `html-tools` /
`css-plugin` / `nodeJS` 等（沙箱已启用，索引日志有真实 JS 插件链路）；**Python 不在
IDEA 发行版内**，需要 PyCharm 发行版（或远期 LSP）。本机已安装：IDEA 2026.2（IU/262）、
PyCharm 2026.1（PY/261）、WebStorm 2026.2（WS/262）。

授权边界（不变量，见根 `AGENTS.md`「License Boundary」）：引擎只使用用户本机安装且
合法授权的 JetBrains IDE；不捆绑、不下载、不修改、不绕过；发现逻辑只回答"装在哪"，
不读取授权状态。

## 目标

- 同一守护（同一协议）在 **Java/Kotlin + JS/TS/HTML/CSS + Python** 上工作。
- IDE 自动发现 + 按项目选择；显式配置可覆盖。
- 修两个缺口：项目 SDK 指派（Java 解析）、TS read_view 卡死。
- 顺带清理个人路径硬编码（开源 hygiene）。

## 非目标

- 不做 LSP 实现（预留接口点，作为未来分发友好路线）。
- 不做 Marketplace 插件下载/安装；不打包任何 JetBrains 组件。
- 不引入任何许可检测/激活/绕过逻辑（硬性约束）。
- hot 视图下架、`hide` 收口、README 瘦身：独立事项，不在本批。

## 设计契约（冻结）

### IDE 发现

优先级从高到低：

1. 显式路径：opencode 配置 `semantic.ide_home`（新增，可选）或环境变量
   `SEMANTIC_IDE_HOME`（`IDEA_HOME`/`IDEA_DIR` 保留为兼容别名）
2. 产品选择器：opencode 配置 `semantic.ide` = `auto | idea | pycharm | webstorm | ...`
   （默认 `auto`）
3. 自动发现源顺序：
   - 卸载表注册项（HKLM + HKCU `...\Uninstall\*`，`DisplayName` 匹配 JetBrains 产品族，
     取 `InstallLocation`）——**本机实测为主可靠源**（App Paths 无、Toolbox 未装）
   - Toolbox：`%LOCALAPPDATA%\JetBrains\Toolbox\apps\*` 与 `scripts\*.cmd` 垫片
   - 常见路径兜底（`C:\Program Files\JetBrains\*` 等，最低置信）
4. 每个候选必须通过 `product-info.json` 校验（存在且可读 `productCode`/`buildNumber`），
   避免误选；请求的产品缺失时，错误信息列出全部已发现候选。

选择器到产品域：`idea→IU/IC`、`pycharm→PY/PC`、`webstorm→WS`，其余同理。

### 语言类别与自动选择

- 语言信号：`*.py`/`pyproject.toml`/`requirements*.txt` → Python；`package.json`/
  `tsconfig.json` → JS/TS；`pom.xml`/`build.gradle*`/`*.java` → Java；`*.html` → HTML。
- 能力校验：目标 dist 的 `plugins/` 目录存在对应插件（Python: `python*`；JS/TS:
  `javascript-plugin`；Java: 具备 `com.intellij.modules.java`）。
- 自动选择 = 能覆盖"项目出现的语言集合"的 dist，固定偏好序：
  JS/TS/HTML：`IU > WS`；Python：`PY > PC`；Java：`IU`。
- 结果不确定时（混合仓库平票）选偏好序靠前者，并在日志与错误信息中给出
  "可用 `semantic.ide` 显式指定"的提示。

### 配置、环境与命名

- opencode 配置新增：`semantic.ide`（path|selector|auto，默认 auto——若值含路径分隔符
  视为路径）、`semantic.ide_home`（显式路径）、`semantic.jdk_home`（可选，映射
  `SEMANTIC_JDK_HOME`）。
- locator 命名（manager 侧）：
  - 未显式指定 IDE（auto）：维持 `opencode-semantic-<projectHash>.port`
  - 显式指定时追加 IDE 键：`opencode-semantic-<projectHash>-<ideKey>.port`
    （ideKey = 规范化后的配置值小写 SHA-1 前 6；Windows 下小写处理与现有 hash 规则一致）
- sandbox 命名（Launcher 侧）：`sandbox-<projectHash>-<productCode><platformMajor>`
  （如 `-IU262`、`-PY261`）；`SEMANTIC_SANDBOX` 覆盖优先。**旧 `sandbox-<hash>` 不迁移**，
  README 说明可手动删除；平台版本不同（261 vs 262）混用 system 缓存会损坏，隔离是硬要求。
- `exclusions.json` 随 sandbox 走；`Launcher.exclusionsSandbox()` 同步新命名。

### plugin.xml 与代码守卫

- `com.intellij.modules.java` 改为 `optional="true"`，使插件可在无 Java 模块的 dist
  （PyCharm/WebStorm）加载。
- 平台通用服务保持不变（JsonRpcServer/IndexMonitor/ReadViewService/BlastRadiusService/
  EditBatch/EditTransaction/VerifyTest/ProjectMap/Exclusions 均为语言无关路径）。
- Java 专有路径收敛为受守卫的辅助类：能力探测用 `Class.forName` 标记类（缓存一次），
  探测失败时跳过并优雅降级（例如跳过 JDK 指派、跳过 Java 专用诊断）。
- 禁止任何许可相关逻辑（见不变量）。

### 项目 SDK 指派（修 Java 解析）

- 打开项目后，若 `ProjectRootManager.getInstance(project).getProjectSdk() == null`
  且能力探测确认 dist 具备 Java 支持：
  1. 按 `SEMANTIC_JDK_HOME` → `JAVA_HOME` → 常见 JDK 目录（如 `C:\Program Files\Java\*`、
     `C:\Program Files\Eclipse Adoptium\*`；不得硬编码个人路径）发现 JDK home；
  2. 在 `ProjectJdkTable` 中查找/创建 `semantic-jdk`（沿用现有 jdk.table.xml 生成逻辑的
     数据形状：每个 jmod 一个 jrt root）；
  3. `setProjectSdk`（EDT + WriteAction，失败仅 warning），持久化由平台写入 `.idea/misc.xml`。
- **源码根补齐（SDK 必要但不充分）**：SDK 指派之外，对每个模块 content entry——已有 source root
  的不动；否则在 content root 下（有界：深度 ≤4、跳过隐藏与排除默认目录、最多访问 50 个目录）
  搜索 `src/main/java` / `src/test/java` → `entry.addSourceFolder(dir, isTest)`；找不到布局根但
  存在 `.java` 文件时把 content root 本身加为 source root（裸 A.java/B.java 目录）。不做模块
  类型转换、不触碰既有 source root；EDT + WriteAction、幂等、失败仅告警。根因见背景 1： 
  `PsiShortNamesCache` 只遍历 Java source root。
- 验收后仓库根守护应能正常解析 `semantic-server/**.java`。

### JS/TS 卡死修复（阻塞项）

- 现象与证据见"背景 2"。要求：
  1. 用线程 dump / 日志埋点定位阻塞点（PSI resolve 范围爆炸、JS 插件自身分析管线、
     还是我们的锚点收集路径）；
  2. 根因修复；无法根因时允许降级（如锚点解析加时间/范围预算、跳过超预算 resolve、
     标注"锚点不可用"），但必须在 README 记录取舍与阈值；
  3. 验收阈值：repo 根对 TS 文件 `read_view` 返回 < 10s（p50），无 > 30s 的卡死；
     `blast_radius` 对 TS 符号返回结果或明确的 symbol-not-found，不得卡死。

### Python `project_map` / `blast_radius`（W7）

`project_map` 与 `blast_radius` 的入口改为“Java 或 Python 能力任一可用即开放”，按被分析对象的
语言分派；JS/TS 仍保持明确的 -32603（不引入未验证的语言服务路径）。

**能力探测**：`PythonSupport` 只检查平台是否注册 `Python` 语言（`Language.findLanguageByID`），
不引用 python 插件类（编译期与 Java 路径一样解耦）。PyCharm/PC 发行版可用；IDEA 走 Java
路径；两者都不可用（如 WebStorm）才返回 -32603。

**project_map（Python）**

- 模块划分沿用目录约定（直接含文件的非根目录；根文件单列 `root_files`），不引入 Python 包语义。
- 入口点：模块级函数 `main`；`if __name__ == "__main__"` 守卫内被调用的模块级函数；
  `__main__.py` 同守卫规则；函数装饰器文本匹配 `*.get/post/put/delete/patch/route/websocket(...)`
  （FastAPI/Flask/aiohttp 风格）记为 route；类内方法不参与入口。
- 依赖：解析 `import a.b`、`from a.b import c`（含相对导入 `.`/`..`）；点分模块名映射到项目
  模块目录（最长前缀；`src/` 前缀同时登记 stripped 形式）；同一语句同一目标每次计 1，from≠to；
  `root_files` 的 import 不计（与 Java 实现口径一致）；环检测复用 Tarjan。
- `hot` 保持空数组（OC 侧统计未接入）。失效/截断/并发缓存逻辑不变；`.py` 纳入 mtime 指纹。

**blast_radius（Python）**

- 符号形式：`name`、`Class.method`、`module.name`（`.`/`#` 分隔均可，末段为符号名）；qualifier
  用于类名/模块路径后缀过滤。
- 定义解析：`PsiSearchHelper.processElementsWithWord(IN_CODE)` 按名称找声明（不引用 python
  插件类），限定项目 scope；未命中返回 -32002。
- 引用：`ReferencesSearch` + 现有 `file:` scope 语义；callers 去重/排序/截断/测试标记不变。
- context：最近的 Python 函数/类声明名；无则文件 stem。`is_public_api`：context 为非下划线开头
  的函数/类；模块级引用不算公开 API（与 Java 顶层口径一致）。
- callees：定义体内可 resolve 的项目内 Python 函数/类/变量；跳过项目外目标（typeshed/stdlib）。
- 入口点：`main` context；一层/两层可达逻辑同 Java；风险评级、缓存（symbol|scope +
  modificationCount）、时间预算不变。

**降级**：Python PSI 缺失/安装不完整导致的异常按步骤吞掉并记日志，定义解析失败按 symbol not
found；不因 Python 支持影响 Java 路径，也不在 WebStorm 上假装可分析。

### JS/TS `project_map` / `blast_radius`（W8）

入口门槛扩展为 **Java 或 Python 或 JS/TS** 能力任一可用；`project_map` / `blast_radius`
按被分析文件语言分派。**硬约束：JS/TS 路径禁止调用 TypeScript 语言服务的 resolve/
ReferencesSearch**——W3 已证其跨进程解析会持读许可阻塞数十秒。JS/TS 一律使用
“索引词查找 + PSI 声明/标识符遍历 + 名称级匹配”的语法级实现；精度低于 Java/Python，
但不引入卡死风险。响应契约与错误码不变。

**能力探测**：`JavaScriptSupport` 检查 `JavaScript`/`TypeScript` 语言是否注册
（`Language.findLanguageByID`），失败时回退到 `JavaScript` 插件安装状态（禁用不算）。
IDEA Ultimate / WebStorm 可用；仅 Java/Python 的发行版不受影响。

**project_map（JS/TS）**

- 模块划分沿用目录约定；`.js/.jsx/.ts/.tsx/.mjs/.cjs` 进入入口/依赖扫描。
- 入口点：
  - 每个 `package.json` 的 `main` / `bin`（字符串或对象）解析到项目内 JS/TS 文件，
    记为 `main` / `bin`（目录、无扩展名与 `index.*` 做有界补全）；
  - 路由调用：`JSCallExpression` 文本匹配 `app|router|server|fastify`
    后接 `.get/.post/.put/.delete/.patch/.route/.all/.use(` 且首个参数为字符串字面量，
    或 `@Get/@Post/...` 装饰器；
    记为 `route`，行号为调用/装饰器位置，symbol 优先取外层命名函数；
  - 顶层函数 `main`（存在时）按 `main` 记录。
- 依赖：从 import/export-from/动态 `import()`/`require()` 语句提取模块说明符；
  - 相对路径：按文件目录 + 扩展名（`.ts/.tsx/.js/.jsx/.mjs/.cjs`）与 `/index.*` 补全；
  - 非相对路径：读取最近的 `tsconfig.json`/`jsconfig.json` 的
    `compilerOptions.baseUrl` 与 `paths`（支持单个 `*` 模式），解析项目内别名；
    未命中按外部包忽略；
  - 目标文件映射到所属目录模块，from≠to，同一语句同一模块计 1；
  - 环检测复用 Tarjan。
- `hot` 保持空数组；缓存/失效/截断逻辑不变。

**blast_radius（JS/TS）**

- 符号形式：`name`、`Class.name`、`file.name`（`.`/`#` 分隔，末段为名称）；
  qualifier 用于类名/文件路径后缀过滤；`scope: file:` 优先按该文件语言分派。
- 定义解析：词索引 `processElementsWithWord(IN_CODE)` 收集同名声明的
  `PsiNameIdentifierOwner`（JS 类/函数/变量/属性/参数，按实现类名判定）；索引为空时
  退化为项目内 JS/TS 文件有界扫描。
- 引用：**不调用 resolve**。词索引收集同名标识符出现点，排除声明名本身；索引为空时
  退化为文件扫描。`file:` scope 只扫该文件。callers 去重/排序/截断/测试标记不变。
- context / 公开 API：最近的 JS 函数/类声明名；无则文件 stem。`is_public_api` 近似为
  “context 为非下划线开头的函数/类且不在测试路径”（语法级近似，README 记录取舍）。
- callees：定义体内引用标识符名 → 逐名做有界词索引声明查找（最多 20 个、受时间预算约束）；
  不 resolve，跳过函数体内局部声明名。
- 入口点：callers 中 context 为 `main`，或调用点位于 `package.json` 的 `main`/`bin`
  目标文件内，记为 `reached_from_main`。
- 风险评级、结果缓存（symbol|scope + modificationCount）不变；整次查询受既有时间预算约束。

**降级**：JS/TS 语言服务不可用/索引缺失时按上述扫描兜底；仍无法确定定义时返回 -32002。
不因 JS/TS 支持改变 Java/Python 路径；WebStorm 上 Java/Python 工具照旧返回 -32603。

### 环境卫生（随本批）

- 清理 14 处个人路径硬编码：`Launcher.java:20/38/115/160`、`script/build-local.sh:10/14`、
  `script/run-local.sh:9/44`、`script/gradle-build.sh:14`、`build.gradle.kts`、
  `README.md:89/136` 等——全部改为"发现优先 + 环境变量覆盖 + 通用示例路径"。
- README 增补：发现与选择、sandbox 命名与清理、许可边界（已有章节）。

## 实施切分（供委派）

- **W1 发现/选择/命名/路径清理**：Launcher 多源发现 + product-info 校验 + 选择器 +
  sandbox/locator 命名 + 脚本与 README 去个人路径。
- **W2 optional 依赖 + 守卫 + 项目 SDK 指派 + JDK 发现**：plugin.xml、Java 指定路径守卫、
  ProjectRootManager 指派；与 W1 同在 Launcher 有交叠，建议 W1→W2 串行或同一执行者。
- **W3 JS/TS 卡死诊断与修复**：独立于 W1/W2（用现有 dist 复现），产出根因报告 + 修复/降级。
- **W4 Python/HTML 验证 + 全量回归**：PyCharm/WebStorm dist 上跑 Python/HTML 用例；
  Java 回归（sample-project + 仓库根）；conformance 153/153；manager 测试。
- **W7 Python 语义工具**：project_map 入口/依赖 + blast_radius 定义/引用/分类的 Python 路径；
  独立探针（fixture 项目 + PyCharm dist），不改变 Java conformance 夹具。
- **W8 JS/TS 语义工具**：project_map 入口/依赖 + blast_radius 语法级定义/引用/分类；
  禁止 TS 语言服务 resolve；独立探针（fixture 项目 + IDEA/WebStorm dist）。
- 依赖：W4 在 W1-W3 后；W3 可先行并行；W7 在 W4 后；W8 在 W3/W7 后。

## 验收标准

- [ ] 发现：本机自动找到 IU/PY/WS（注册表源）；`semantic.ide_home`/`SEMANTIC_IDE_HOME`
      优先级最高；`product-info.json` 校验生效；请求产品缺失时报错列出全部候选
- [ ] 选择：Java 项目→IU、Python 项目→PY、JS/TS→IU（本机偏好序）；显式配置覆盖一切。
      信号分层：tier-1（标准布局根 / `JAVA_MODULE` iml / 构建清单）决定性，tier-2 扩展名计数仅
      回退与取证（Java 项目不再因 `tests/*.py` 误选 PyCharm）
- [ ] Java 回归：sample-project 全绿；仓库根 `semantic-server/**.java` 可解析
      （read_view 有锚点/诊断；blast_radius 可用）——项目 SDK 已自动指派 **且 Java source root
      已自动补齐**（SDK 必要但不充分，见背景 1）
- [ ] JS/TS：repo 根 TS 文件 read_view < 10s（p50）无卡死；blast_radius TS 符号可用
- [ ] Python：PyCharm dist 守护对 Python 项目 read_view / blast_radius / project_map 正常；
      sandbox 按 `-PY<major>` 隔离（与 `-IU<major>` 不混）
- [ ] JS/TS：IDEA/WebStorm dist 下 project_map（package.json/路由入口、import/tsconfig
      依赖）与 blast_radius（不调用 TS 服务、无线程卡死）正常；精度取舍见 README
- [ ] HTML：read_view smoke 通过（内容/位置/覆盖）
- [ ] 插件在 PC/WS dist 上可加载；无 Java 能力时 Java 功能优雅降级（不报错、不崩溃）
- [ ] 卫生：`git grep` 个人路径为 0；无任何许可检测/绕过代码（AGENTS 不变量）
- [ ] 回归：conformance 153/153；`packages/opencode` manager/工具测试与 typecheck 干净
- [ ] 文档：README 含发现/选择说明、sandbox 命名与旧目录清理提示、许可边界

## 风险与备注

- 平台版本隔离是硬约束：同一项目在不同 dist 下必须不同 sandbox，否则 system 缓存损坏。
- 自动选择是启发式；混合仓库（TS+Java+Python 同仓）可能按偏好序选错——文档指引
  `semantic.ide` 显式覆盖，不做"多 dist 同时服务一个项目"（非目标）。
- 显式 IDE 切换会产生第二个守护（locator 带 ideKey）；auto 模式下切换自动选择结果
  会复用旧守护直到空闲退出——文档说明，不做强制迁移。
- PyCharm/WebStorm 为专有产品：仅自带许可使用（不变量）；PyCharm CE（Apache 2.0）
  保留为未来可分发选项，LSP 为远期分发友好路线。
- JS/TS 卡死修复可能牵动锚点策略（信息量 vs 性能）：若采用降级方案，必须在 README
  记录阈值与已知取舍。
- 本 spec 落地后同步 `LLM-IDE-SPEC/main.md` 决策表（多语言/发行版选择）。

## 发行形态与闸门（当前定位冻结）

当前定位：**个人开发与使用；不主动产品化**。该形态下本 spec 的重依赖（本机自带许可 IDE）
完全成立；授权面干净——协议红线（再分发、向第三方提供访问、反向工程）均不触发。

以下任一情形发生即视为触发"闸门"，须先完成对应动作再继续演进：

| 触发情形 | 必须动作 |
|---|---|
| 商业分发 / 白牌 / 托管服务形态 | 切换 LSP 后端（见 `lsp-backend.md`）或与 JetBrains 达成 OEM/书面许可 |
| 被收购或大额资助的尽职调查 | 本 spec + `AGENTS.md` License Boundary + README 声明即尽调材料；补 LSP 迁移计划 |
| 开源影响力显著上升（出现大量非授权使用者） | 向 JetBrains legal/sales 发书面场景澄清；强化文档立场与 issue 政策 |
| 任何"打包/内置 JetBrains 组件"的诉求 | 一律拒绝；只允许"用户自带 IDE"或 LSP |

不变量（任何形态下保持）：不打包、不代下载（插件/IDE）、不代理访问、不读取授权状态。
