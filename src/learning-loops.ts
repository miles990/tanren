/**
 * Learning Loop Detection & Gap Signaling
 * Detects when agent gets stuck (tool errors, empty streaks)
 * and formats gaps for perception-driven investigation.
 * Built by Akari, adapted by Claude Code for Tanren type compatibility.
 */

import type { TickResult } from './types.js'

export type GapTier = 'tier-1' | 'tier-2' | 'tier-3'
export type GapSource = 'tool-error' | 'empty-streak' | 'failed-precondition'

export interface GapSignal {
  tier: GapTier
  source: GapSource
  description: string
  context: string
  detectedAt: string
}

/**
 * Detect gaps from last tick's execution.
 * Tier 1: immediate blocker (tool error on required action)
 * Tier 2: pattern (3+ empty streaks, repeated failure)
 * Tier 3: soft signal (precondition unmet, low confidence)
 */
export function detectGaps(lastTick: TickResult, recentTicks: TickResult[] = []): GapSignal[] {
  const gaps: GapSignal[] = []
  const now = new Date().toISOString()

  // Tier 1: Tool errors (actionsFailed > 0)
  if (lastTick.observation.actionsFailed > 0) {
    gaps.push({
      tier: 'tier-1',
      source: 'tool-error',
      description: `${lastTick.observation.actionsFailed} action(s) failed in last tick`,
      context: `Actions attempted: ${lastTick.actions.map(a => a.type).join(', ')}. Thought: "${lastTick.thought.slice(0, 120)}"`,
      detectedAt: now,
    })
  }

  // Tier 2: Empty action streak (no actions executed across recent ticks)
  if (lastTick.observation.actionsExecuted === 0) {
    const emptyStreak = recentTicks.filter(t => t.observation.actionsExecuted === 0).length
    if (emptyStreak >= 2) {
      gaps.push({
        tier: 'tier-2',
        source: 'empty-streak',
        description: `${emptyStreak + 1} consecutive ticks with no actions executed`,
        context: `Last thought: "${lastTick.thought.slice(0, 120)}"`,
        detectedAt: now,
      })
    }
  }

  // Tier 3: Low output quality (observation score <= 2)
  if (lastTick.observation.outputQuality <= 2 && lastTick.observation.outputQuality > 0) {
    gaps.push({
      tier: 'tier-3',
      source: 'failed-precondition',
      description: `Low output quality (${lastTick.observation.outputQuality}/5) suggests missing context or wrong approach`,
      context: `Actions: ${lastTick.actions.map(a => a.type).join(', ')}`,
      detectedAt: now,
    })
  }

  return gaps
}

/**
 * Prioritize which gap to investigate now vs queue for later.
 * Tier 1 always = investigate now.
 * Tier 2 on repeat = investigate now.
 * Tier 3 = queue.
 */
export function prioritizeGap(
  gap: GapSignal,
  recentGaps: GapSignal[]
): 'investigate-now' | 'queue' {
  if (gap.tier === 'tier-1') {
    return 'investigate-now'
  }

  if (gap.tier === 'tier-2') {
    // Check if this gap (same source) appeared in last 3 ticks
    const recentSame = recentGaps.filter(
      (g) => g.source === gap.source && g.tier === 'tier-2'
    ).length
    if (recentSame >= 2) {
      return 'investigate-now' // Pattern detected
    }
  }

  return 'queue'
}

/**
 * Format a gap into a perception prompt for the LLM.
 * Includes context, tier reasoning, and investigation direction.
 */
export function generateLearningPrompt(gap: GapSignal): string {
  const tierReasoning = {
    'tier-1': 'This is blocking execution. Investigate immediately.',
    'tier-2': 'This is a repeating pattern. Understand the root cause.',
    'tier-3': 'Soft signal. Low priority, but worth noting.',
  }

  return `
## Gap Detected: ${gap.source} (${gap.tier})

**Signal**: ${gap.description}

**Context**: ${gap.context}

**Priority**: ${tierReasoning[gap.tier]}

### Investigation Direction
1. Why did this happen?
2. Is this a structural problem (my design) or environmental (external block)?
3. What would need to change to avoid it next time?

Remember: You're not debugging code. You're noticing what you don't understand and figuring out how to understand it.
`.trim()
}

// TickResult imported from types.ts