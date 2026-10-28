# Desktop LAN 访问（维护说明）

目标：桌面应用不改 sidecar 绑定地址，通过一个带密码的 LAN 反向代理，把本机 OpenCode 暴露给同一局域网内的手机/浏览器。

## 1. 拓扑

```text
手机/浏览器
  │  http://<LAN-IP>:4096
  ▼
LAN proxy（Electron main 进程，监听 0.0.0.0）
  │  校验用户 Basic Auth / auth_token
  │  注入 sidecar 自己的 Basic Auth
  ▼
sidecar（127.0.0.1:<随机端口>）
  │
  ├─ /api/*、/event、/pty/* 等 → 正常服务端
  ├─ /__cockpit/projects → 桌面端打开的项目列表（供 Web UI 合并）
  └─ /、静态资源、UI → 本地 Web UI（packages/app/dist 或 resources/web-ui）
       缺失时回退到 sidecar 的内部 UI 代理（app.opencode.ai）
```

**不要让 sidecar 直接监听 0.0.0.0。** 代理方式让桌面端继续使用 loopback + 随机密码，LAN 密码与 sidecar 密码解耦。

## 2. 文件地图

| 文件 | 职责 |
|---|---|
| `packages/desktop/src/main/lan-proxy.ts` | 独立 HTTP/WebSocket 反向代理；认证、头过滤、SSE/升级、端口监听 |
| `packages/desktop/src/main/lan-settings.ts` | 纯函数：密码生成/校验、目标归一化、目标比较（可单测） |
| `packages/desktop/src/main/lan.ts` | 控制器：持久化、safeStorage、启动/停止/重启、队列串行化；从 `opencode.global.dat` 读取桌面项目列表 |
| `packages/desktop/src/main/ipc.ts` | `lan-access-get` / `lan-access-set` IPC，输入校验 |
| `packages/desktop/src/preload/index.ts` | `window.api.lanAccess` 桥接 |
| `packages/desktop/src/preload/types.ts` | `LanAccessAPI` 类型 |
| `packages/desktop/src/renderer/index.tsx` | 把 `window.api.lanAccess` 注入 `Platform` |
| `packages/app/src/context/platform.tsx` | `LanAccessStatus` / `LanAccessPlatform` 类型 |
| `packages/app/src/components/settings-v2/lan-access.tsx` | 设置 > 服务器 > Local Server UI |
| `packages/app/dist` | `build:local` 产出的本地 Web UI，LAN 代理优先服务它 |
| `script/build-semantic.ts` | 独立/随 `build:local` 构建语义 jar |
| `packages/desktop/src/main/lan-proxy.test.ts` | 代理 HTTP 认证/转发/畸形请求/网络地址测试 |
| `packages/desktop/src/main/lan-settings.test.ts` | 密码/目标纯函数测试 |

## 3. 生命周期

1. 桌面 main 在 `app.whenReady()` 后创建 `createLanAccess(logger)`。
2. sidecar ready（v1 或 v2）后调用 `lanAccess.attach({ url, username, password })`。
3. 如果设置里已启用，控制器在 `0.0.0.0:4096` 启动代理；4096 被占用时回退到临时端口。
4. 用户切换开关/保存密码时：
   - 关闭：停止代理，保留密码设置。
   - 开启：启动代理；空密码自动生成 24 字符 base64url 密码。
   - 改密码：先停再起，URL 可能变化（端口回退时）。
5. `killSidecar`、`stopSidecars`、`will-quit` 都会停止代理。
6. 设置持久化在 `opencode.settings` 的 `lanAccessEnabled` / `lanAccessPassword`。

## 4. 项目与会话一致性

- 桌面端的项目列表是客户端持久化状态；服务端只持久化 git 项目（非 git 目录都归到 `global`）。
- LAN 代理额外提供受认证的 `GET /__cockpit/projects`，返回 `opencode.global.dat` 中 `server.projects.local` 与 `server.lastProject.local`。
- Web UI 在服务端项目列表加载后合并该列表，因此桌面端打开的非 git 目录也会显示；会话仍按 `directory` 由服务端加载。
- 各客户端自己的 `recentlyClosed` 仍然生效，关闭的项目不会因为合并而重新出现。

## 5. 安全模型

- 用户名固定 `opencode`；密码 8–128 位 printable ASCII。
- 密码优先用 Electron `safeStorage` 加密；不可用时降级为 `plain:` 并记录 warning。
- 代理对客户端校验 Basic Auth，也接受 `?auth_token=base64(user:pass)`（供浏览器 WebSocket 使用）。
- 转发前移除客户端 `Authorization`，注入 sidecar 自己的 Basic Auth。
- 移除 hop-by-hop、`forwarded`、`x-forwarded-*`；重新注入可信的 `x-forwarded-for` / `x-forwarded-proto`。
- `site.webmanifest` 和两个 PWA 图标不要求认证，其余全部要求。
- **没有内置 TLS**。只建议在可信局域网使用；公网请用 Tailscale/WireGuard 或 Caddy/Nginx 反代 + HTTPS。

## 6. 手动验证

1. 打开 设置 > 服务器 > Local Server，开启开关。
2. 复制密码和 URL（例如 `http://192.168.1.23:4096`）。
3. 浏览器打开 URL，使用用户名 `opencode` + 密码登录。
4. 命令行验证：

```bash
curl -u opencode:<password> http://<LAN-IP>:4096/api/health
```

5. 修改密码并保存，确认旧密码 401、新密码可用。
6. 关闭开关，确认端口不再监听。

## 7. 常见问题

| 现象 | 检查 |
|---|---|
| 没有 URL | 机器没有非 loopback IPv4；或代理启动失败，看设置里的 error |
| 手机打不开 | 同一 Wi-Fi？Windows 防火墙是否允许专用网络？路由器是否开 AP 隔离？ |
| 401 | 用户名必须是 `opencode`；密码区分大小写；是否保存后重启了代理 |
| 端口冲突 | 默认 4096 被占用时会回退临时端口，以 UI 显示为准 |
| 页面能开但接口失败 | 本地 `packages/app/dist`/`resources/web-ui` 缺失时会回退到 `app.opencode.ai`，离线环境会失败 |
| Web 缺少部分项目 | 确认 `GET /__cockpit/projects` 带认证后返回列表；桌面端列表来自 `opencode.global.dat` 的 `server.projects.local` |
| 修改后不生效 | 需要 `bun run build:local`；部署版需要 `--package --deploy` |

## 8. 维护边界

- 代理必须保持 **无业务逻辑**：只做认证、转发、头部处理。
- 不要把 LAN 密码和 sidecar 密码合并；sidecar 密码由桌面端随机生成。
- 不要绕过 `lan-settings.ts` 的密码校验；IPC 只做粗校验。
- WebSocket 升级路径很容易回归：改代理后至少跑 `lan-proxy.test.ts`，并在 Node 下手动验证一次升级（Bun 的 `node:http` upgrade 测试会跳过）。
- 新增公开路径时同步更新 `lan-proxy.ts` 的 `publicPaths`。
- 静态资源（`/assets/*`）允许无认证加载；HTML 和 API 仍然要求认证。
- 带 hash 的静态资源使用 `immutable` 长缓存，`index.html` 使用 `no-cache`；JS/CSS/JSON/SVG/HTML 等按 `Accept-Encoding` 使用 br/gzip。
- 新增 API 前缀时同步更新 `isApiPath`，否则带 `Accept: text/html` 的请求可能被当成 SPA 路由。
- 未来可选：二维码、端口选择、只读模式、TLS、状态栏指示。
