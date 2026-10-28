import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { type LanAccessInput, type LanAccessPlatform, type LanAccessStatus, usePlatform } from "@/context/platform"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const LanAccessSettings: Component = () => {
  const platform = usePlatform()
  return (
    <Show when={platform.lanAccess}>
      {(lanAccess) => <LanAccessSection lanAccess={lanAccess()} />}
    </Show>
  )
}

const LanAccessSection: Component<{ lanAccess: LanAccessPlatform }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const [status, setStatus] = createSignal<LanAccessStatus>()
  const [password, setPassword] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [loaded] = createResource(
    () => props.lanAccess,
    (lanAccess) => lanAccess.get(),
  )
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    if (disposed) return
    const value = loaded()
    if (value) {
      setStatus(value)
      setPassword(value.password)
      setError(value.error)
      return
    }
    if (loaded.error) setError(describeError(loaded.error))
  })

  const update = (input: LanAccessInput) => {
    if (saving() || disposed) return
    setSaving(true)
    setError(undefined)
    void Promise.resolve()
      .then(() => props.lanAccess.set(input))
      .then((next) => {
        if (disposed) return
        setStatus(next)
        setPassword(next.password)
        setError(next.error)
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(describeError(cause))
      })
      .finally(() => {
        if (!disposed) setSaving(false)
      })
  }

  const copy = (value: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return
    void navigator.clipboard.writeText(value).catch((cause: unknown) => {
      if (!disposed) setError(describeError(cause))
    })
  }

  return (
    <div class="mb-4 [&_[data-slot=settings-v2-row-description]:empty]:hidden">
      <SettingsListV2>
        <SettingsRowV2 title={language.t("desktop.server.local")} description="">
          <Switch
            checked={status()?.enabled ?? false}
            disabled={saving()}
            onChange={(enabled) => update({ enabled, password: password() })}
          >
            <span class="sr-only">{language.t("desktop.server.local")}</span>
          </Switch>
        </SettingsRowV2>

        <Show when={status()?.enabled}>
          <SettingsRowV2 title={language.t("dialog.server.add.username")} description="">
            <div class="w-full sm:w-[280px]">
              <TextInputV2
                value="opencode"
                readOnly
                aria-label={language.t("dialog.server.add.username")}
                showCopyButton
                onCopyClick={() => copy("opencode")}
              />
            </div>
          </SettingsRowV2>

          <SettingsRowV2 title={language.t("dialog.server.add.password")} description="">
            <div class="flex w-full items-center gap-2 sm:w-[360px]">
              <div class="min-w-0 flex-1">
                <TextInputV2
                  type="password"
                  value={password()}
                  placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                  aria-label={language.t("dialog.server.add.password")}
                  disabled={saving()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  showCopyButton
                  onCopyClick={() => copy(password())}
                />
              </div>
              <ButtonV2
                variant="contrast"
                disabled={saving()}
                onClick={() => update({ enabled: true, password: password() })}
              >
                {saving() ? language.t("dialog.server.add.checking") : language.t("common.save")}
              </ButtonV2>
            </div>
          </SettingsRowV2>
        </Show>

        <For each={status()?.urls ?? []}>
          {(url) => (
            <SettingsRowV2 title={language.t("dialog.server.add.url")} description="">
              <div class="flex w-full items-center gap-2 sm:w-[360px]">
                <div class="min-w-0 flex-1">
                  <TextInputV2
                    value={url}
                    readOnly
                    aria-label={language.t("dialog.server.add.url")}
                    showCopyButton
                    copyLabel={language.t("session.share.copy.copyLink")}
                    onCopyClick={() => copy(url)}
                  />
                </div>
                <ButtonV2 variant="neutral" onClick={() => platform.openExternal(url)}>
                  {language.t("common.open")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
          )}
        </For>

        <Show when={error()}>
          {(detail) => (
            <div
              role="alert"
              class="flex flex-col gap-1 py-4 text-xs break-words text-v2-state-fg-danger"
            >
              <span>{language.t("common.requestFailed")}</span>
              <span>{detail()}</span>
            </div>
          )}
        </Show>
      </SettingsListV2>
    </div>
  )
}

function describeError(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
