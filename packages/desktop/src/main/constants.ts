type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// 自编译分支：彻底禁用自动更新，避免官方发行版下载并覆盖本地构建。
export const UPDATER_ENABLED = false
