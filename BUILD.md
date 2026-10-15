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
| 2026-10-14 19:22 | 261014-1922-9fcd804 | 9fcd804 | feat(semantic): implement verify_test in the semantic server; feat(semantic): add project_map client, renderer and tool; feat(semantic): add verify_test client, renderer and tool; docs(spec): add project map spec; docs(spec): add verify test spec; chore(build): record edit batch build markers; feat(semantic): add edit_batch client, renderer and tool; feat(semantic): implement edit_batch in the semantic server; docs(spec): add edit batch spec | 261014-1922-9fcd804 | 261014-1922-9fcd804 |
| 2026-10-14 20:42 | 261014-2042-d18c353-dirty | d18c353 | feat(semantic): add edit_batch file-level write locking; docs(spec): add fallback option direct spec; feat(semantic): add edit_batch lock timeout protocol, renderer and tool options; docs(spec): add edit batch concurrency spec; feat(semantic): implement project_map in the semantic server; chore(build): record verify test and project map build markers | 261014-2042-d18c353-dirty | 261014-2042-d18c353-dirty |
| 2026-10-14 22:44 | 261014-2244-b9d0837 | b9d0837 | feat(semantic): add edit_transaction with journal-based crash recovery; feat(semantic): add edit_transaction client, renderer and tool; docs(spec): add edit transaction spec; chore(build): record fallback tool build markers; feat(tool): add tool visibility hide flag and fallback_option_direct | 261014-2244-b9d0837 | 261014-2244-b9d0837 |
| 2026-10-14 22:54 | 261014-2254-bb17f78 | bb17f78 | chore(build): record edit transaction build markers | 261014-2254-bb17f78 | 261014-2254-bb17f78 |
| 2026-10-14 23:19 | 261014-2319-bb17f78-dirty | bb17f78 | 未提交改动 | 261014-2319-bb17f78-dirty | 261014-2319-bb17f78-dirty |
| 2026-10-15 08:05 | 261015-0805-01f0276-dirty | 01f0276 | fix(semantic): reuse stable per-directory daemon sockets; fix(semantic): isolate daemon sandbox per project | 261015-0805-01f0276-dirty | 261015-0805-01f0276-dirty |
| 2026-10-15 08:28 | 261015-0828-e3536fc | e3536fc | chore(build): record daemon isolation build markers | 261015-0828-e3536fc | 261015-0828-e3536fc |
| 2026-10-15 08:59 | 261015-0859-4ebbb7e-dirty | 4ebbb7e | feat(semantic): protect project model files and invalidate the map on model changes; fix(semantic): start the daemon lazily with serialized spawns; feat(app): load project sessions lazily on demand | 261015-0859-4ebbb7e-dirty | 261015-0859-4ebbb7e-dirty |
