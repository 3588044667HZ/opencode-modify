import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  children,
  createEffect,
  createMemo,
  createSignal,
  type JSXElement,
  onMount,
  type ParentProps,
  Show,
} from "solid-js"
import { useLanguage } from "@/context/language"
import { type ServerConnection, serverName } from "@/context/server"
import type { ServerDevice, ServerHealth } from "@/utils/server-health"

interface ServerRowProps extends ParentProps {
  conn: ServerConnection.Any
  status?: ServerHealth
  class?: string
  nameClass?: string
  versionClass?: string
  dimmed?: boolean
  badge?: JSXElement
  showCredentials?: boolean
}

export function ServerRow(props: ServerRowProps) {
  const language = useLanguage()
  const [truncated, setTruncated] = createSignal(false)
  let nameRef: HTMLSpanElement | undefined
  let versionRef: HTMLSpanElement | undefined
  const name = createMemo(() => serverName(props.conn))

  const check = () => {
    const nameTruncated = nameRef ? nameRef.scrollWidth > nameRef.clientWidth : false
    const versionTruncated = versionRef ? versionRef.scrollWidth > versionRef.clientWidth : false
    setTruncated(nameTruncated || versionTruncated)
  }

  createEffect(() => {
    name()
    props.conn.http.url
    props.status?.version
    queueMicrotask(check)
  })

  onMount(() => {
    if (typeof ResizeObserver !== "function") return
    createResizeObserver([nameRef, versionRef], check)
    check()
  })

  const tooltipValue = () => (
    <span class="flex items-center gap-2">
      <span>{serverName(props.conn, true)}</span>
      <Show when={props.status?.device}>
        {(device) => (
          <span class="text-text-invert-weak">
            {platformName(device().platform)} · {device().name}
          </span>
        )}
      </Show>
      <Show when={props.status?.version}>
        <span class="text-text-invert-weak">v{props.status?.version}</span>
      </Show>
    </span>
  )

  const badge = children(() => props.badge)

  return (
    <Tooltip
      class="flex-1 min-w-0"
      value={tooltipValue()}
      contentStyle={{ "max-width": "none", "white-space": "nowrap" }}
      placement="top-start"
      inactive={!truncated() && !props.conn.displayName}
    >
      <div class={props.class} classList={{ "opacity-50": props.dimmed }}>
        <div class="flex flex-col items-start min-w-0 w-full">
          <div class="flex flex-row items-center gap-2 min-w-0 w-full">
            <span ref={nameRef} class={`${props.nameClass ?? "truncate"} min-w-0`}>
              {name()}
            </span>
            <Show when={props.status?.device?.name}>
              <ServerDeviceTag device={props.status?.device} />
            </Show>
            <Show
              when={badge()}
              fallback={
                <Show when={props.status?.version}>
                  <span
                    ref={versionRef}
                    class={`${props.versionClass ?? "text-text-weak text-14-regular truncate"} min-w-0`}
                  >
                    v{props.status?.version}
                  </span>
                </Show>
              }
            >
              {(badge) => badge()}
            </Show>
          </div>
          <Show when={props.showCredentials && props.conn.type === "http" && props.conn}>
            {(conn) => (
              <div class="flex flex-row gap-3">
                <span>
                  {conn().http.username ? (
                    <span class="text-text-weak">{conn().http.username}</span>
                  ) : (
                    <span class="text-text-weaker">{language.t("server.row.noUsername")}</span>
                  )}
                </span>
                {conn().http.password && <span class="text-text-weak">••••••••</span>}
              </div>
            )}
          </Show>
        </div>
        {props.children}
      </div>
    </Tooltip>
  )
}

export function ServerDeviceTag(props: { device?: ServerDevice }) {
  return (
    <Show when={props.device}>
      {(device) => (
        <span
          class="inline-flex max-w-[180px] shrink-0 items-center gap-1 truncate rounded-md bg-surface-base px-1.5 py-0.5 text-11-regular text-text-weak"
          title={`${platformName(device().platform)} · ${device().name}`}
        >
          <span class="truncate">
            {platformName(device().platform)} · {device().name}
          </span>
        </span>
      )}
    </Show>
  )
}

function platformName(platform: string) {
  if (platform === "win32") return "Windows"
  if (platform === "darwin") return "macOS"
  if (platform === "linux") return "Linux"
  return platform
}

export function ServerHealthIndicator(props: { health?: ServerHealth }) {
  return (
    <div
      classList={{
        "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
        "bg-icon-success-base": props.health?.healthy === true,
        "bg-icon-critical-base": props.health?.healthy === false,
        "bg-border-weak-base": props.health === undefined,
      }}
    />
  )
}
