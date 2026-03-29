/**
 * Tanren — Self-Perception Module
 *
 * Observes the agent's own output quality. Not proxy metrics —
 * actual output assessment anchored to environment feedback.
 *
 * Convergence Condition: Agent observes its own actual output quality,
 * not proxy metrics. When output is bad, self-perception says "bad" —
 * even if all intermediate steps succeeded.
 *
 * Key insight: LLM self-judgment is unreliable. So we avoid it here.
 * Instead, we use structural signals: did actions execute? did they
 * produce output? did gates fire? This gives us a cheap, honest
 * quality signal without an extra LLM call.
 */

import type { TickResult, Observation } from '../types.js'

export interface SelfPerceptionEngine {
  /** Assess a completed tick's quality using structural signals */
  assess(tick: TickResult): ObservationAssessment
  /** Get rolling quality average over recent ticks */
  getQualityTrend(recentTicks: TickResult[]): QualityTrend
}

export interface ObservationAssessment {
  /** 1-5 quality score based on structural signals */
  quality: number
  /** What signals contributed to the score */
  signals: string[]
  /** Calibration: how much can we trust this score? */
  confidence: number
}

export interface QualityTrend {
  /** Average quality over the window */
  average: number
  /** Is quality improving, stable, or declining? */
  direction: 'improving' | 'stable' | 'declining'
  /** Number of ticks in the window */
  windowSize: number
}

export function createSelfPerception(): SelfPerceptionEngine {
  return {
    assess(tick: TickResult): ObservationAssessment {
      const signals: string[] = []
      let score = 3 // neutral baseline

      // Signal 1: Did actions exist?
      if (tick.actions.length === 0) {
        score -= 1
        signals.push('no-actions')
      } else {
        score += 0.5
        signals.push(`${tick.actions.length}-actions`)
      }

      // Signal 2: Action success rate
      const { actionsExecuted, actionsFailed } = tick.observation
      if (actionsExecuted > 0 && actionsFailed === 0) {
        score += 0.5
        signals.push('all-actions-succeeded')
      } else if (actionsFailed > 0) {
        score -= 1
        signals.push(`${actionsFailed}-actions-failed`)
      }

      // Signal 3: Gate results
      const warnings = tick.gateResults.filter(r => r.action === 'warn').length
      const blocks = tick.gateResults.filter(r => r.action === 'block').length
      if (blocks > 0) {
        score -= 1.5
        signals.push(`${blocks}-blocked`)
      } else if (warnings > 0) {
        score -= 0.5
        signals.push(`${warnings}-warnings`)
      }

      // Signal 4: Output exists
      if (tick.observation.outputExists) {
        score += 0.5
        signals.push('output-produced')
      }

      // Signal 5: Duration anomaly (too fast = maybe nothing happened)
      if (tick.observation.duration < 1000 && tick.actions.length === 0) {
        score -= 0.5
        signals.push('suspiciously-fast')
      }

      // Clamp to 1-5
      const quality = Math.max(1, Math.min(5, Math.round(score)))

      // Confidence is high for structural signals (no LLM judgment involved)
      // But low when we have few signals to work with
      const confidence = Math.min(1, signals.length / 4)

      return { quality, signals, confidence }
    },

    getQualityTrend(recentTicks: TickResult[]): QualityTrend {
      if (recentTicks.length === 0) {
        return { average: 3, direction: 'stable', windowSize: 0 }
      }

      // Assess each tick
      const scores = recentTicks.map(t => this.assess(t).quality)
      const average = scores.reduce((a, b) => a + b, 0) / scores.length

      // Determine direction by comparing first half to second half
      if (scores.length < 4) {
        return { average, direction: 'stable', windowSize: scores.length }
      }

      const mid = Math.floor(scores.length / 2)
      const firstHalf = scores.slice(0, mid)
      const secondHalf = scores.slice(mid)
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
      const delta = secondAvg - firstAvg

      let direction: 'improving' | 'stable' | 'declining'
      if (delta > 0.5) direction = 'improving'
      else if (delta < -0.5) direction = 'declining'
      else direction = 'stable'

      return { average, direction, windowSize: scores.length }
    },
  }
}
