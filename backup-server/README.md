# OpenCode Backup Server

一个只依赖 Python 3.10+ 标准库的独立备份服务器，用于接收 OpenCode 客户端上传的分块备份。设计目标是：单机长期运行、按用户隔离、追加写友好、能从机械盘损坏中明确报错，而不是静默返回坏数据。

服务器不做 TLS，默认只监听 `127.0.0.1`。对局域网或 Tailscale 暴露时，请按本文的安全建议限制来源，并由 Tailscale 或反向代理终止 TLS。

## 功能概览

- 多用户、按用户名严格隔离；只有管理员添加且处于启用状态的用户才能读写。
- 用户认证支持两种方式：
  - `Authorization: Bearer <token>`
  - `Authorization: Basic base64(username:password)`
- 用户可只保存 token 哈希、只保存密码哈希，或两者都有。
- 内容寻址 chunk：以原始字节的 SHA-256 作为幂等键，重复上传返回 `204`；支持 `HEAD` 查询，仅返回是否存在。
- 追加写 pack 文件，顺序 I/O；默认 512 MiB 轮转，避免海量小文件。
- zlib 压缩落盘；每 8 MiB 或后台空闲时批量 `fsync`，不做逐 chunk `fsync`。
- SQLite 索引使用 WAL + `synchronous=FULL`；索引损坏时可以从 pack 重建。
- 快照 manifest 独立存放；GC 采用标记-清除，垃圾率低于 30% 的 pack 不重打包。
- `serve --keep N` 可在每次快照成功后异步执行保留 N 份的 GC；不阻塞快照响应，并保护尚未写入快照的新上传 chunk。
- 管理员 Web 后台：登录、添加用户、生成 token、设置密码、禁用/启用、删除用户、查看用量。
- 只读全量自检 `verify`：逐条校验 pack 的 magic、长度、CRC32、SHA-256，并与索引和快照交叉核对。
- 磁盘空间低于 2 GiB 时拒绝新 chunk（HTTP 507）。

备份数据可能包含 OpenCode 的凭据和配置。服务端按 chunk 原样存储，不解析内容；请把整个数据目录视为敏感数据。

## 文件与目录

```text
backup-server/
  server.py          # 服务器与 CLI
  test_server.py     # unittest
  README.md
  pyproject.toml     # 仅元数据，无运行时依赖
```

运行时数据目录：

```text
data/
  users.json                 # 用户记录，scrypt 哈希，权限尽量 0600
  admin.json                 # 管理员密码哈希，权限尽量 0600
  index.sqlite3              # 全局索引（WAL / synchronous=FULL）
  users/
    alice/
      packs/00000001.pack    # 追加写数据
      snapshots/<id>.json    # manifest
```

`users.json` 形如：

```json
{
  "version": 1,
  "users": {
    "alice": {
      "password_hash": { "salt": "...", "hash": "...", "n": 16384, "r": 8, "p": 1, "dklen": 32 },
      "token_hash": { "salt": "...", "hash": "...", "n": 16384, "r": 8, "p": 1, "dklen": 32 },
      "disabled": false,
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

新用户至少有一种凭据。密码或 token 的明文不会写入磁盘，也不会写入日志。

## 快速开始（Windows PowerShell）

在仓库根目录执行：

```powershell
cd backup-server

# 初始化数据目录，并设置管理员密码。省略 --admin-password 会交互式输入。
python server.py init --data-dir .\data

# 可选：命令行添加用户。未指定 --token/--password 时生成 token，且只打印一次。
python server.py adduser --data-dir .\data --user alice

