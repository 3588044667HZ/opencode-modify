import os from "node:os"

export type DeviceInfo = {
  readonly name: string
  readonly platform: string
  readonly hostname: string
}

export function device(): DeviceInfo {
  const hostname = os.hostname()
  return {
    name: process.env.OPENCODE_DEVICE_NAME?.trim() || hostname,
    platform: process.platform,
    hostname,
  }
}
