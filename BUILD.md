# 构建记录（Build Log）

本文件由 `bun run build:local` 自动维护：每次构建追加或更新一行，记录 Build ID 与两端运行时标记。
修改代码后请运行 `bun run build:local`（或手工追加一行说明本次更改），确保 GUI 与服务端标记来自同一次构建；两者不一致时先重新构建再验证。

| 时间 | Build ID | 提交 | 本次更改 | 服务端标记 | GUI 标记 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-13 13:53 | 261013-1336-9fed169-dirty | 9fed169 | chore: cut upstream opencode runtime/build ties | 261013-1336-9fed169-dirty | 261013-1336-9fed169-dirty |
| 2026-10-13 18:53 | 261013-1853-a4e168d-dirty | a4e168d | feat(build): add build markers for server and GUI; fix(app): keep agent teams panel mounted across polls | 261013-1853-a4e168d-dirty | 261013-1853-a4e168d-dirty |
| 2026-10-13 19:19 | 261013-1919-85124c3-dirty | 85124c3 | chore(build): default --package to dir packaging and add --installer | 261013-1919-85124c3-dirty | 261013-1919-85124c3-dirty |
| 2026-10-14 14:33 | semantic-warmup-manual | 85124c3 | feat(app): 语义引擎预热进度条 + 预热期提问排队 + ready/failed 自动放行，失败 toast/响铃/通知 | 未构建 | 未构建 |
| 2026-10-14 15:44 | 261014-1544-85124c3-dirty | 85124c3 | 未提交改动 | 261014-1544-85124c3-dirty | 261014-1544-85124c3-dirty |
| 2026-10-14 16:47 | 261014-1647-ad0db83-dirty | ad0db83 | chore(build): record semantic engine build markers; feat(app): add semantic warmup progress and prompt queue; feat(semantic): add semantic engine client, token view renderer and read_view tool; feat(semantic): add headless IntelliJ semantic server; docs(spec): add LLM IDE semantic engine spec; chore: prune upstream leftovers | 261014-1647-ad0db83-dirty | 261014-1647-ad0db83-dirty |
| 2026-10-14 18:36 | 261014-1836-df689eb-dirty | df689eb | chore(build): record blast radius build markers; feat(semantic): add blast_radius client, renderer and tool; feat(semantic): implement blast_radius in the semantic server; docs(spec): add blast radius spec | 261014-1836-df689eb-dirty | 261014-1836-df689eb-dirty |
