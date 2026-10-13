type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
export const BUILD_ID = import.meta.env.OPENCODE_BUILD_ID ?? "local"

// 自编译分支：永久禁用自动更新，绝不检查官方更新源（update feed），避免官方发行版覆盖本地构建。
export const UPDATER_ENABLED = false