# 启动服务，默认只监听本机 127.0.0.1:8787
python server.py serve --data-dir .\data
```

打开 <http://127.0.0.1:8787/admin> 登录管理后台。新增用户时选择“生成 Token”或“设置密码”：

- Token 只在创建或重新生成时显示一次；刷新页面后不再显示。
- 密码和 token 都保存为 scrypt 哈希。
- 禁用用户后，其 Bearer/Basic 请求立即返回 `401`。
- 删除用户会删除该用户的快照、chunk、pack 和数据目录，不可恢复；按页面提示勾选确认。

如果本机的 `python` 是 Microsoft Store 占位符，请使用实际安装路径，例如：

```powershell
E:\python311\python.exe server.py --help
E:\python310\python.exe server.py --help
```

`py -3 server.py ...` 也可以。不要把 `python.exe` 的 Store 别名当作已安装 Python。

### 可选：开机自启

服务器本身不安装系统服务。需要自启时，可用 Windows 任务计划程序运行上述 `serve` 命令；建议：

- 触发器：登录时或开机后延迟 1–2 分钟。
- 运行目录：`backup-server`。
- 参数：`server.py serve --data-dir D:\opencode-backup --host 127.0.0.1 --port 8787`。
- “无论用户是否登录都运行”时，确保数据目录 ACL 对运行账户可写。

## 管理员后台与会话

- 地址：`/admin`，未登录时显示登录表单。
- 管理后台只支持一个管理员账户；密码由 `init` 设置，至少 8 个字符。
- 用户密码只要求非空；建议用密码管理器生成强密码，不要复用。
- 登录使用 `HttpOnly; SameSite=Lax` 的会话 cookie，路径限定 `/admin`。
- 所有后台表单（包括登录表单）都带 CSRF token；缺失或错误返回 `403`。
- 登录失败按来源 IP 限速：5 分钟内最多 5 次失败，超过后返回 `429` 和 `Retry-After`。
- 会话保存在内存中，服务重启后需要重新登录；默认 12 小时过期。
- 修改管理员密码：

  ```powershell
  python server.py init --data-dir .\data --admin-password "new-strong-password" --force-admin-password
  ```

- 后台没有单独的“修改自己的密码”页面；管理员密码通过上面的 CLI 重置。
- TLS 由 Tailscale 或反向代理终止，因此 cookie 默认没有 `Secure` 标记；若只在 HTTPS 下使用，建议在反向代理层补上安全头并限制访问来源。

## 网络暴露与 TLS

默认绑定：

```text
127.0.0.1:8787
```

只允许本机访问。要暴露给局域网：

```powershell
python server.py serve --data-dir .\data --host 0.0.0.0 --port 8787
```

然后用 Windows 防火墙限制来源，例如只允许私有网段：

```powershell
New-NetFirewallRule -DisplayName "OpenCode Backup (LAN)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 `
  -RemoteAddress 192.168.0.0/16
```

如果通过 Tailscale 暴露，推荐继续保持服务器绑定 `127.0.0.1`，用 Tailscale Serve 终止 TLS：

```powershell
tailscale serve --bg 8787
tailscale serve status
```

客户端使用 `https://<主机名>.<tailnet>.ts.net` 访问。Tailscale Serve 会把本机 8787 端口代理到 tailnet，并自动提供 HTTPS 证书。若改为绑定 `0.0.0.0` 让 Tailscale 直接访问，请在防火墙中只放行 Tailscale 网段 `100.64.0.0/10`。

不要把 8787 端口直接端口映射到公网。服务器不做 TLS，也不做应用层限流（管理员登录除外）。更稳妥的方式是：

- Tailscale / WireGuard 内网访问；
- SSH 隧道；
- 反向代理（Caddy/Nginx）终止 TLS，并只允许可信来源访问 `/admin`。

## 客户端 URL 与认证示例

客户端需要三个配置项：

```text
URL:      http://192.168.1.20:8787
          https://backup-pc.tailnet-name.ts.net
USER:     alice
TOKEN:    <创建用户时保存的 token>
# 或 PASSWORD: <管理员为用户设置的密码>
```

Bearer token 上传 chunk：

