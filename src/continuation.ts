/**
 * Tanren — Self-Paced Continuation
 *
 * Agent decides when to continue. Framework asks, doesn't judge.
 * Gates verify honesty.
 *
 * Design:
 * - Agent writes `converged: yes/no` in reflect
 * - Framework reads it after tick
 * - If `no` + gates clean → trigger next tick
 * - If `yes` or gates warn → stop
 * - Hard cap as last resort
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

        // Look for explicit continuation signal
        const continueMatch = content.match(/continue:\s*(yes|true)/i)
        if (continueMatch) {
          const reasonMatch = content.match(/reason:\s*(.+)/i)
          return { converged: false, reason: reasonMatch?.[1]?.trim() ?? 'agent wants to continue' }
        }

        // No explicit signal — default to not converged (agent forgot to declare)
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
          .filter(h => h.actions.length === 0).length
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

          lines.push('  ⚡ Convergence check: is your task complete? Answer in reflect with "converged: yes/no" and reason.')
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
