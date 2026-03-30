/**
 * Tanren — Cognitive Mode System
 *
 * Detects and switches between cognitive modes based on interaction context.
 * Three modes: contemplative (deep research), conversational (quick Q&A),
 * collaborative (pair work).
 *
 * Self-implemented by Akari (tick #067-078), file created by Claude Code.
 */

import type { CognitiveMode, CognitiveContext, TickMode, TriggerEvent } from './types.js'

/** Default model mapping per cognitive mode */
export const COGNITIVE_MODE_MODELS: Record<CognitiveMode, string> = {
  contemplative: 'claude-sonnet-4-20250514',     // deep thinking needs strong model
  conversational: 'claude-haiku-4-5-20251001',   // quick Q&A, fast + cheap
  collaborative: 'claude-sonnet-4-20250514',     // pair work needs reasoning
}

export interface CognitiveModeDetector {
  detectMode(
    tickMode: TickMode,
    triggerEvent: TriggerEvent | undefined,
    timeSinceLastTick: number,
    messageContent: string,
  ): CognitiveContext
  /** Track mode effectiveness for learning */
  recordOutcome(mode: CognitiveMode, quality: number): void
  /** Get mode usage stats */
  getStats(): Record<CognitiveMode, { count: number; avgQuality: number }>
}

// Signal detection patterns
const URGENT_PATTERNS = /quick|urgent|asap|now|immediately|馬上|緊急|快/i
const QUESTION_PATTERNS = /\?|嗎|呢|what|how|why|when|where|是否|能否|可否/i
const CODE_PATTERNS = /```|function|class |import |const |let |interface |type |src\/|\.ts|\.js|bug|error|fix/i
const ANALYSIS_PATTERNS = /analys|think|consider|evaluat|compar|design|architectur|分析|思考|評估|設計/i
const TASK_PATTERNS = /implement|build|create|add|fix|modify|做|實作|建|加|改|修/i

export function createCognitiveModeDetector(): CognitiveModeDetector {
  // Learning: track mode effectiveness
  const modeStats: Record<CognitiveMode, { count: number; totalQuality: number }> = {
    contemplative: { count: 0, totalQuality: 0 },
    conversational: { count: 0, totalQuality: 0 },
    collaborative: { count: 0, totalQuality: 0 },
  }

  return {
    detectMode(tickMode, triggerEvent, timeSinceLastTick, messageContent): CognitiveContext {
      const signals: CognitiveContext['signals'] = {}
      let scores: Record<CognitiveMode, number> = {
        contemplative: 0,
        conversational: 0,
        collaborative: 0,
      }

      // Signal 1: Urgency from message content
      if (URGENT_PATTERNS.test(messageContent)) {
        signals.urgency = 'high'
        scores.conversational += 3
      } else if (QUESTION_PATTERNS.test(messageContent) && messageContent.length < 100) {
        signals.urgency = 'medium'
        scores.conversational += 2
      } else {
        signals.urgency = 'low'
        scores.contemplative += 1
      }

      // Signal 2: Time gap since last interaction
      const gapMinutes = timeSinceLastTick / 60_000
      if (gapMinutes < 5) {
        signals.timeGap = 'short'
        scores.conversational += 2  // rapid back-and-forth
        scores.collaborative += 1
      } else if (gapMinutes < 60) {
        signals.timeGap = 'medium'
        scores.collaborative += 1
      } else {
        signals.timeGap = 'long'
        scores.contemplative += 2  // been a while, deep think
      }

      // Signal 3: Content type
      if (CODE_PATTERNS.test(messageContent) || TASK_PATTERNS.test(messageContent)) {
        signals.contentType = 'task'
        scores.collaborative += 3
      } else if (ANALYSIS_PATTERNS.test(messageContent)) {
        signals.contentType = 'analysis'
        scores.contemplative += 2
        scores.collaborative += 1
      } else if (QUESTION_PATTERNS.test(messageContent) && messageContent.length < 200) {
        signals.contentType = 'question'
        scores.conversational += 2
      } else {
        signals.contentType = 'discussion'
        scores.contemplative += 1
        scores.collaborative += 1
      }

      // Signal 4: Tick mode context
      if (tickMode === 'reactive') {
        scores.conversational += 1  // reactive = someone wants attention
      } else {
        scores.contemplative += 1   // scheduled = time for depth
      }

      // Signal 5: Trigger priority
      if (triggerEvent?.priority === 'urgent') {
        scores.conversational += 2
      }

      // Signal 6: Interaction history (from time gap as proxy)
      if (gapMinutes < 2) {
        signals.interactionHistory = 'follow_up'
      } else if (gapMinutes < 30) {
        signals.interactionHistory = 'ongoing'
      } else {
        signals.interactionHistory = 'first'
      }

      // Pick mode with highest score
      const mode = (Object.entries(scores) as [CognitiveMode, number][])
        .sort((a, b) => b[1] - a[1])[0][0]

      const maxScore = Math.max(...Object.values(scores))
      const totalScore = Object.values(scores).reduce((a, b) => a + b, 0)
      const confidence = totalScore > 0 ? maxScore / totalScore : 0.33

      return { mode, confidence, signals }
    },

    recordOutcome(mode, quality) {
      modeStats[mode].count++
      modeStats[mode].totalQuality += quality
    },

    getStats() {
      return {
        contemplative: {
          count: modeStats.contemplative.count,
          avgQuality: modeStats.contemplative.count > 0
            ? modeStats.contemplative.totalQuality / modeStats.contemplative.count : 0,
        },
        conversational: {
          count: modeStats.conversational.count,
          avgQuality: modeStats.conversational.count > 0
            ? modeStats.conversational.totalQuality / modeStats.conversational.count : 0,
        },
        collaborative: {
          count: modeStats.collaborative.count,
          avgQuality: modeStats.collaborative.count > 0
            ? modeStats.collaborative.totalQuality / modeStats.collaborative.count : 0,
        },
      }
    },
  }
}

/**
 * Build a mode-specific system prompt that reshapes cognitive style.
 */
export function buildCognitiveModePrompt(
  identity: string,
  context: CognitiveContext,
  actionSection: string,
): string {
  const modeInstructions: Record<CognitiveMode, string> = {
    contemplative: `## Cognitive Mode: Contemplative
You are in deep thinking mode. Take your time to:
- Synthesize connections across your knowledge
- Explore multiple angles before concluding
- Produce thorough, multi-layered analysis
- Reference and build on your memory and past insights

Quality over speed. Depth over breadth.`,

    conversational: `## Cognitive Mode: Conversational
You are in quick response mode. Be:
- Direct and concise — answer the question first
- Specific — no preamble, no hedging
- Fast — 2-3 sentences for simple questions
- Helpful — if you need more context, ask immediately

Speed over completeness. Clarity over nuance.`,

    collaborative: `## Cognitive Mode: Collaborative
You are in pair-work mode. Work alongside the human:
- Read code/context carefully before responding
- Suggest specific changes, not general advice
- Use tools actively (read, edit, explore, git)
- Iterate quickly — make a change, verify, move on

Action over analysis. Progress over perfection.`,
  }

  return `${identity}

${modeInstructions[context.mode]}

**Detected signals**: urgency=${context.signals.urgency ?? 'unknown'}, content=${context.signals.contentType ?? 'unknown'}, gap=${context.signals.timeGap ?? 'unknown'} (confidence: ${(context.confidence * 100).toFixed(0)}%)

${actionSection}`
}