```powershell
$env:OBK_URL = "http://127.0.0.1:8787"
$env:OBK_USER = "alice"
$env:OBK_TOKEN = "your-token"

$sha = (Get-FileHash -Algorithm SHA256 .\chunk.bin).Hash.ToLower()
curl.exe -X PUT `
  -H "Authorization: Bearer $env:OBK_TOKEN" `
  -H "Content-Type: application/octet-stream" `
  --data-binary "@chunk.bin" `
  "$env:OBK_URL/v1/users/$env:OBK_USER/chunks/$sha"
```

Basic 密码上传 chunk：

```powershell
$pair = [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes("alice:your-password")
)
curl.exe -X PUT `
  -H "Authorization: Basic $pair" `
  -H "Content-Type: application/octet-stream" `
  --data-binary "@chunk.bin" `
  "$env:OBK_URL/v1/users/alice/chunks/$sha"
```

创建快照：

```powershell
curl.exe -X POST `
  -H "Authorization: Bearer $env:OBK_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary "@manifest.json" `
  "$env:OBK_URL/v1/users/alice/snapshots"
```

## HTTP API

除 `GET /v1/health` 外，所有 `/v1` 请求都需要：

```http
Authorization: Bearer <token>
```

或：

```http
Authorization: Basic <base64(username:password)>
```

用户名必须出现在路径中，且 Basic 中的用户名必须与路径一致。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /v1/health` | 无需认证，返回 `{"ok":true,"version":"1"}` |
| `PUT /v1/users/{user}/chunks/{sha256}` | 上传原始 chunk；新存入 `201`，已存在 `204` |
| `GET /v1/users/{user}/chunks/{sha256}` | 下载原始 chunk；读取时校验 CRC32 与 SHA-256 |
| `HEAD /v1/users/{user}/chunks/{sha256}` | 索引中存在时返回 `200` 且无 body；不存在 `404`；不返回内容，用于客户端跳过已上传块 |
| `POST /v1/users/{user}/snapshots` | 创建 manifest；成功 `201`，重复 id `409`，缺 chunk `400` |
| `GET /v1/users/{user}/snapshots` | 按 `created_at` 倒序列出快照摘要 |
| `GET /v1/users/{user}/snapshots/{id}` | 返回完整 manifest |
| `DELETE /v1/users/{user}/snapshots/{id}` | 只删除 manifest；幂等返回 `204` |

错误响应统一为：

```json
{
  "error": {
    "code": "missing_chunk",
    "message": "chunk ... is not stored; upload it before creating a snapshot"
  }
}
```

主要状态码：

- `400`：路径、SHA-256、manifest、缺少 chunk、长度不符等。
- `401`：缺少或错误凭据，或用户已被禁用。
- `404`：chunk、快照或路由不存在。
- `405`：方法不允许。
- `409`：快照 id 或用户已存在。
- `413`：chunk 超过 16 MiB，或 manifest 超过 64 MiB。
- `429`：管理员登录失败次数过多。
- `500`：服务端错误；chunk 损坏时返回 `chunk_corrupt`。
- `507`：磁盘剩余空间低于 2 GiB。

### Manifest

```json
{
  "version": 1,
  "id": "2026-01-01T10-00-00Z-abcdef",
  "created_at": "2026-01-01T10:00:00Z",
  "source": {
    "hostname": "workstation",
    "opencode_version": "0.15.0"
  },
  "files": [
    {
      "path": "opencode.db",
      "size": 123456,
      "sha256": "<整个文件 SHA-256>",
      "chunks": ["<chunk sha256>", "<chunk sha256>"]
    }
  ],
  "total_bytes": 123456
}
```

服务端校验：

- `version` 必须为 `1`。
- `id` 必须匹配 `^[A-Za-z0-9._-]{1,128}$`，且不能是 `.`/`..`。
- `created_at` 必须是可解析的 ISO 8601。
- `files[].path` 必须是相对路径，不能包含 `..`、绝对路径、盘符或控制字符。
- 每个 chunk 必须已经存在。
- 每个文件的 chunk 原始长度之和必须等于 `files[].size`。
- `total_bytes` 必须等于所有文件大小之和。

