import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, For, Show, createMemo, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { createBackupSettingsController, formatByteSize } from "./backup-controller"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsBackupV2: Component = () => {
  const language = useLanguage()
  const serverSDK = useServerSDK()

  const controller = createBackupSettingsController({
    api: {
      status: () => serverSDK().client.v2.backup.status({ throwOnError: true }).then((result) => result.data),
      run: () => serverSDK().client.v2.backup.run({ throwOnError: true }).then((result) => result.data),
      snapshots: (input) =>
        serverSDK()
          .client.v2.backup.snapshots({ limit: input?.limit }, { throwOnError: true })
          .then((result) => result.data),
      configure: (input) =>
        serverSDK()
          .client.v2.backup.configure({ backupConfigureInput: input }, { throwOnError: true })
          .then((result) => result.data),
    },
  })

  onMount(() => {
    void controller.refresh()
  })

  const status = () => controller.state.status

  const formatBytes = createMemo(() => (value?: number) => formatByteSize(value, language.intl()))

  const formatDuration = createMemo(() => {
    const formatter = new Intl.NumberFormat(language.intl(), { style: "unit", unit: "millisecond" })
    return (value?: number) => (value === undefined ? "—" : formatter.format(value))
  })

  const formatDate = createMemo(() => {
    const formatter = new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" })
    return (value?: string) => {
      if (!value) return language.t("settings.backup.status.never")
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return language.t("settings.backup.status.never")
      return formatter.format(date)
    }
  })

  const save = () => {
    void controller.save().then((result) => {
      if (result.ok) {
        showToast({ variant: "success", title: language.t("settings.backup.toast.saved") })
        return
      }
      showToast({
        title: language.t("settings.backup.toast.saveFailed"),
        description: result.message ?? language.t("common.requestFailed"),
      })
    })
  }

  const run = () => {
    void controller.run().then((result) => {
      if (result.ok) {
        showToast({ variant: "success", title: language.t("settings.backup.toast.started") })
        return
      }
      showToast({
        title: language.t("settings.backup.toast.runFailed"),
        description: result.message ?? language.t("common.requestFailed"),
      })
    })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.backup.title")}</h2>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.backup.status.title")}</h3>
          <Show
            when={status()}
            fallback={
              <div class="settings-v2-backup-status-fallback">
                <Show
                  when={controller.state.statusError}
                  fallback={<span>{language.t("common.loading")}</span>}
                >
                  {(message) => (
                    <>
                      <span>{language.t("settings.backup.error.status", { message: message() })}</span>
                      <ButtonV2 size="small" variant="outline" onClick={() => void controller.reloadStatus()}>
                        {language.t("settings.backup.snapshots.retry")}
                      </ButtonV2>
                    </>
                  )}
                </Show>
              </div>
            }
          >
            {(current) => (
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.backup.status.state")}
                  description={[current().server, current().username].filter(Boolean).join(" · ")}
                >
                  <div class="settings-v2-backup-tags">
                    <Tag>
                      {current().configured
                        ? language.t("settings.backup.status.configured")
                        : language.t("settings.backup.status.notConfigured")}
                    </Tag>
                    <Tag>
                      {current().enabled
                        ? language.t("settings.backup.status.enabled")
                        : language.t("settings.backup.status.disabled")}
                    </Tag>
                    <Show when={current().running}>
                      <Tag>{language.t("settings.backup.status.running")}</Tag>
                    </Show>
                  </div>
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.backup.status.lastSuccess")}
                  description={formatDate()(current().lastSuccessAt)}
                >
                  <Show when={current().lastSnapshotID}>
                    {(id) => <span class="settings-v2-backup-value">{id()}</span>}
                  </Show>
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.backup.status.size")}
                  description={language.t("settings.backup.status.uploaded")}
                >
                  <span class="settings-v2-backup-value settings-v2-backup-value--numeric">
                    {formatBytes()(current().lastLogicalBytes)}
                  </span>
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.backup.status.duration")}
                  description={language.t("settings.backup.status.schedule")}
                >
                  <div class="settings-v2-backup-tags">
                    <span class="settings-v2-backup-value settings-v2-backup-value--numeric">
                      {formatBytes()(current().lastUploadedBytes)}
                    </span>
                    <span class="settings-v2-backup-value settings-v2-backup-value--numeric">
                      {formatDuration()(current().lastDurationMs)}
                    </span>
                  </div>
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.backup.status.schedule")}
                  description={language.t("settings.backup.status.retentionDescription")}
                >
                  <div class="settings-v2-backup-tags">
                    <span class="settings-v2-backup-value">{current().schedule}</span>
                    <span class="settings-v2-backup-value settings-v2-backup-value--numeric">
                      {current().retention}
                    </span>
                  </div>
                </SettingsRowV2>
                <Show when={current().lastError}>
                  {(error) => (
                    <SettingsRowV2
                      title={language.t("settings.backup.status.lastError")}
                      description={language.t("settings.backup.status.lastErrorDescription")}
                    >
                      <span class="settings-v2-backup-error">{error()}</span>
                    </SettingsRowV2>
                  )}
                </Show>
              </SettingsListV2>
            )}
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.backup.form.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.backup.form.server")}
              description={language.t("settings.backup.form.serverDescription")}
            >
              <div class="settings-v2-backup-input">
                <TextInputV2
                  type="url"
                  value={controller.state.form.server}
                  placeholder={language.t("settings.backup.form.serverPlaceholder")}
                  aria-label={language.t("settings.backup.form.server")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  onInput={(event) => controller.setField("server", event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.backup.form.username")}
              description={language.t("settings.backup.form.usernameDescription")}
            >
              <div class="settings-v2-backup-input">
                <TextInputV2
                  type="text"
                  value={controller.state.form.username}
                  placeholder={language.t("settings.backup.form.usernamePlaceholder")}
                  aria-label={language.t("settings.backup.form.username")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  onInput={(event) => controller.setField("username", event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.backup.form.token")}
              description={language.t("settings.backup.form.tokenDescription")}
            >
              <div class="settings-v2-backup-input">
                <TextInputV2
                  type="password"
                  value={controller.state.form.token}
                  placeholder={
                    status()?.tokenConfigured
                      ? language.t("settings.backup.form.tokenConfigured")
                      : language.t("settings.backup.form.tokenPlaceholder")
                  }
                  aria-label={language.t("settings.backup.form.token")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  onInput={(event) => controller.setField("token", event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.backup.form.schedule")}
              description={language.t("settings.backup.form.scheduleDescription")}
            >
              <div class="settings-v2-backup-input">
                <TextInputV2
                  type="text"
                  value={controller.state.form.schedule}
                  placeholder={language.t("settings.backup.form.schedulePlaceholder")}
                  aria-label={language.t("settings.backup.form.schedule")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  onInput={(event) => controller.setField("schedule", event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.backup.form.enabled")}
              description={language.t("settings.backup.form.enabledDescription")}
            >
              <Switch
                checked={controller.state.form.enabled}
                onChange={(value) => controller.setField("enabled", value)}
              />
            </SettingsRowV2>
          </SettingsListV2>
          <div class="settings-v2-backup-actions">
            <ButtonV2
              size="normal"
              variant="contrast"
              disabled={controller.state.saving}
              onClick={save}
            >
              {controller.state.saving ? language.t("common.saving") : language.t("common.save")}
            </ButtonV2>
            <ButtonV2
              size="normal"
              variant="outline"
              disabled={!controller.canRun()}
              onClick={run}
            >
              {controller.state.running
                ? language.t("settings.backup.form.running")
                : language.t("settings.backup.form.run")}
            </ButtonV2>
          </div>
          <Show when={status() ? controller.state.statusError : undefined}>
            {(message) => (
              <p class="settings-v2-backup-error">
                {language.t("settings.backup.error.status", { message: message() })}
              </p>
            )}
          </Show>
        </div>

        <div class="settings-v2-section">
          <div class="settings-v2-backup-section-header">
            <h3 class="settings-v2-section-title">{language.t("settings.backup.snapshots.title")}</h3>
            <ButtonV2
              size="small"
              variant="ghost-muted"
              disabled={controller.state.loadingSnapshots || !status()?.configured}
              onClick={() => void controller.reloadSnapshots()}
            >
              {language.t("settings.backup.snapshots.refresh")}
            </ButtonV2>
          </div>
          <Show
            when={status()?.configured}
            fallback={<p class="settings-v2-backup-empty">{language.t("settings.backup.snapshots.unavailable")}</p>}
          >
            <Show
              when={!controller.state.snapshotsError}
              fallback={
                <div class="settings-v2-backup-status-fallback">
                  <span>
                    {language.t("settings.backup.error.snapshots", {
                      message: controller.state.snapshotsError ?? language.t("common.requestFailed"),
                    })}
                  </span>
                  <ButtonV2 size="small" variant="outline" onClick={() => void controller.reloadSnapshots()}>
                    {language.t("settings.backup.snapshots.retry")}
                  </ButtonV2>
                </div>
              }
            >
              <Show
                when={controller.state.snapshots.length > 0}
                fallback={
                  <p class="settings-v2-backup-empty">
                    {controller.state.loadingSnapshots
                      ? language.t("common.loading")
                      : language.t("settings.backup.snapshots.empty")}
                  </p>
                }
              >
                <div class="settings-v2-backup-snapshots">
                  <For each={controller.state.snapshots}>
                    {(snapshot) => (
                      <div class="settings-v2-backup-snapshot">
                        <div class="settings-v2-backup-snapshot-main">
                          <span class="settings-v2-backup-value">{snapshot.id}</span>
                          <span class="settings-v2-backup-snapshot-meta">
                            {formatDate()(snapshot.createdAt)}
                          </span>
                        </div>
                        <div class="settings-v2-backup-snapshot-meta settings-v2-backup-tags">
                          <span class="settings-v2-backup-value settings-v2-backup-value--numeric">
                            {formatBytes()(snapshot.totalBytes)}
                          </span>
                          <span>
                            {language.t("settings.backup.snapshots.fileCount", {
                              count: snapshot.fileCount ?? 0,
                            })}
                          </span>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.backup.security.title")}</h3>
          <p class="settings-v2-backup-security">{language.t("settings.backup.security.description")}</p>
        </div>
      </div>
    </>
  )
}