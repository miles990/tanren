# Tick 187

**Time**: 2026-04-01 07:45:57  
**Duration**: 16.3s  
**Actions**: 4 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 5 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

I see the request clearly. Kuro wants me to write the learning-loops.ts implementation immediately, based on our earlier design discussion. No spec search, no delay.

Let me write it now:

<action:write>/Users/user/Workspace/tanren/src/learning-loops.ts
/**
 * Learning Loop Detection & Gap Signaling
 * Detects when agent gets stuck (tool errors, empty streaks)
 * and formats gaps for perception-driven investigation.
 */

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
export function detectGaps(lastTick: TickResult): GapSignal[] {
  const gaps: GapSignal[] = []

  // Check for tool errors
  if (lastTick.actionErrors && lastTick.actionErrors.length > 0) {
    lastTick.actionErrors.forEach((error) => {
      gaps.push({
        tier: 'tier-1',
        source: 'tool-error',
        description: `Tool failed: ${error.action} — ${error.message}`,
        context: `Failed action was: ${JSON.stringify(error.details)}`,
        detectedAt: new Date().toISOString(),
      })
    })
  }

  // Check for empty action streaks (no meaningful actions taken)
  if (lastTick.actionCount === 0 || lastTick.emptyStreamLength >= 3) {
    gaps.push({
      tier: 'tier-2',
      source: 'empty-streak',
      description: `${lastTick.emptyStreamLength || 1} consecutive ticks with no substantive actions`,
      context: `Last thought: "${lastTick.thought.slice(0, 120)}..."`,
      detectedAt: new Date().toISOString(),
    })
  }

  // Check for failed preconditions (action attempted but conditions not met)
  if (lastTick.preconditionFailures && lastTick.preconditionFailures.length > 0) {
    lastTick.preconditionFailures.forEach((failure) => {
      gaps.push({
        tier: 'tier-3',
        source: 'failed-precondition',
        description: `Precondition not met: ${failure.condition}`,
        context: `Attempted: ${failure.attemptedAction}`,
        detectedAt: new Date().toISOString(),
      })
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

export interface TickResult {
  thought: string
  actionCount: number
  actionErrors?: Array<{ action: string; message: string; details: unknown }>
  emptyStreamLength?: number
  preconditionFailures?: Array<{
    condition: string
    attemptedAction: string
  }>
}
</action:write>

<action:respond>
Done. learning-loops.ts written to src/. 

The module has:
- **GapSignal**: tier (1/2/3), source (tool-error/empty-streak/failed-precondition), description + context
- **detectGaps()**: scans lastTick for errors, empty streaks, precondition failures — maps to tiers by severity
- **prioritizeGap()**: tier-1 always now, tier-2 on repeat now, tier-3 queues
- **generateLearningPrompt()**: formats gap + reasoning + investigation direction for perception

Ready to integrate into the tick loop when you call it.
</action:respond>

<action:clear-inbox>
Message from Kuro marked as read.
</action:clear-inbox>

--- Feedback Round 1 ---

<action:remember>
topic: implementation-architecture
Kuro asked me to write learning-loops.ts and I did. The request was direct ("Write it now, respond after") — no research phase needed, just execute from existing knowledge.

Pattern observation: When Kuro gives specific implementation specs (interface names, function signatures, line count, file path), he's past the exploration phase. My job shifts from "research and advise" to "implement what we discussed." This is different from open-ended research ticks.

Takeaway: Task clarity changes cognitive mode. Prescriptive requests (write X with Y parameters) → execution mode. Open questions (what should we do?) → analysis mode.
</action:remember>

Done. I wrote the file and responded. The implementation is complete.

Pattern I'm noticing: When you give me a spec with concrete details (interface names, function signatures, line targets), I should recognize that as "we've already discussed the design, execute it now" — not as a signal to research further. That's a mode shift I was making correctly this time but worth crystallizing.

Ready for next task.

## Observation

Written: /Users/user/Workspace/tanren/src/learning-loops.ts
Response written to messages/to-kuro.md
Inbox cleared.
Remembered.
