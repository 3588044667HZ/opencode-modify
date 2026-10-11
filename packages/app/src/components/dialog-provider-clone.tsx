import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { Provider } from "@opencode-ai/sdk/v2/client"
import { createSignal, Show, type Accessor, type Component } from "solid-js"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { cloneProviderConfig, cloneProviderID } from "./provider-clone"

export const DialogCloneProvider: Component<{
  provider: Provider
  directory?: Accessor<string | undefined>
}> = (props) => {
  const dialog = useDialog()
  const providers = useProviders(() => props.directory?.())
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [name, setName] = createSignal(`${props.provider.name} 2`)
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    const displayName = name().trim()
    const apiKey = key().trim()
    if (!displayName) {
      setError("Display name is required")
      return
    }
    if (!apiKey) {
      setError("API key is required")
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      const providerID = cloneProviderID(props.provider.id, providers.all().keys())
      await serverSync().updateConfig({
        provider: { [providerID]: cloneProviderConfig(props.provider, displayName) },
      })
      await serverSdk().client.auth.set({
        providerID,
        auth: { type: "api", key: apiKey },
      })
      await serverSdk()
        .client.instance.dispose()
        .catch(() => undefined)
      await serverSdk()
        .client.global.dispose()
        .catch(() => undefined)
      await serverSync().refreshProviders().catch(() => undefined)
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: `${displayName} added`,
        description: `Select ${displayName} in the model picker to use this key.`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogV2 fit containerClass="!w-[min(calc(100vw_-_16px),480px)]">
      <DialogHeader closeLabel="Close">
        <DialogTitle>{`Add ${props.provider.name} account`}</DialogTitle>
      </DialogHeader>
      <DialogBody class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
          <div>{`Create a separate provider with its own API key. Models and thinking settings are copied from ${props.provider.name}, and you can rename it at any time.`}</div>
          <form onSubmit={submit} class="flex flex-col items-start gap-5 self-stretch">
            <label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">
              Display name
              <TextInputV2
                class="!w-full"
                data-input="provider-clone-name"
                value={name()}
                invalid={error() !== undefined}
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">
              API key
              <TextInputV2
                class="!w-full"
                data-input="provider-clone-key"
                placeholder="API key"
                value={key()}
                invalid={error() !== undefined}
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setKey(event.currentTarget.value)}
              />
            </label>
            <Show when={error()}>
              {(message) => (
                <div role="alert" class="-mt-4 text-xs text-v2-state-fg-danger">
                  {message()}
                </div>
              )}
            </Show>
            <ButtonV2 type="submit" variant="contrast" disabled={busy()} data-action="provider-clone-submit">
              {busy() ? "Saving..." : "Create provider"}
            </ButtonV2>
          </form>
        </div>
      </DialogBody>
    </DialogV2>
  )
}

export const DialogRenameProvider: Component<{ provider: Provider }> = (props) => {
  const dialog = useDialog()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [name, setName] = createSignal(props.provider.name)
  const [error, setError] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    const displayName = name().trim()
    if (!displayName) {
      setError("Display name is required")
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      await serverSync().updateConfig({ provider: { [props.provider.id]: { name: displayName } } })
      await serverSdk()
        .client.instance.dispose()
        .catch(() => undefined)
      await serverSdk()
        .client.global.dispose()
        .catch(() => undefined)
      await serverSync().refreshProviders().catch(() => undefined)
      dialog.close()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogV2 fit containerClass="!w-[min(calc(100vw_-_16px),480px)]">
      <DialogHeader closeLabel="Close">
        <DialogTitle>{`Rename ${props.provider.name}`}</DialogTitle>
      </DialogHeader>
      <DialogBody class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <form onSubmit={submit} class="flex flex-col items-start gap-5 px-3">
          <label class="flex w-full flex-col gap-1 text-[13px] font-[530] leading-4 text-v2-text-text-base">
            Display name
            <TextInputV2
              class="!w-full"
              data-input="provider-rename-name"
              value={name()}
              invalid={error() !== undefined}
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <Show when={error()}>
            {(message) => (
              <div role="alert" class="-mt-4 text-xs text-v2-state-fg-danger">
                {message()}
              </div>
            )}
          </Show>
          <ButtonV2 type="submit" variant="contrast" disabled={busy()} data-action="provider-rename-submit">
            {busy() ? "Saving..." : "Submit"}
          </ButtonV2>
        </form>
      </DialogBody>
    </DialogV2>
  )
}