`GET /v1/users/{user}/snapshots` 的 `files` 是便于展示的摘要数组（每项为 `path`、`size`、`sha256`），不包含 chunk 列表；同时提供 `file_count`。完整 chunk 列表请读取单个快照 manifest。

## 存储格式

### Pack 记录

每个 pack 由连续记录组成，大端序：

```text
magic       4B   b"OBK1"
sha256     32B   原始 chunk 的 SHA-256（幂等键）
raw_len     4B   uint32 BE，原始字节数
stored_len  4B   uint32 BE，zlib 压缩后的字节数
crc32       4B   uint32 BE，压缩后 payload 的 CRC32
payload     N    zlib(raw)
```

- 头部固定 48 字节。
- CRC32 覆盖压缩后的 payload，用于在解压前发现盘面位翻转。
- 下载时仍会解压并校验原始字节的 SHA-256；任何一步失败都返回 `500 chunk_corrupt`，绝不返回坏数据。
- 同一用户同一 SHA-256 只索引一次。重复上传不会追加新记录，返回 `204`。
- pack 默认 512 MiB 轮转；单条记录远小于该上限。

### 索引

`index.sqlite3`：

- `chunks(username, sha256, pack, offset, raw_len, stored_len, crc32)`，主键 `(username, sha256)`。
- `packs(username, name, size)`。
- WAL 模式、`synchronous=FULL`。
- 所有 SQLite 操作由进程内全局锁串行化；HTTP 服务使用 `ThreadingHTTPServer` + daemon 线程。
- 每个用户有独立的写锁；上传、快照创建、读取、GC 都按用户加锁。

### 崩溃安全与索引重建

- 新记录先写入 pack；只有在该批记录 `fsync` 之后，才会提交 SQLite 索引。
- 未达到 8 MiB 的批次由后台线程在空闲约 10 秒后刷新；创建快照、读取 chunk 或关闭服务时也会强制刷新。
- 如果进程在响应 `201` 后、`fsync` 前崩溃，该 chunk 可能丢失；创建快照时服务端会因缺少 chunk 返回 `400`，客户端重新上传即可。
- 启动时检查索引与 pack 大小；只扫描未提交的 pack 尾部。尾部不完整或 CRC 错误的记录会被忽略，文件被截断到最后一条完整记录。
- 索引文件缺失、SQLite 损坏或 schema 不符时，会把旧索引重命名为 `index.sqlite3.corrupt-<timestamp>`，然后从所有 pack 重建。
- `verify` 用于定期全量检查；它不依赖启动修复，也不会改写 pack。

## 磁盘寿命与写入策略

WD Purple 是机械监控盘，适合顺序、追加写；本项目针对这一点做了约束：

- **追加写**：pack 只追加，不原地改写；顺序 I/O 对机械盘最友好。
- **批量 fsync**：默认累计 8 MiB 才 `fsync`，避免每 1 MiB chunk 一次同步；空闲后台刷新；不做逐 chunk `fsync`。
- **一次写入、多次去重**：客户端按内容寻址；未变化的文件不会重复写盘，除非发生了 GC 重打包。
- **低频 GC**：手动 GC 只由管理员显式执行；`serve --keep N` 的自动 GC 只在该用户快照成功后触发，且垃圾率低于 30% 的 pack 跳过重打包。不要一天内创建大量快照，否则自动 GC/重打包会增加机械盘写入。
- **大 pack**：默认 512 MiB 轮转，避免海量小文件带来的元数据开销和随机寻道。
- **每日一次备份**：推荐每天固定时间运行一次客户端备份，而不是持续扫描/上传。
- **保留份数**：建议 `--keep 14` 到 `--keep 30`。保留份数越多，磁盘占用和全量 `verify` 时间越大。
- **GC 频率**：手动模式建议每周或每两周一次；自动模式随每日快照触发一次即可。GC 只删除旧 manifest 和未引用 chunk，重打包时才搬运存活数据。
- **自检频率**：日常备份只校验上传块（服务端已有 CRC/SHA 校验）；建议每月做一次全量 `verify`。全量自检会把所有 pack 顺序读一遍并解压校验，属于额外 I/O，建议放在夜间/空闲时段，不要每天执行。
- **容量余量**：服务端在剩余空间低于 2 GiB 时返回 `507`；建议实际保留 10% 以上空闲空间。
- **健康监控**：定期查看 SMART 状态（厂商工具、CrystalDiskInfo 或 `Get-PhysicalDisk`），关注重定位扇区、待映射扇区、CRC 错误计数。发现增长时尽快替换磁盘并从备份副本恢复。

