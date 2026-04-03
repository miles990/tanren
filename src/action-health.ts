/**
 * Tanren — Action Health Tracker
 *
 * Tracks per-action success/failure rates across ticks.
 * Injects health status into perception so the agent has
 * deterministic data about what works, not hallucinated narratives.
 *
 * Constraint Texture: action health is a deterministic fact → code tracks it.
 * Agent should not learn "write doesn't work" from narrative memory —
 * it should see "write: 3/3 success in last 5 ticks" from the framework.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PerceptionPlugin } from './types.js'

interface ActionRecord {
  type: string
  success: number
  failure: number
  lastResult: 'success' | 'failure'
  lastTick: number
  lastError?: string
}

interface HealthState {
  actions: Record<string, ActionRecord>
  tick: number
}

export function createActionHealthTracker(stateDir: string) {
  const statePath = join(stateDir, 'action-health.json')

  function load(): HealthState {
    try {
      if (existsSync(statePath)) {
        return JSON.parse(readFileSync(statePath, 'utf-8'))
      }
    } catch { /* corrupt file — start fresh */ }
    return { actions: {}, tick: 0 }
  }

  function save(state: HealthState): void {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch { /* fire-and-forget */ }
  }

  const state = load()

  return {
    /** Record action outcome after execution */
    record(type: string, success: boolean, tick: number, error?: string): void {
      if (!state.actions[type]) {
        state.actions[type] = { type, success: 0, failure: 0, lastResult: 'success', lastTick: 0 }
      }
      const rec = state.actions[type]
      if (success) {
        rec.success++
        rec.lastResult = 'success'
        delete rec.lastError
      } else {
        rec.failure++
        rec.lastResult = 'failure'
        rec.lastError = error?.slice(0, 200)
      }
      rec.lastTick = tick
      state.tick = tick
      save(state)
    },

    /** Get perception section showing action health */
    getPerceptionPlugin(): PerceptionPlugin {
      return {
        name: 'action-health',
        category: 'system',
        fn: () => {
          const entries = Object.values(state.actions)
          if (entries.length === 0) return ''

          // Show ALL actions with their real status — agent needs truth, not filtered news
          const lines: string[] = ['<action-health>']

          for (const a of entries) {
            if (a.failure > 0 && a.lastResult === 'success') {
              lines.push(`  ${a.type}: ✅ RECOVERED — ${a.success} success, ${a.failure} failures total`)
            } else if (a.failure > 0 && a.lastResult === 'failure') {
              lines.push(`  ${a.type}: ❌ FAILING — ${a.failure} failures${a.lastError ? ': ' + a.lastError : ''}`)
            } else {
              lines.push(`  ${a.type}: ✅ ${a.success} success, 0 failures`)
            }
          }

          lines.push('</action-health>')
          return lines.join('\n')
        },
      }
    },

    /** Get raw state for external use */
    getState(): HealthState {
      return state
    },
  }
}
