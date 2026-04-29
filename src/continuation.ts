/**
 * Tanren — Self-Paced Continuation
 *
 * Agent decides when to stop. Framework continues by default.
 *
 * Design:
 * - Default: chain continues (agent has more work to do)
 * - Agent writes `converged: yes` in reflect → chain stops
 * - Gates warn/block → chain stops
 * - Hard cap (20 ticks) → chain stops (safety net)
 *
 * Convergence has exactly one source: agent's explicit declaration.
 * Framework never infers intent from action types.
 *
 * "框架是笨的但誠實的。智能屬於 agent。"
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PerceptionPlugin, TickResult } from './types.js'

const HARD_CAP = 20

export interface ChainState {
  active: boolean
  ticksInChain: number
  convergenceCondition: string
  chainHistory: Array<{
    tick: number
    actions: string[]
    actionsExecuted: number
    converged: boolean
    reason: string
  }>
}

export function createContinuationSystem(memoryDir: string) {
  const reflectionPath = join(memoryDir, 'state', 'last-reflection.md')
  const chain: ChainState = {
    active: false,
    ticksInChain: 0,
    convergenceCondition: '',
    chainHistory: [],
  }

  return {
    /** Start a new chain */
    startChain(): void {
      chain.active = true
      chain.ticksInChain = 0
      chain.convergenceCondition = ''
      chain.chainHistory = []
    },

    /** Record tick result in chain */
    recordTick(tickResult: TickResult, tickCount: number): void {
      chain.ticksInChain++
      const { converged, reason } = this.readConvergence()
      chain.chainHistory.push({
        tick: tickCount,
        actions: tickResult.actions.map(a => a.type),
        actionsExecuted: tickResult.observation.actionsExecuted,
        converged,
        reason,
      })

      // Extract convergence condition from focus if first tick
      if (chain.ticksInChain === 1) {
        const wmPath = join(memoryDir, 'state', 'working-memory.json')
        if (existsSync(wmPath)) {
          try {
            const wm = JSON.parse(readFileSync(wmPath, 'utf-8'))
            chain.convergenceCondition = wm.currentFocus ?? ''
          } catch { /* ignore */ }
        }
      }
    },

    /** Read convergence status from last reflection */
    readConvergence(): { converged: boolean; reason: string } {
      if (!existsSync(reflectionPath)) {
        return { converged: false, reason: 'no reflection written' }
      }

      try {
        const content = readFileSync(reflectionPath, 'utf-8')

        // Look for explicit convergence signal
        const convergedMatch = content.match(/converged:\s*(yes|true|done|完成)/i)
        if (convergedMatch) {
          const reasonMatch = content.match(/reason:\s*(.+)/i)
          return { converged: true, reason: reasonMatch?.[1]?.trim() ?? 'agent declared converged' }
        }

        // No explicit convergence signal — default to not converged
        return { converged: false, reason: 'no explicit convergence signal in reflection' }
      } catch {
        return { converged: false, reason: 'reflection unreadable' }
      }
    },

    /** Should the chain continue? Returns false if should stop. */
    shouldContinue(tickResult: TickResult): { continue: boolean; reason: string } {
      if (!chain.active) {
        return { continue: false, reason: 'no active chain' }
      }

      // Hard cap
      if (chain.ticksInChain >= HARD_CAP) {
        chain.active = false
        return { continue: false, reason: `hard cap reached (${HARD_CAP} ticks)` }
      }

      // Agent said converged
      const { converged, reason } = this.readConvergence()
      if (converged) {
        chain.active = false
        return { continue: false, reason: `converged: ${reason}` }
      }

      // Gate violations — any warn or block = stop chain
      const gateIssues = tickResult.gateResults.filter(g => g.action !== 'pass')
      if (gateIssues.length > 0) {
        chain.active = false
        const msgs = gateIssues.map(g => g.message ?? g.action).join(', ')
        return { continue: false, reason: `gate violation: ${msgs}` }
      }

      // No actions executed = empty tick
      if (tickResult.observation.actionsExecuted === 0) {
        // Allow 1 empty tick (thinking), but 2 = stop
        const recentEmpty = chain.chainHistory
          .slice(-2)
          .filter(h => h.actionsExecuted === 0).length
        if (recentEmpty >= 2) {
          chain.active = false
          return { continue: false, reason: '2 consecutive empty ticks' }
        }
      }

      return { continue: true, reason }
    },

    /** Perception plugin — chain context injection */
    getChainPerception(): PerceptionPlugin {
      return {
        name: 'chain-context',
        category: 'self-awareness',
        fn: () => {
          if (!chain.active || chain.ticksInChain === 0) return ''

          const lines = [`<chain tick="${chain.ticksInChain}" cap="${HARD_CAP}">`]

          if (chain.convergenceCondition) {
            lines.push(`  convergence: ${chain.convergenceCondition}`)
          }

          // Brief history
          if (chain.chainHistory.length > 0) {
            lines.push('  history:')
            for (const h of chain.chainHistory.slice(-5)) {
              const acts = h.actions.length > 0 ? h.actions.join(', ') : '(empty)'
              lines.push(`    tick ${h.tick}: ${acts}`)
            }
          }

          // Detect "respond drift": agent has chained multiple ticks but the last
          // respond action is stale (wrote early with intentions, never rewrote
          // with results). This reminder targets that specific failure mode.
          const ticksWithRespond = chain.chainHistory.filter(h => h.actions.includes('respond')).length
          const ticksWithRealWork = chain.chainHistory.filter(h =>
            h.actions.some(a => !['respond', 'focus', 'reflect', 'clear-inbox', 'remember'].includes(a))
          ).length
          if (chain.ticksInChain >= 2 && ticksWithRealWork > 0 && ticksWithRespond > 0) {
            lines.push('  ⚠ You have written `respond` in an earlier tick AND done real work since.')
            lines.push('    If that earlier respond was an intention ("I will do X"), it is now STALE.')
            lines.push('    Write a NEW `respond` with ACTUAL RESULTS — what you did, what you found.')
            lines.push('    Later `respond` overwrites earlier ones in the chain aggregation.')
          }

          lines.push(`  ⚡ CONVERGENCE: You MUST write "converged: yes" in your reflect action when your task is complete.`)
          lines.push(`     If you do NOT write this, the chain continues automatically (up to cap=${HARD_CAP}).`)
          lines.push('     When converged, ensure your LAST action is `respond` with final results (not intentions).')
          lines.push('</chain>')
          return lines.join('\n')
        },
      }
    },

    /** Get current chain state */
    getState(): ChainState {
      return { ...chain }
    },

    /** End chain manually */
    endChain(): void {
      chain.active = false
    },
  }
}
