type ProjectRef = { worktree: string }

// 会话列表按需加载：启动阶段不做全量预热，只在项目被打开或展开时为其根目录触发加载。
// 同一目录的并发请求在此合并；loadSessions 查询自身也会跳过进行中或已加载的目录。
export function createProjectSessionWarmup(input: {
  list: () => readonly ProjectRef[]
  rootFor: (directory: string) => string
  loadSessions: (directory: string) => Promise<void> | void
  openProject: (root: string) => void
  expandProject: (root: string) => void
}) {
  const inflight = new Set<string>()

  const load = (root: string) => {
    if (inflight.has(root)) return
    inflight.add(root)
    const settle = () => inflight.delete(root)
    void Promise.resolve(input.loadSessions(root)).then(settle, settle)
  }

  const exists = (root: string) => input.list().some((project) => project.worktree === root)

  return {
    open(directory: string) {
      const root = input.rootFor(directory)
      if (exists(root)) return
      load(root)
      input.openProject(root)
    },
    expand(directory: string) {
      const root = input.rootFor(directory)
      if (!exists(root)) return
      load(root)
      input.expandProject(root)
    },
  }
}