散热由用户自行处理，本服务不读取或控制温度；写入策略只控制 I/O 形态和频率。

## 每日备份与保留建议

客户端尚未包含在本目录中。建议的每日流程：

1. 计算当前 OpenCode 数据目录的 chunk（建议 1 MiB 左右；服务端上限 16 MiB）。
2. 逐块 `PUT`，已存在的块会返回 `204`。
3. 上传完成后构造 manifest，`POST /v1/users/{user}/snapshots`。
4. 如果快照创建返回 `400 missing_chunk`，回到第 2 步重传缺失块。
5. 使用 `serve --keep N` 自动保留最近 N 个快照；也可以每周/每两周停机执行一次手动 GC。
6. 每月执行一次 `verify`；发现损坏时先保留现场，再按下方恢复步骤处理。

Windows 任务计划程序示例命令（客户端落地后替换为实际命令）：

```powershell
python client.py backup --url http://127.0.0.1:8787 --user alice --token $env:OBK_TOKEN
```

`serve --keep N` 在每次快照成功创建后，由单个后台线程对该用户执行一次现有标记-清除 GC，保留最新 N 份。N<=0 或未配置时不启用。快照响应不等待 GC；GC 失败只写 stderr 日志，不影响快照。后台 GC 会保护自上次快照以来新上传、尚未写入任何快照的 chunk，避免并发备份被误删；手动 `gc` 仍是全量清扫。

```powershell
python server.py serve --data-dir .\data --keep 14
```

手动 `gc` 与 `verify` 仍建议在服务停止时运行；至少不要与正在执行的 `serve` 同时运行。`serve --keep` 的自动 GC 在服务进程内加锁串行执行，是安全的；正常关闭服务时会等待正在运行的自动 GC 结束。

## 管理员 CLI

```powershell
# 初始化数据目录和管理员密码
python server.py init --data-dir .\data
python server.py init --data-dir .\data --admin-password "strong-password"

# 添加用户
python server.py adduser --data-dir .\data --user alice
python server.py adduser --data-dir .\data --user alice --token "explicit-token"
python server.py adduser --data-dir .\data --user alice --password "user-password"
python server.py adduser --data-dir .\data --user alice --password "user-password" --token "token"

# 用户列表（不显示任何明文凭据）
python server.py list-users --data-dir .\data

# 启动（--keep 启用“快照成功后自动 GC”；N<=0 或省略则关闭）
python server.py serve --data-dir .\data --host 127.0.0.1 --port 8787
python server.py serve --data-dir .\data --host 0.0.0.0 --port 8787 --keep 14 --verbose

# GC
python server.py gc --data-dir .\data --keep 14 --dry-run
python server.py gc --data-dir .\data --keep 14

# 全量只读自检
python server.py verify --data-dir .\data
python server.py verify --data-dir .\data --user alice --json

# 自检并把损坏 chunk 从索引移除，允许客户端重新上传
python server.py verify --data-dir .\data --quarantine
```

`--verbose` 也可以放在子命令后。日志只记录方法、路径和修复动作，不记录请求体、manifest、密码或 token。

