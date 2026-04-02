/**
 * Tanren — Metacognitive Perception Layer (MPL)
 *
 * Akari's design: let the agent see its own thinking.
 * 4 deterministic perception components + 1 cognitive action.
 *
 * Components:
 * 1. <last-tick>      — action results from previous tick (safety net)
 * 2. <state-diff>     — actual file changes (ground truth)
 * 3. <harness-manifest> — framework configuration (prevent false assumptions)
 * 4. <anomalies>      — early warning for staleness, failures, inconsistencies
 * 5. action:reflect   — agent writes its own cognitive residue
 *
 * "框架已經有數據，只是沒有流到 perception 裡。
 *  MPL = 把已有的數據正確地路由。"
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { PerceptionPlugin, ActionHandler, TickResult } from './types.js'

// === Types ===

interface ActionRecord {
  type: string
  target?: string
  result: 'success' | 'failure'
  detail?: string
}

interface StateSnapshot {
  files: Record<string, number>  // path → mtime ms
}

interface MPLState {
  lastTick: {
    tick: number
    duration: number
    quality: number
    actions: ActionRecord[]
    gatesTriggered: string[]
  } | null
  preTickSnapshot: StateSnapshot | null
}

// === State Snapshot ===

function snapshotDir(dir: string, base: string): Record<string, number> {
  const result: Record<string, number> = {}
  if (!existsSync(dir)) return result

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isFile()) {
        try {
          result[relative(base, fullPath)] = statSync(fullPath).mtimeMs
        } catch { /* skip unreadable */ }
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'journal') {
        // Recurse into subdirs but skip journal (too large) and hidden dirs
        Object.assign(result, snapshotDir(fullPath, base))
      }
    }
  } catch { /* skip unreadable dirs */ }

  return result
}

function computeStateDiff(before: StateSnapshot | null, after: StateSnapshot): string[] {
  if (!before) return []

  const lines: string[] = []
  const allPaths = new Set([...Object.keys(before.files), ...Object.keys(after.files)])

  for (const path of [...allPaths].sort()) {
    const bTime = before.files[path]
    const aTime = after.files[path]

    if (!bTime && aTime) {
      lines.push(`  + ${path} (new)`)
    } else if (bTime && !aTime) {
      lines.push(`  - ${path} (deleted)`)
    } else if (bTime && aTime && aTime > bTime) {
      lines.push(`  ~ ${path} (modified)`)
    }
    // unchanged files not listed — reduce noise
  }

  return lines
}

// === Anomaly Detection ===

interface Anomaly {
  severity: 'warn' | 'error'
  message: string
}

function detectAnomalies(
  memoryDir: string,
  currentTick: number,
  lastTickActions: ActionRecord[],
  stateDiffLines: string[],
): Anomaly[] {
  const anomalies: Anomaly[] = []

  // 1. State staleness: check working-memory.json
  const wmPath = join(memoryDir, 'state', 'working-memory.json')
  if (existsSync(wmPath)) {
    try {
      const wm = JSON.parse(readFileSync(wmPath, 'utf-8'))
      if (wm.lastUpdated && currentTick - wm.lastUpdated > 5) {
        anomalies.push({
          severity: 'warn',
          message: `working-memory.json stale: lastUpdated=${wm.lastUpdated}, current tick=${currentTick}`,
        })
      }
    } catch { /* skip corrupt */ }
  }

  // 2. Action said success but state didn't change
  const writeActions = lastTickActions.filter(a => a.type === 'write' && a.result === 'success')
  if (writeActions.length > 0 && stateDiffLines.length === 0) {
    anomalies.push({
      severity: 'warn',
      message: `write action reported success but no files changed — possible silent failure`,
    })
  }

  const focusActions = lastTickActions.filter(a => a.type === 'focus' && a.result === 'success')
  if (focusActions.length > 0 && !stateDiffLines.some(l => l.includes('working-memory'))) {
    anomalies.push({
      severity: 'warn',
      message: `focus action reported success but working-memory.json unchanged`,
    })
  }

  // 3. Action health — check for repeated failures
  const ahPath = join(memoryDir, 'state', 'action-health.json')
  if (existsSync(ahPath)) {
    try {
      const ah = JSON.parse(readFileSync(ahPath, 'utf-8'))
      for (const [type, rec] of Object.entries(ah.actions || {}) as [string, { failure: number; lastResult: string; lastError?: string }][]) {
        if (rec.failure >= 3 && rec.lastResult === 'failure') {
          anomalies.push({
            severity: 'error',
            message: `${type}: ${rec.failure} failures, last error: ${rec.lastError ?? 'unknown'}`,
          })
        }
      }
    } catch { /* skip corrupt */ }
  }

  // 4. Crystallization patterns detected but not acted on
  const crystPath = join(memoryDir, 'state', 'crystallization.json')
  if (existsSync(crystPath)) {
    try {
      const cryst = JSON.parse(readFileSync(crystPath, 'utf-8'))
      const crystallized = (cryst.patterns || []).filter((p: { crystallized?: boolean }) => p.crystallized)
      if (crystallized.length > 0) {
        anomalies.push({
          severity: 'warn',
          message: `${crystallized.length} crystallized pattern(s) detected but no gate installed`,
        })
      }
    } catch { /* skip corrupt */ }
  }

  return anomalies
}

