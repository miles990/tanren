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

          // Only show actions with recent failures or mixed results
          const noteworthy = entries.filter(a =>
            a.failure > 0 || a.lastResult === 'failure'
          )
          // Also show recently recovered actions (was failing, now succeeding)
          const recovered = entries.filter(a =>
            a.failure > 0 && a.lastResult === 'success'
          )

          if (noteworthy.length === 0 && recovered.length === 0) return ''

          const lines: string[] = ['<action-health>']

          for (const a of recovered) {
            lines.push(`  ${a.type}: ✅ RECOVERED (was failing, now works) — ${a.success} success, ${a.failure} failures total`)
          }

          for (const a of noteworthy) {
            if (recovered.includes(a)) continue // already shown
            const rate = a.success + a.failure > 0
              ? Math.round(a.success / (a.success + a.failure) * 100)
              : 0
            const status = a.lastResult === 'failure'
              ? `❌ last failed${a.lastError ? ': ' + a.lastError : ''}`
              : `✅ last succeeded (${rate}% success rate)`
            lines.push(`  ${a.type}: ${status}`)
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