`gc --keep N` 对每个用户保留最新 N 个快照（按 `created_at`），删除更旧的 manifest，然后标记-清除未被任何保留快照引用的 chunk（手动模式不保护进程内新上传）。`serve --keep N` 复用同一 GC，但只处理触发快照的用户，并保护尚未进入快照的新 chunk。重打包顺序：

1. 写新的 pack 并 `fsync`。
2. 在 SQLite 事务中更新 chunk 位置和 pack 记录。
3. 删除旧 pack。

垃圾率低于 30% 的 pack 不重打包。`--dry-run` 只报告。重打包会先写新的 pack，因此需要额外可用空间（最多约为待重打包 pack 的存活数据量）。自动 GC 仍可能触发重打包，从而增加一次顺序写入；如果每天创建多个快照，建议增大保留份数或改用低频手动 GC。

## 数据自检 `verify`

`verify` 是只读的；默认不会删除或改写任何数据：

- 索引会先复制到系统临时目录再打开校验，避免 SQLite 在真实数据目录中创建 `-shm`；pack、快照和 `users.json` 只读。
- 逐条读取所有 pack，校验 magic、记录长度、CRC32、zlib 解压、原始 SHA-256。
- 核对索引与 pack 记录：
  - 损坏 chunk（带用户、pack、offset、原因）；
  - pack 中存在但索引缺失的记录（`missing_index` / `orphan_records`）；
  - 索引指向不存在的 pack/offset（`missing_pack_records`、`index_mismatches`）；
  - 重复/孤立记录（`duplicate_pack_records`、`unreferenced_chunks`）；
  - 快照引用了缺失或损坏的 chunk（`missing_chunks`）；
  - 无法读取的 manifest（`snapshot_errors`）；
  - pack 尾部截断或 framing 错误。
- 有完整性问题时退出码为 `1`，健康时为 `0`。
- `--json` 输出完整结构化报告；默认输出适合终端阅读的清单。
- `--user NAME` 只检查指定用户。
- `--quarantine` 会把损坏的、索引指向缺失数据的 chunk 从索引中移除。pack 文件不会被删除或改写；客户端下次备份时可以重新上传这些 SHA。自检仍会返回非 0 退出码，因为扫描时确实发现了损坏。

建议频率：每月一次全量；如果最近出现过 `chunk_corrupt`、异常断电或磁盘 SMART 告警，可临时增加一次。全量自检会顺序读取并解压全部数据，对机械盘属于额外负载，避免每天执行。

## 恢复步骤

1. 列出快照：

   ```powershell
   curl.exe -H "Authorization: Bearer $env:OBK_TOKEN" `
     "$env:OBK_URL/v1/users/alice/snapshots"
   ```

2. 选择快照并读取 manifest：

   ```powershell
   curl.exe -H "Authorization: Bearer $env:OBK_TOKEN" `
     "$env:OBK_URL/v1/users/alice/snapshots/<snapshot-id>"
   ```

3. 对 manifest 中每个文件，按 `chunks` 顺序下载每个 SHA-256 对应的 chunk：

   ```powershell
   curl.exe -H "Authorization: Bearer $env:OBK_TOKEN" `
     -o chunk.bin `
     "$env:OBK_URL/v1/users/alice/chunks/<chunk-sha256>"
   ```

4. 将每个文件的 chunk 依次拼接为原始文件，校验总长度和 manifest 中的 `files[].sha256`。

5. 如果某个 chunk 返回 `500 chunk_corrupt`：

   - 不要使用返回内容（服务端会拒绝返回坏数据）；
   - 换一个更早的快照；
   - 或执行 `verify --quarantine` 后让客户端重新上传该 chunk；
   - 如果同一位置反复出现损坏，检查磁盘 SMART 并考虑更换备份盘。

6. 恢复后核对文件大小、哈希和 OpenCode 能否正常启动。

## 安全与隐私