// === MPL System ===

export function createMPL(memoryDir: string, config: {
  actions: () => string[]
  plugins: () => string[]
  gates: () => string[]
  feedbackRounds: () => number
  tickMode: () => string
  learning: () => Record<string, boolean>
  llmModel: () => string
  maxTokens: () => number
}) {
  const statePath = join(memoryDir, 'state')
  const reflectionPath = join(statePath, 'last-reflection.md')
  const lastTickPath = join(statePath, 'last-tick-actions.json')
  const stateDiffPath = join(statePath, 'last-state-diff.json')

  const state: MPLState = {
    lastTick: null,
    preTickSnapshot: null,
  }

  return {
    /** Call BEFORE tick starts — snapshot state for diff */
    preTick(): void {
      state.preTickSnapshot = { files: snapshotDir(memoryDir, memoryDir) }
    },

    /** Call AFTER tick completes — serialize results for next tick's perception */
    postTick(tickResult: TickResult, tickCount: number): void {
      // Serialize action results
      const actions: ActionRecord[] = tickResult.actions.map(a => ({
        type: a.type,
        target: (a.input?.path ?? a.input?.topic ?? a.input?.query ?? '') as string || undefined,
        result: 'success' as const,  // if it's in actions, it was executed
      }))

      // Check environment feedback for failures
      const feedback = tickResult.observation.environmentFeedback ?? ''
      if (feedback) {
        const failedMatches = feedback.match(/\[action (\w+) failed: ([^\]]+)\]/g)
        if (failedMatches) {
          for (const m of failedMatches) {
            const parts = m.match(/\[action (\w+) failed: ([^\]]+)\]/)
            if (parts) {
              const existing = actions.find(a => a.type === parts[1])
              if (existing) {
                existing.result = 'failure'
                existing.detail = parts[2]
              }
            }
          }
        }
      }

      state.lastTick = {
        tick: tickCount,
        duration: tickResult.observation.duration,
        quality: tickResult.observation.outputQuality,
        actions,
        gatesTriggered: tickResult.gateResults
          .filter(g => g.action !== 'pass')
          .map(g => `${(g as { name?: string }).name ?? 'gate'}: ${g.message ?? g.action}`),
      }

      // Write for persistence across process restarts
      try {
        writeFileSync(lastTickPath, JSON.stringify(state.lastTick, null, 2), 'utf-8')
      } catch { /* fire-and-forget */ }

      // Compute and persist state diff
      const postSnapshot: StateSnapshot = { files: snapshotDir(memoryDir, memoryDir) }
      const diffLines = computeStateDiff(state.preTickSnapshot, postSnapshot)
      try {
        writeFileSync(stateDiffPath, JSON.stringify({ tick: tickCount, changes: diffLines }, null, 2), 'utf-8')
      } catch { /* fire-and-forget */ }
    },

    /** Perception plugins — register all 4 deterministic components */
    getPerceptionPlugins(): PerceptionPlugin[] {
      return [
        // 1. Last tick action results
        {
          name: 'last-tick',
          category: 'self-awareness',
          fn: () => {
            // Try in-memory first, fall back to file
            const data = state.lastTick ?? (existsSync(lastTickPath)
              ? (() => { try { return JSON.parse(readFileSync(lastTickPath, 'utf-8')) } catch { return null } })()
              : null)
            if (!data) return ''

            const lines = [`<last-tick number="${data.tick}" duration="${Math.round(data.duration / 1000)}s" quality="${data.quality}/5">`]
            if (data.actions.length === 0) {
              lines.push('  (no actions executed)')
            }
            for (const a of data.actions) {
              const target = a.target ? ` → ${a.target}` : ''
              const detail = a.detail ? ` (${a.detail})` : ''
              lines.push(`  ${a.result === 'success' ? '✓' : '✗'} ${a.type}${target}${detail}`)
            }
            if (data.gatesTriggered.length > 0) {
              lines.push(`  gates: ${data.gatesTriggered.join(', ')}`)
            }
            lines.push('</last-tick>')
            return lines.join('\n')
          },
        },

        // 2. State diff (ground truth)
        {
          name: 'state-diff',
          category: 'self-awareness',
          fn: () => {
            if (!existsSync(stateDiffPath)) return ''
            try {
              const data = JSON.parse(readFileSync(stateDiffPath, 'utf-8'))
              if (!data.changes || data.changes.length === 0) return ''
              return `<state-diff since="tick-${data.tick}">\n${data.changes.join('\n')}\n</state-diff>`
            } catch { return '' }
          },
        },

        // 3. Harness manifest
        {
          name: 'harness-manifest',
          category: 'self-awareness',
          fn: () => {
            const lines = ['<harness-manifest>']
            lines.push(`  actions: [${config.actions().join(', ')}]`)
            lines.push(`  perception-plugins: [${config.plugins().join(', ')}]`)
            const gates = config.gates()
            lines.push(`  gates: ${gates.length > 0 ? gates.join(', ') : '(none configured)'}`)
            lines.push(`  feedbackRounds: ${config.feedbackRounds()}`)
            lines.push(`  tickMode: ${config.tickMode()}`)
            const learning = config.learning()
            lines.push(`  learning: ${Object.entries(learning).map(([k, v]) => `${k}=${v}`).join(', ')}`)
            lines.push(`  llm: ${config.llmModel()} / ${config.maxTokens()} tokens`)
            lines.push('</harness-manifest>')
            return lines.join('\n')
          },
        },

        // 4. Anomalies
        {
          name: 'anomalies',
          category: 'self-awareness',
          fn: () => {
            const lastActions = state.lastTick?.actions ?? []
            const diffData = existsSync(stateDiffPath)
              ? (() => { try { return JSON.parse(readFileSync(stateDiffPath, 'utf-8')).changes ?? [] } catch { return [] } })()
              : []
            const currentTick = (state.lastTick?.tick ?? 0) + 1

            const anomalies = detectAnomalies(memoryDir, currentTick, lastActions, diffData)
            if (anomalies.length === 0) return ''

            const lines = ['<anomalies>']
            for (const a of anomalies) {
              lines.push(`  ${a.severity === 'error' ? '🔴' : '⚠️'} ${a.message}`)
            }
            lines.push('</anomalies>')
            return lines.join('\n')
          },
        },

        // 5. Last reflection (cognitive residue from previous tick)
        {
          name: 'last-reflection',
          category: 'self-awareness',
          fn: () => {
            if (!existsSync(reflectionPath)) return ''
            try {
              const content = readFileSync(reflectionPath, 'utf-8').trim()
              if (!content) return ''
              // Extract tick number from first line if present
              const tickMatch = content.match(/^tick:\s*(\d+)/m)
              const tickAttr = tickMatch ? ` tick="${tickMatch[1]}"` : ''
              return `<last-reflection${tickAttr}>\n${content}\n</last-reflection>`
            } catch { return '' }
          },
        },
      ]
    },

    /** The reflect action — agent writes cognitive residue */
    getReflectAction(): ActionHandler {
      return {
        type: 'reflect',
        description: 'Write a reflection for your future self. Stored and injected into next tick\'s perception. Use to carry forward: current focus, key findings, unresolved questions, next steps.',
        toolSchema: {
          properties: {
            content: { type: 'string', description: 'Your reflection — what should next-tick-you know?' },
          },
          required: ['content'],
        },
        async execute(action, context) {
          const text = (action.input?.content as string) ?? action.content
          const tickLine = context.tickCount ? `tick: ${context.tickCount}\n` : ''
          writeFileSync(reflectionPath, tickLine + text, 'utf-8')
          return 'Reflection saved for next tick.'
        },
      }
    },
  }
}
