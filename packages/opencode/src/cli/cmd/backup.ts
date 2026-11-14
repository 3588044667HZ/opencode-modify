import type { Argv } from "yargs"
import { Effect } from "effect"
import { Backup } from "@opencode-ai/core/backup/backup"
import { BackupRemote } from "@opencode-ai/core/backup/remote"
import { BackupScheduler } from "@opencode-ai/core/backup/scheduler"
import { BackupSettings } from "@opencode-ai/core/backup/settings"
import { Global } from "@opencode-ai/core/global"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { effectCmd, fail } from "../effect-cmd"

interface SetupArgs {
  server?: string
  username?: string
  token?: string
  passwordStdin?: boolean
  enable?: boolean
  disable?: boolean
  schedule?: string
}

const SetupCommand = effectCmd({
  command: "setup",
  describe: "configure the backup server and credentials",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("server", { type: "string", describe: "backup server base URL" })
      .option("username", { type: "string", describe: "backup server username" })
      .option("token", { type: "string", describe: "backup token (stored in the state directory)" })
      .option("password-stdin", {
        type: "boolean",
        describe: "read a password from stdin, validate it, and store it as the backup credential",
      })
      .option("enable", { type: "boolean", describe: "enable the daily backup scheduler" })
      .option("disable", { type: "boolean", describe: "disable the daily backup scheduler" })
      .option("schedule", { type: "string", describe: "five-field cron expression in local time" }),
  handler: Effect.fn("Cli.backup.setup")(function* (input: SetupArgs) {
    if (input.enable && input.disable) return yield* fail("--enable and --disable cannot be combined")
    if (input.token && input.passwordStdin) {
      return yield* fail("choose either --token or --password-stdin, not both")
    }

    const global = Global.make()
    const loaded = yield* Effect.tryPromise({
      try: () => BackupSettings.load({ configDirectory: global.config }),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => fail(message)))

    const server = input.server
      ? yield* Effect.try({ try: () => BackupSettings.normalizeServer(input.server!), catch: (cause) => message(cause) }).pipe(
          Effect.catch((text) => fail(text)),
        )
      : undefined
    const username = input.username
      ? yield* Effect.try({ try: () => BackupSettings.validateUsername(input.username!), catch: (cause) => message(cause) }).pipe(
          Effect.catch((text) => fail(text)),
        )
      : undefined
    if (input.schedule) {
      yield* Effect.try({ try: () => BackupScheduler.parseCron(input.schedule!), catch: (cause) => message(cause) }).pipe(
        Effect.catch((text) => fail(text)),
      )
    }

    const targetServer = server ?? loaded.settings.server
    const targetUsername = username ?? loaded.settings.username

    let password: string | undefined
    if (input.passwordStdin) {
      password = yield* Effect.promise(readStdin)
      if (!password) return yield* fail("--password-stdin received an empty password")
      if (!targetServer || !targetUsername) {
        return yield* fail("--server and --username are required to validate Basic credentials")
      }
      const connection = yield* Effect.try({
        try: () =>
          BackupSettings.resolveBasicConnection({
            server: targetServer,
            username: targetUsername,
            password: password!,
          }),
        catch: (cause) => message(cause),
      }).pipe(Effect.catch((text) => fail(text)))
      yield* Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const remote = BackupRemote.make(connection, http)
        yield* remote.listSnapshots()
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError((error) => error.message),
        Effect.catch((text) => fail(`Basic credential validation failed: ${text}`)),
      )
      console.log("Basic credentials verified.")
      console.log("The password will be stored as the backup credential.")
    }

    if ((input.token || input.passwordStdin) && (!targetServer || !targetUsername)) {
      return yield* fail("--server and --username are required when storing a credential")
    }
    const configure: Backup.ConfigureInput = {
      ...(input.enable ? { enabled: true } : {}),
      ...(input.disable ? { enabled: false } : {}),
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(server ? { server } : {}),
      ...(username ? { username } : {}),
      ...(input.token ? { server: targetServer!, username: targetUsername!, token: input.token } : {}),
      ...(password ? { server: targetServer!, username: targetUsername!, password } : {}),
    }

    const changed =
      configure.enabled !== undefined ||
      configure.schedule !== undefined ||
      configure.server !== undefined ||
      configure.username !== undefined ||
      configure.token !== undefined ||
      configure.password !== undefined
    if (changed) {
      const backup = yield* Backup.Service
      yield* backup.configure(configure).pipe(Effect.catch((error) => fail(error.message)))
      console.log("backup configuration updated")
      if (input.token) console.log(`backup token stored in ${BackupSettings.authFile(global.state)}`)
      if (password) console.log(`backup password stored in ${BackupSettings.authFile(global.state)}`)
      console.log("Use only one credential: a token or a password, not both.")
      console.log(
        "Note: snapshots include auth.json and mcp-auth.json in plaintext; protect the backup server and its storage.",
      )
    }

    if (!changed && !input.passwordStdin) {
      return yield* fail(
        "nothing to configure; pass --server/--username/--token, --enable/--disable, --schedule, or --password-stdin",
      )
    }
  }),
})

