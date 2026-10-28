import { randomBytes } from "node:crypto"
import type { LanProxyTarget } from "./lan-proxy"

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128

export function generatePassword() {
  return randomBytes(18).toString("base64url")
}

export function passwordError(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
  }
  if (!/^[\x20-\x7E]+$/.test(password)) {
    return "Password must use printable ASCII characters"
  }
}

export function normalizeTarget(target: LanProxyTarget): LanProxyTarget {
  const url = new URL(target.url)
  if (url.hostname !== "0.0.0.0" && url.hostname !== "::" && url.hostname !== "[::]") return target
  url.hostname = "127.0.0.1"
  return { ...target, url: url.toString() }
}

export function sameTarget(left: LanProxyTarget | undefined, right: LanProxyTarget | undefined) {
  return left?.url === right?.url && left?.username === right?.username && left?.password === right?.password
}
