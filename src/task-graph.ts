/**
 * Tanren — TaskGraph
 *
 * Dependency tracking and parallel execution for actions within a tick.
 * Topological sort + Promise.all for independent tasks.
 *
 * Design: minimal coordination layer — no complex scheduler, no persistence.
 * Actions define deps, TaskGraph figures out execution order.
 */

export interface Task<T = unknown> {
  id: string
  deps: string[]
  fn: () => Promise<T>
}

export interface TaskResult<T = unknown> {
  id: string
  result?: T
  error?: string
  durationMs: number
}

export function createTaskGraph() {
  const tasks = new Map<string, Task>()

  return {
    /** Add a task with optional dependencies */
    add<T>(id: string, deps: string[], fn: () => Promise<T>): void {
      tasks.set(id, { id, deps, fn })
    },

    /** Execute all tasks respecting dependencies. Returns results map. */
    async execute(): Promise<Map<string, TaskResult>> {
      const results = new Map<string, TaskResult>()
      const completed = new Set<string>()
      const remaining = new Map(tasks)

      while (remaining.size > 0) {
        // Find tasks whose deps are all completed
        const ready: Task[] = []
        for (const [id, task] of remaining) {
          if (task.deps.every(d => completed.has(d))) {
            ready.push(task)
          }
        }

        if (ready.length === 0 && remaining.size > 0) {
          // Circular dependency or missing dep — execute remaining sequentially
          for (const [, task] of remaining) {
            ready.push(task)
          }
        }

        // Execute ready tasks in parallel
        const promises = ready.map(async (task) => {
          const start = Date.now()
          try {
            const result = await task.fn()
            return { id: task.id, result, durationMs: Date.now() - start } as TaskResult
          } catch (err) {
            return {
              id: task.id,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - start,
            } as TaskResult
          }
        })

        const batchResults = await Promise.all(promises)
        for (const r of batchResults) {
          results.set(r.id, r)
          completed.add(r.id)
          remaining.delete(r.id)
        }
      }

      return results
    },

    /** Get count of tasks */
    size(): number {
      return tasks.size
    },

    /** Clear all tasks */
    clear(): void {
      tasks.clear()
    },
  }
}

export type TaskGraph = ReturnType<typeof createTaskGraph>
