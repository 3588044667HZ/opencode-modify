# 构建记录（Build Log）

本文件由 `bun run build:local` 自动维护：每次构建追加或更新一行，记录 Build ID 与两端运行时标记。
修改代码后请运行 `bun run build:local`（或手工追加一行说明本次更改），确保 GUI 与服务端标记来自同一次构建；两者不一致时先重新构建再验证。

| 时间 | Build ID | 提交 | 本次更改 | 服务端标记 | GUI 标记 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-13 13:53 | 261013-1336-9fed169-dirty | 9fed169 | chore: cut upstream opencode runtime/build ties | 261013-1336-9fed169-dirty | 261013-1336-9fed169-dirty |
| 2026-10-13 18:53 | 261013-1853-a4e168d-dirty | a4e168d | feat(build): add build markers for server and GUI; fix(app): keep agent teams panel mounted across polls | 261013-1853-a4e168d-dirty | 261013-1853-a4e168d-dirty |