- **备份数据含凭据**：manifest 和 chunk 可能包含 OpenCode 的数据库、配置、token、API key 等。数据目录不应放在公共共享目录。
- 服务器只做 scrypt 哈希保存密码/token；不会把明文凭据写入 `users.json`、`admin.json` 或日志。
- 管理员后台返回的 token 只出现一次；请立即保存到密码管理器。
- Windows 上 `chmod 0600` 只是尽力而为；建议用 NTFS ACL 限制数据目录，例如：

  ```powershell
  icacls .\data /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)(F)"
  ```

- 建议对备份盘启用 BitLocker 或其他全盘加密；并确保备份盘本身有独立副本/冗余策略。
- 服务端不做 TLS；在局域网或 Tailscale 上使用时，依赖网络层加密。不要把 8787 暴露到公网。
- Basic 认证每次请求都会携带密码，只应在 Tailscale、HTTPS 反向代理或本机回环上使用。
- pack、快照、索引和用户目录会尽量设置为 0600/0700；Windows 上仍需用 NTFS ACL 加固。
- 管理员会话 cookie 未设置 `Secure`（因为默认可能是 HTTP）；通过 Tailscale/反向代理提供 HTTPS 后，可在代理层强制 HTTPS。
- 管理员登录失败限速是进程内状态，重启后清零。
- 不同用户的 pack、snapshot 和索引行按用户名隔离；不要手动让两个用户名仅大小写不同（`adduser` 会拒绝大小写重复）。
- 运行 `gc`/`verify` 时建议停止 `serve`；它们是单进程工具，跨进程并发写同一数据目录不在支持范围内。
- 不要把 `users.json`、`admin.json` 或数据目录提交到 Git。

## 测试

在 `backup-server` 目录运行：

```powershell
python -m unittest -v
# 或
E:\python311\python.exe -m unittest -v
```

测试覆盖：

- health、认证失败、Bearer/Basic、禁用用户；
- `adduser` 生成 token 且不落明文；
- chunk 上传、去重、下载、`HEAD` 存在性查询（存在/不存在/未认证/Basic）；
- snapshot 创建、列表、下载还原、重复 id、缺 chunk、尺寸校验；
- 路径穿越/URL 编码绕过拒绝；
- pack 位翻转检测、截断尾部恢复、索引重建；
- GC 保留引用、清理未引用 chunk、重打包；
- `serve --keep` 快照后自动 GC、保留份数、保护剩余快照引用的 chunk、N<=0 关闭；
- 管理员登录、CSRF、添加 token/密码用户、禁用/删除；
- `verify` 健康、损坏定位、只读性、`--quarantine` 后重传。

测试使用临时目录，不接触真实数据。

## 已知限制

- 单进程服务器；不要对同一数据目录启动多个 `serve`。
- 没有 TLS、内置用户自助注册、公开分享链接或审计日志。
- 只有一个管理员账户；管理员密码只能通过 CLI 重置。
- 管理员会话、登录限速都在内存中，重启丢失。
- 快照列表返回文件摘要而不是完整 chunk 列表；完整内容需读取单个 manifest。
- `HEAD /chunks/{sha}` 只检查索引或当前进程的待提交队列，不读取、不解压、不校验 pack；索引存在但数据损坏时仍可能返回 `200`。完整性请用 `verify` 或实际 `GET`。
- 自动 GC 的“新上传保护”只存在于服务进程内存中；重启后会丢失。未写入任何快照的旧 chunk 可能被后续自动 GC 或手动 GC 清理。
- 自动 GC 在快照响应之后异步执行，保留状态可能短暂滞后；GC 失败只写 stderr，不影响已成功的快照。
- 没有直接删除 chunk 的 API；通过 GC 或 `verify --quarantine` 处理。
- `--quarantine` 只修改索引，不修改或删除 pack；损坏的旧记录会作为垃圾留在 pack 中，等 GC 重打包时清理。
