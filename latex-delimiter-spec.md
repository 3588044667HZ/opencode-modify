# Spec：为 opencode 桌面客户端补齐 LaTeX 定界符渲染

> 用途：在新 session 中直接以此为任务说明修改客户端源码。
> 记录时间：2026-09-28

## 背景

- 源码仓库：`E:\opencode-source`（anomalyco/opencode 自编译分支，工作区内有他人未提交改动，禁止碰无关文件）
- 自编译产物：`D:\opencode-desktop-dev\OpenCode Dev.exe`（进程名 "OpenCode Dev"）
- 已实测的渲染行为（在桌面客户端里）：
  - `\(...\)` 行内：✅
  - `\[...\]`：❌ 原样输出（反斜杠可见）
  - `$...$` 行内：❌ 原样输出
  - `$$...$$` 单行：❌ 原样输出
  - `$$\n...\n$$` 独立成行：✅
  - `\(...\)` 内复杂宏（`\underbrace`、`\xrightarrow`、`\begin{bmatrix}`、`\text{中文}`）：✅
- 需求来源：`E:\deepseek-share-export` 下的 DeepSeek 导出记录大量使用 `\[ ... \]` 块级公式（如 信号与系统之卷积.json 约 100 处、牛顿插值法与差分.json 约 240 处），`$$` 块级也在个别文件出现；这些在客户端里目前全都不渲染。

## 目标文件（只允许改这两个）

- `E:\opencode-source\packages\ui\src\context\marked-parser.tsx`
- `E:\opencode-source\packages\ui\src\context\marked-parser.test.ts`

不要改 `packages/ui/src/context/marked.tsx` 和 `packages/session-ui/src/components/markdown.worker.ts`（它们只是调用方，桌面端消息解析走 session-ui 的 worker，但都复用这个 parser）。

## 现状代码（marked-parser.tsx）

```ts
const inlineMathRegex = /^\\\(((?:\\.|[^\\\n])*?)\\\)/
const blockMathRegex = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/
```

- 两个 marked extension：inlineKatex（level: "inline"，displayMode false）、blockKatex（level: "block"，displayMode true）
- 统一由 `renderKatexToken` 调 `katex.renderToString(text, { displayMode, throwOnError: false })`

## 需求（验收标准）

1. `\[...\]` 渲染为 display math（`<span class="katex-display">`）：需同时支持
   - 独立成行的块级写法（导出记录的主要形式）：
     `\[\n y(t)=\int x(\tau)h(t-\tau)\,d\tau \n \]`
   - 嵌在段落中间的行内写法：`前文 \[x^2\] 后文`
   - 内容可跨行，可含 `\\`、`\begin{bmatrix}...\end{bmatrix}`、`\text{中文}` 等
2. `$$...$$` 单行写法渲染为 display math；保留现有 `$$\n...\n$$` 行为不回归
3. `$...$` 行内渲染为 inline math，且满足防误判规则：
   - 开闭 `$` 内侧无空白（`$ x$`、`$x $` 不匹配）
   - 内容不得跨行
   - 不吞 `$$`（`$$` 必须优先匹配）
   - `\$` 转义不触发
   - 货币文本如 `价格 $5 和 $10` 不得渲染
   - 围栏代码块 ```...``` 与行内 code `` `...` `` 内的定界符不得渲染
4. 流式安全：只有开定界符、还没闭合时（如刚打出 `\[`），tokenizer 返回 undefined，不得吞掉后续文本、不得抛错；`throwOnError: false` 保持不变
5. 现有测试全部保持通过（link 渲染、`\(x^2\)`、`$$\nx^2\n$$\n`、shiki 高亮）

## 实现建议

- 新增的三种定界符都做成 inline-level extension（用 displayMode 区分展示/行内），这样单行、独立成行、段落内嵌三种位置全覆盖。
- 保留原 blockKatex，避免改变 `$$\n...\n$$` 的既有 token 行为。
- 注册顺序：`$$` 在 `$` 之前。
- `start()` 用 `src.indexOf(...)` 返回最早候选位置（每个 extension 各自实现即可，marked 会取最小值）。
- 参考正则（可在实现时微调，但必须满足上面全部用例）：

```ts
const inlineMathRegex = /^\\\(((?:\\.|[^\\\n])*?)\\\)/      // 保持
const blockMathRegex = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/    // 保持
const displayBracketRegex = /^\\\[([\s\S]+?)\\\]/
const displayDollarRegex = /^\$\$([\s\S]+?)\$\$/
const inlineDollarRegex = /^\$(?!\$)(?![ \t\n])((?:\\.|[^\\\n$])+?)(?<![ \t\n\\])\$(?!\$)/
```

- 渲染统一复用 `renderKatexToken`。

## 测试要求（marked-parser.test.ts）

新增/更新用例，至少覆盖：

- 正向 → 含 `class="katex"`：`\(x^2\)`、`a $x^2$ b`、`\[x^2\]`
- 正向 → 含 `class="katex-display"`：`$$\nx^2\n$$\n`、`$$x^2$$`、`\[\nx^2\n\]\n`
- 负向 → 不含 `katex`：`价格 $5 和 $10`、`\$x\$`、围栏代码块里的 `\[\nx\n\]`、行内 code `` `$x$` ``
- 真实样本回归（来自 `E:\deepseek-share-export\信号与系统之卷积.json`）：
  - `\[\ny(t)=x(t)*h(t)=\int_{-\infty}^{\infty}x(\tau)h(t-\tau)\,d\tau\n\]`
  - 含 `\begin{bmatrix} 1 & 1 \\ 1 & 1 \end{bmatrix}` 与 `\underbrace{...}_{\text{面积}=x(k\Delta)\Delta}` 的块级样本

## 验证命令

- 工作目录：`E:\opencode-source\packages\ui`
- bun 位于 `C:\Users\Administrator\.bun\bin\bun.exe`（1.3.14）
- `bun test src/context/marked-parser.test.ts`
- `bun run typecheck`
- 桌面端重建：沿用现有自编译流程（查 packages/desktop 的 scripts；产物更新到 `D:\opencode-desktop-dev\OpenCode Dev.exe`），重启后人工确认上面样本都能渲染

## 约束

- 先读 `E:\opencode-source\AGENTS.md` 与 `packages/ui/AGENTS.md`，遵循仓库约定
- 不提交 git，不修改无关文件（工作区已有他人改动）
- 完成后汇报：改动文件、测试结果、以及需要用户执行的构建步骤

## 备注

- `\[` 在 Markdown 里同时是"转义方括号"的语法，但本客户端场景下按公式处理是预期行为（DeepSeek 导出全部这么用）。
- `$...$` 的货币误判已用"内侧无空白"规则规避；如果发现仍有误伤，可再加"开 `$` 后不能是纯数字开头"的限制。
