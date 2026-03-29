/**
 * Tanren — Learning System
 *
 * The outer loop that wraps the action loop. Every action produces
 * observation, every observation feeds learning, learning crystallizes
 * into gates, gates shape the next action.
 *
 * Convergence Condition: Agent improves at tasks it repeatedly does.
 * Improvement is measurable by environment-anchored metrics (not
 * self-report). The learning system produces gates — not just memories.
 *
 * Architecture:
 *   tick completes → self-perception assesses → crystallization observes
 *   → candidates detected → gates auto-installed → loop improves
 */

import type { TickResult, Gate } from '../types.js'
import type { GateSystem } from '../gates.js'
import { createCrystallization, type CrystallizationEngine, type Pattern } from './crystallization.js'
import { createSelfPerception, type SelfPerceptionEngine, type QualityTrend } from './self-perception.js'

export interface LearningSystem {
  /** Process a completed tick — assess, detect patterns, maybe crystallize */
  afterTick(tick: TickResult, recentTicks: TickResult[]): LearningResult
  /** Get quality trend */
  getQualityTrend(recentTicks: TickResult[]): QualityTrend
  /** Get all detected patterns */
  getPatterns(): Pattern[]
  /** Get context string to inject into next tick */
  getContextSection(): string
  /** Persist state */
  save(): void
}

export interface LearningResult {
  /** Quality assessment for this tick */
  quality: number
  /** Signals that contributed to quality score */
  signals: string[]
  /** New gates crystallized this tick (usually 0) */
  newGates: Gate[]
  /** Patterns approaching crystallization threshold */
  risingPatterns: Pattern[]
}

export interface LearningConfig {
  stateDir: string
  gateSystem: GateSystem
  enabled?: boolean
  crystallization?: boolean
  selfPerception?: boolean
}

export function createLearningSystem(config: LearningConfig): LearningSystem {
  const enabled = config.enabled ?? true
  const crystallizationEnabled = config.crystallization ?? true
  const selfPerceptionEnabled = config.selfPerception ?? true

  const crystallization: CrystallizationEngine | null = crystallizationEnabled
    ? createCrystallization(config.stateDir)
    : null

  const selfPerception: SelfPerceptionEngine | null = selfPerceptionEnabled
    ? createSelfPerception()
    : null

  let lastResult: LearningResult | null = null

  return {
    afterTick(tick: TickResult, recentTicks: TickResult[]): LearningResult {
      if (!enabled) {
        return { quality: 3, signals: [], newGates: [], risingPatterns: [] }
      }

      // 1. Self-perception: assess quality
      const assessment = selfPerception?.assess(tick)
      const quality = assessment?.quality ?? 3
      const signals = assessment?.signals ?? []

      // 2. Crystallization: observe pattern + maybe generate gates
      const newGates: Gate[] = []
      let risingPatterns: Pattern[] = []

      if (crystallization) {
        crystallization.observe(tick)

        // Check for crystallization candidates
        const candidates = crystallization.getCandidates()
        risingPatterns = candidates

        for (const candidate of candidates) {
          const gate = crystallization.crystallize(candidate)
          config.gateSystem.register(gate)
          newGates.push(gate)
        }

        // Persist after observation
        crystallization.save()
      }

      lastResult = { quality, signals, newGates, risingPatterns }
      return lastResult
    },

    getQualityTrend(recentTicks: TickResult[]): QualityTrend {
      if (!selfPerception) {
        return { average: 3, direction: 'stable', windowSize: 0 }
      }
      return selfPerception.getQualityTrend(recentTicks)
    },

    getPatterns(): Pattern[] {
      return crystallization?.getPatterns() ?? []
    },

    getContextSection(): string {
      if (!lastResult) return ''

      const lines: string[] = []

      // Quality signal
      if (lastResult.quality <= 2) {
        lines.push(`⚠ Last tick quality: ${lastResult.quality}/5 [${lastResult.signals.join(', ')}]`)
      }

      // New gates
      if (lastResult.newGates.length > 0) {
        lines.push(
          `🔮 Crystallized ${lastResult.newGates.length} new gate(s): ${lastResult.newGates.map(g => g.name).join(', ')}`
        )
      }

      // Rising patterns (approaching threshold but not yet crystallized)
      const rising = this.getPatterns().filter(p => p.occurrences >= 2 && !p.crystallized)
      if (rising.length > 0) {
        lines.push(
          `📊 Rising patterns: ${rising.map(p => `${p.description} (${p.occurrences}x)`).join('; ')}`
        )
      }

      if (lines.length === 0) return ''
      return `<learning>\n${lines.join('\n')}\n</learning>`
    },

    save(): void {
      crystallization?.save()
    },
  }
}

// Re-exports
export type { CrystallizationEngine, Pattern, PatternType } from './crystallization.js'
export type { SelfPerceptionEngine, ObservationAssessment, QualityTrend } from './self-perception.js'
export { createCrystallization } from './crystallization.js'
export { createSelfPerception } from './self-perception.js'
