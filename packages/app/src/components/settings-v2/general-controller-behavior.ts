import { createMemo, onCleanup, type Accessor } from "solid-js"

export type PermissionScopeApi = {
  isAutoAccepting: (sessionID: string, directory?: string) => boolean
  isAutoAcceptingDirectory: (directory: string) => boolean
  enableAutoAccept: (sessionID: string, directory: string) => void
  disableAutoAccept: (sessionID: string, directory?: string) => void
  toggleAutoAcceptDirectory: (directory: string) => void
}

export function createPermissionScopeState(input: {
  sessionID: Accessor<string | undefined>
  directory: Accessor<string | undefined>
  permission: PermissionScopeApi
}) {
  return {
    accepting: createMemo(() => {
      const directory = input.directory()
      if (!directory) return false
      const sessionID = input.sessionID()
      if (!sessionID) return input.permission.isAutoAcceptingDirectory(directory)
      return input.permission.isAutoAccepting(sessionID, directory)
    }),
    enabled: createMemo(() => !!input.directory()),
    set: (checked: boolean) => {
      const directory = input.directory()
      if (!directory) return
      const sessionID = input.sessionID()
      if (sessionID) {
        if (checked) input.permission.enableAutoAccept(sessionID, directory)
        else input.permission.disableAutoAccept(sessionID, directory)
        return
      }
      if (input.permission.isAutoAcceptingDirectory(directory) === checked) return
      input.permission.toggleAutoAcceptDirectory(directory)
    },
  }
}

export type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

export type ShellSelectOption = {
  id: string
  value: string
  name: string
  terminalOnly: boolean
}

export function createShellOptions(input: { shells: ShellOption[]; current: string | undefined }) {
  const counts = input.shells.reduce((result, shell) => {
    result.set(shell.name, (result.get(shell.name) ?? 0) + 1)
    return result
  }, new Map<string, number>())
  const options: ShellSelectOption[] = [
    { id: "auto", value: "", name: "", terminalOnly: false },
    ...input.shells.map((shell) => {
      const ambiguous = (counts.get(shell.name) ?? 0) > 1
      const name = ambiguous ? shell.path : shell.name
      return {
        id: shell.path,
        value: ambiguous ? shell.path : shell.name,
        name,
        terminalOnly: !shell.acceptable,
      }
    }),
  ]
  if (input.current && !options.some((option) => option.value === input.current)) {
    options.push({ id: input.current, value: input.current, name: input.current, terminalOnly: false })
  }
  return options
}

export function createSoundPreviewController(player: (id: string | undefined) => Promise<(() => void) | undefined>) {
  let cleanup: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let run = 0

  const stop = () => {
    run += 1
    cleanup?.()
    clearTimeout(timeout)
    cleanup = undefined
    timeout = undefined
  }
  const play = (id: string | undefined) => {
    stop()
    if (!id) return
    const current = ++run
    timeout = setTimeout(() => {
      timeout = undefined
      void player(id).then((next) => {
        if (run === current) {
          cleanup = next
          return
        }
        next?.()
      })
    }, 100)
  }

  onCleanup(stop)
  return { play, stop }
}