const RunCommand = effectCmd({
  command: "run",
  describe: "run a backup now",
  instance: false,
  handler: Effect.fn("Cli.backup.run")(function* () {
    const backup = yield* Backup.Service
    const result = yield* backup.run({ waitForLock: true }).pipe(Effect.catch((error) => fail(error.message)))
    if (result.skipped) {
      console.log(`backup skipped: ${result.reason ?? "already running"}`)
      return
    }
    console.log(`snapshot ${result.snapshotID}`)
    console.log(`files ${result.files ?? 0}; chunks ${result.chunks ?? 0}`)
    console.log(`logical ${result.logicalBytes ?? 0} bytes; uploaded ${result.uploadedBytes ?? 0} bytes`)
    console.log(`duration ${result.durationMs} ms`)
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show the last backup status",
  instance: false,
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", describe: "print JSON" }),
  handler: Effect.fn("Cli.backup.status")(function* (args: { json?: boolean }) {
    const backup = yield* Backup.Service
    const status = yield* backup.status()
    if (args.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    if (!status.lastRunAt) {
      console.log("No backup has run yet.")
      return
    }
    console.log(`running: ${status.running}`)
    console.log(`last run: ${status.lastRunAt}`)
    console.log(`last success: ${status.lastSuccessAt ?? "never"}`)
    console.log(`last snapshot: ${status.lastSnapshotID ?? "none"}`)
    console.log(`logical bytes: ${status.lastLogicalBytes ?? 0}`)
    console.log(`uploaded bytes: ${status.lastUploadedBytes ?? 0}`)
    console.log(`duration: ${status.lastDurationMs ?? 0} ms`)
    if (status.lastError) console.log(`last error: ${status.lastError}`)
  }),
})

const ListCommand = effectCmd({
  command: "list",
  describe: "list snapshots on the backup server",
  instance: false,
  handler: Effect.fn("Cli.backup.list")(function* () {
    const backup = yield* Backup.Service
    const snapshots = yield* backup.list().pipe(Effect.catch((error) => fail(error.message)))
    const settings = yield* backup.settings().pipe(Effect.catch((error) => fail(error.message)))
    console.log(`Server retention preference: ${settings.retention} snapshots`)
    if (!snapshots.length) {
      console.log("No snapshots found.")
      return
    }
    for (const snapshot of snapshots) {
      const files = snapshot.file_count ?? snapshot.files.length
      console.log(`${snapshot.id}  ${snapshot.created_at}  ${snapshot.total_bytes ?? 0}B  ${files} files`)
    }
  }),
})

const PullCommand = effectCmd({
  command: "pull [snapshotID]",
  describe: "download a snapshot into a directory for manual restore",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("snapshotID", { type: "string", describe: "snapshot id (default: newest)" })
      .option("out", { type: "string", demandOption: true, describe: "output directory" })
      .option("force", { type: "boolean", describe: "allow writing into a non-empty output directory" }),
  handler: Effect.fn("Cli.backup.pull")(function* (args: { snapshotID?: string; out: string; force?: boolean }) {
    const backup = yield* Backup.Service
    const result = yield* backup
      .pull({ snapshotID: args.snapshotID, out: args.out, force: args.force })
      .pipe(Effect.catch((error) => fail(error.message)))
    console.log(`snapshot ${result.snapshotID} downloaded to ${result.out}`)
    console.log(`files ${result.files}; logical ${result.totalBytes} bytes`)
    console.log("Restore is manual; run `opencode backup restore-plan --from " + result.out + "` for steps.")
  }),
})

const RestorePlanCommand = effectCmd({
  command: "restore-plan",
  describe: "print manual restore steps for a pulled snapshot",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("from", { type: "string", demandOption: true, describe: "directory created by backup pull" }),
  handler: Effect.fn("Cli.backup.restorePlan")(function* (args: { from: string }) {
    const backup = yield* Backup.Service
    const steps = yield* backup.restorePlan({ from: args.from }).pipe(Effect.catch((error) => fail(error.message)))
    for (const step of steps) console.log(step)
  }),
})

export const BackupCommand = effectCmd({
  command: "backup",
  describe: "back up and restore OpenCode data",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.command(SetupCommand).command(RunCommand).command(StatusCommand).command(ListCommand).command(PullCommand).command(RestorePlanCommand).demandCommand(),
  handler: Effect.fn("Cli.backup")(function* () {}),
})

async function readStdin() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
