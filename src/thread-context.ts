/**
 * Tanren — ThreadContext
 *
 * Isolated context per reasoning thread within a tick.
 * Prevents context bleeding between parallel tasks.
 * Merge results when threads complete.
 *
 * Design: just a Map wrapper — no persistence, no complex state.
 */

export interface ThreadContext {
  id: string
  /** Set a value in this thread's context */
  set(key: string, value: unknown): void
  /** Get a value from this thread's context */
  get(key: string): unknown
  /** Get all entries */
  entries(): Array<[string, unknown]>
  /** Fork a child thread (inherits parent's context as snapshot) */
  fork(childId: string): ThreadContext
  /** Merge another thread's results into this one */
  merge(other: ThreadContext, strategy?: 'overwrite' | 'append'): void
  /** Get summary for perception injection */
  toSummary(): string
}

export function createThreadContext(id: string, initial?: Map<string, unknown>): ThreadContext {
  const data = new Map<string, unknown>(initial)

  const ctx: ThreadContext = {
    id,

    set(key: string, value: unknown): void {
      data.set(key, value)
    },

    get(key: string): unknown {
      return data.get(key)
    },

    entries(): Array<[string, unknown]> {
      return [...data.entries()]
    },

    fork(childId: string): ThreadContext {
      // Snapshot: child gets a copy of current state
      return createThreadContext(childId, new Map(data))
    },

    merge(other: ThreadContext, strategy: 'overwrite' | 'append' = 'append'): void {
      for (const [key, value] of other.entries()) {
        if (strategy === 'overwrite' || !data.has(key)) {
          data.set(key, value)
        } else {
          // Append: combine arrays or concatenate strings
          const existing = data.get(key)
          if (Array.isArray(existing) && Array.isArray(value)) {
            data.set(key, [...existing, ...value])
          } else if (typeof existing === 'string' && typeof value === 'string') {
            data.set(key, `${existing}\n${value}`)
          } else {
            // Different types — overwrite
            data.set(key, value)
          }
        }
      }
    },

    toSummary(): string {
      if (data.size === 0) return ''
      const lines = [`Thread: ${id}`]
      for (const [key, value] of data) {
        const preview = typeof value === 'string'
          ? value.slice(0, 100)
          : JSON.stringify(value).slice(0, 100)
        lines.push(`  ${key}: ${preview}`)
      }
      return lines.join('\n')
    },
  }

  return ctx
}
