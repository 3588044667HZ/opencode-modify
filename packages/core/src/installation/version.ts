declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_BUILD_ID: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationBuild = typeof OPENCODE_BUILD_ID === "string" ? OPENCODE_BUILD_ID : "local"
export const InstallationLocal = InstallationChannel === "local"
