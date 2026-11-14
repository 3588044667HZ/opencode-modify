export * as BackupCron from "./cron"

export interface CronSpec {
  readonly expression: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly weekdays: ReadonlySet<number>
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

const SEARCH_MINUTES = 366 * 24 * 60

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error("backup schedule must have five cron fields")
  const [minute, hour, day, month, weekday] = fields
  return {
    expression,
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    days: parseField(day, 1, 31),
    months: parseField(month, 1, 12),
    weekdays: normalizeWeekdays(parseField(weekday, 0, 7)),
    dayOfMonthRestricted: day !== "*",
    dayOfWeekRestricted: weekday !== "*",
  }
}

export function cronMatches(cron: CronSpec, date: Date) {
  if (!cron.minutes.has(date.getMinutes())) return false
  if (!cron.hours.has(date.getHours())) return false
  if (!cron.months.has(date.getMonth() + 1)) return false

  const dayOfMonth = cron.days.has(date.getDate())
  const dayOfWeek = cron.weekdays.has(date.getDay())
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return dayOfMonth || dayOfWeek
  return dayOfMonth && dayOfWeek
}

export function previousOccurrence(cron: CronSpec, now: Date) {
  const anchor = new Date(now)
  anchor.setSeconds(0, 0)
  for (let index = 0; index <= SEARCH_MINUTES; index++) {
    const candidate = new Date(anchor.getTime() - index * 60_000)
    if (cronMatches(cron, candidate)) return candidate
  }
  return undefined
}

export function isDue(cron: CronSpec, now: Date, lastRunAt?: string, lastSuccessAt?: string) {
  const latest = previousOccurrence(cron, now)
  if (!latest) return false
  if (!lastRunAt && !lastSuccessAt) return sameLocalDay(latest, now)
  const last = Math.max(timestamp(lastRunAt), timestamp(lastSuccessAt))
  return last < latest.getTime()
}

function sameLocalDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function timestamp(value?: string) {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function normalizeWeekdays(values: ReadonlySet<number>) {
  const result = new Set<number>()
  for (const value of values) result.add(value === 7 ? 0 : value)
  return result
}

function parseField(input: string, minimum: number, maximum: number) {
  const result = new Set<number>()
  if (!input) throw new Error(`invalid cron field: ${input}`)

  for (const part of input.split(",")) {
    if (!part) throw new Error(`invalid cron field: ${input}`)
    const [range, stepText] = part.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`)

    if (range === "*") {
      for (let value = minimum; value <= maximum; value += step) result.add(value)
      continue
    }

    if (range.includes("-")) {
      const bounds = range.split("-")
      if (bounds.length !== 2) throw new Error(`invalid cron range: ${part}`)
      const [startText, endText] = bounds
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`invalid cron range: ${part}`)
      if (start < minimum || end > maximum || start > end) throw new Error(`cron range out of bounds: ${part}`)
      for (let value = start; value <= end; value += step) result.add(value)
      continue
    }

    const value = Number(range)
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`cron value out of bounds: ${part}`)
    }
    if (stepText === undefined) {
      result.add(value)
      continue
    }
    for (let next = value; next <= maximum; next += step) result.add(next)
  }

  return result
}