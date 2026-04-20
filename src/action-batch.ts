/**
 * Tanren — ActionBatch
 *
 * Groups actions for intelligent execution: read-only in parallel,
 * write in sequence, with dependency tracking and thread isolation.
 *
 * Replaces the raw for-loop in loop.ts with a coordination layer.
 * Existing actions work unchanged — this is additive.
 */

import { createTaskGraph, type TaskResult } from './task-graph.js'
import { createThreadContext, type ThreadContext } from './thread-context.js'
import type { Action, ActionContext } from './types.js'

// Read-only actions that can safely run in parallel
const READ_ONLY = new Set(['search', 'read', 'explore', 'grep', 'query-history', 'web_fetch', 'web_search', 'delegate'])

export interface BatchResult {
  results: string[]                    // action results in original order
  executed: number
  failed: number
  parallelGroups: number               // how many parallel batches ran
  totalDurationMs: number
  threadContext: ThreadContext          // merged context from all threads
}

export interface ActionExecutor {
  execute(action: Action, context: ActionContext): Promise<string>
}

/**
 * Execute a batch of actions with automatic parallelization.
 *
 * Strategy:
 * 1. Group consecutive read-only actions → parallel
 * 2. Write actions → sequential (order matters)
 * 3. Mixed: parallel reads first, then sequential writes
 * 4. Each parallel group gets its own ThreadContext, merged after
 */
export async function executeBatch(
  actions: Action[],
  executor: ActionExecutor,
  actionContext: ActionContext,
  onProgress?: (event: { phase: 'start' | 'done' | 'error'; action: Action; result?: string; error?: string }) => void,
): Promise<BatchResult> {
  const start = Date.now()
  const results: string[] = new Array(actions.length).fill('')
  let executed = 0
  let failed = 0
  let parallelGroups = 0
  const mainThread = createThreadContext('main')

  // Split into execution groups: consecutive read-only actions form parallel groups
  const groups: Array<{ actions: Array<{ action: Action; index: number }>; parallel: boolean }> = []
  let currentGroup: Array<{ action: Action; index: number }> = []
  let currentIsReadOnly = false

  for (let i = 0; i < actions.length; i++) {
    const isRO = READ_ONLY.has(actions[i].type)
    if (i === 0) {
      currentIsReadOnly = isRO
      currentGroup.push({ action: actions[i], index: i })
    } else if (isRO === currentIsReadOnly) {
      currentGroup.push({ action: actions[i], index: i })
    } else {
      groups.push({ actions: currentGroup, parallel: currentIsReadOnly })
      currentGroup = [{ action: actions[i], index: i }]
      currentIsReadOnly = isRO
    }
  }
  if (currentGroup.length > 0) {
    groups.push({ actions: currentGroup, parallel: currentIsReadOnly })
  }

  // Execute groups
  for (const group of groups) {
    if (group.parallel && group.actions.length > 1) {
      // Parallel execution via TaskGraph
      parallelGroups++
      const graph = createTaskGraph()

      for (const { action, index } of group.actions) {
        const thread = mainThread.fork(`action-${index}`)
        graph.add(`action-${index}`, [], async () => {
          onProgress?.({ phase: 'start', action })
          try {
            const result = await executor.execute(action, actionContext)
            thread.set('result', result)
            thread.set('action', action.type)
            // Detect soft errors: handler returned error string instead of throwing
            if (result.startsWith('[') && /^\[[\w_-]+ error:/.test(result)) {
              thread.set('error', result)
              onProgress?.({ phase: 'error', action, error: result.slice(0, 200) })
              throw new Error(result)
            }
            onProgress?.({ phase: 'done', action, result: result.slice(0, 200) })
            return { result, index }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            thread.set('error', msg)
            onProgress?.({ phase: 'error', action, error: msg })
            throw err
          }
        })
      }

      const taskResults = await graph.execute()
      for (const [, tr] of taskResults) {
        const typed = tr as TaskResult<{ result: string; index: number }>
        if (typed.error) {
          const item = group.actions.find(a => `action-${a.index}` === typed.id)
          results[item?.index ?? 0] = `[action ${item?.action.type} failed: ${typed.error}]`
          failed++
        } else if (typed.result) {
          results[typed.result.index] = typed.result.result
          executed++
        }
      }

      // Merge thread contexts
      for (const { index } of group.actions) {
        const thread = mainThread.fork(`action-${index}`)
        mainThread.merge(thread)
      }

    } else {
      // Sequential execution
      for (const { action, index } of group.actions) {
        onProgress?.({ phase: 'start', action })
        try {
          const result = await executor.execute(action, actionContext)
          results[index] = result
          // Detect soft errors: handler returned error string instead of throwing
          // Pattern matches Tanren's "[action_type error: ...]" format only, not JSON arrays
          if (result.startsWith('[') && /^\[[\w_-]+ error:/.test(result)) {
            failed++
            onProgress?.({ phase: 'error', action, error: result.slice(0, 200) })
          } else {
            executed++
            mainThread.set(`action-${index}`, result.slice(0, 200))
            onProgress?.({ phase: 'done', action, result: result.slice(0, 200) })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          results[index] = `[action ${action.type} failed: ${msg}]`
          failed++
          onProgress?.({ phase: 'error', action, error: msg })
        }
      }
    }
  }

  return {
    results,
    executed,
    failed,
    parallelGroups,
    totalDurationMs: Date.now() - start,
    threadContext: mainThread,
  }
}
