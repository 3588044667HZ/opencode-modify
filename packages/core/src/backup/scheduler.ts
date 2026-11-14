export * as BackupScheduler from "./scheduler"

import { Cause, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Backup } from "./backup"
import { BackupCron } from "./cron"
import { BackupStatus } from "./status"

export { cronMatches, isDue, parseCron, previousOccurrence } from "./cron"
export type { CronSpec } from "./cron"

const tick = Effect.fnUntraced(function* (backup: Backup.Interface) {
  const settings = yield* backup.settings()
  if (!settings.enabled) return
  const ready = yield* backup.ready()
  if (!ready) return

  const cron = BackupCron.parseCron(settings.schedule)
  const status = yield* backup.status()
  if (!BackupCron.isDue(cron, new Date(), status.lastRunAt, status.lastSuccessAt)) return

  yield* backup.run({ waitForLock: false, trigger: "schedule" })
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const backup = yield* Backup.Service
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* tick(backup).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("backup scheduler tick failed", {
                message: BackupStatus.sanitizeError(Cause.squash(cause)),
              }),
            ),
          )
          yield* Effect.sleep("60 seconds")
        }
      }),
    )
  }),
)

export const node = makeGlobalNode({
  name: "backup-scheduler",
  layer,
  deps: [Backup.node],
})