/**
 * Tanren — Working Memory
 *
 * Hot cross-tick persistence: currentFocus, recentInsights, activeThreads.
 * Stored as JSON, loaded before perception, saved after actions.
 * Decay mechanism prevents stale context accumulation.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { safeJsonLoad } from './safe-io.js'

export interface WorkingMemoryState {
  currentFocus: string | null
  recentInsights: Array<{
    content: string
    tick: number
    relevance: number  // 0-1, decays each tick
    anchor?: boolean   // anchored insights decay at 0.95 instead of 0.85
    reasoning?: string // WHY this insight was reached — preserves causal chain across ticks
    evidence?: string  // key evidence that supports this insight
  }>
  activeThreads: Array<{
    id: string
    title: string
    lastActive: number  // tick number
    context: string[]   // key points
  }>
  hypotheses: Array<{
    id: string
    statement: string
    confidence: number  // 0-1, agent's belief in this hypothesis
    evidence: string[]  // supporting evidence
    counter: string[]   // contradicting evidence
    createdTick: number
    lastUpdated: number
    status: 'active' | 'validated' | 'refuted' | 'merged' | 'suspended'
    relatedHypotheses?: string[]  // IDs of competing or complementary hypotheses
  }>
  tensions: Array<{
    id: string
    description: string
    hypothesesIds: string[]  // conflicting hypotheses
    tensionType: 'contradiction' | 'competition' | 'complementary' | 'unknown'
    createdTick: number
    lastActive: number
    resolution?: {
      method: 'evidence' | 'synthesis' | 'external_feedback' | 'time_based'
      outcome: string
      resolvedTick: number
    }
  }>
  lastUpdated: number  // tick number
}

const EMPTY_STATE: WorkingMemoryState = {
  currentFocus: null,
  recentInsights: [],
  activeThreads: [],
  hypotheses: [],
  tensions: [],
  lastUpdated: 0,
}

// Decay constants — anchored insights decay slower (Akari's design: research chains survive)
const INSIGHT_DECAY_RATE = 0.85      // normal insights
const ANCHOR_DECAY_RATE = 0.95       // anchored insights — survive ~3x longer
const INSIGHT_MIN_RELEVANCE = 0.2    // remove below this
const MAX_INSIGHTS = 15              // cap total insights
const THREAD_DORMANT_TICKS = 5       // archive after N ticks inactive
const FOCUS_CLEAR_TICKS = 3          // clear focus if not referenced

export function createWorkingMemory(filePath: string) {
  let state: WorkingMemoryState = EMPTY_STATE

  function load(): WorkingMemoryState {
    // safeJsonLoad: never crashes, auto-merges with EMPTY_STATE for schema evolution
    state = safeJsonLoad(filePath, EMPTY_STATE)
    return state
  }

  function save(): void {
    try {
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, JSON.stringify(state, null, 2))
    } catch { /* fire-and-forget */ }
  }

  function decay(currentTick: number): void {
    // Decay insight relevance
    state.recentInsights = state.recentInsights
      .map(i => ({
        ...i,
        relevance: i.relevance * (i.anchor ? ANCHOR_DECAY_RATE : INSIGHT_DECAY_RATE),
      }))
      .filter(i => i.relevance >= INSIGHT_MIN_RELEVANCE)
      .slice(0, MAX_INSIGHTS)

    // Archive dormant threads
    state.activeThreads = state.activeThreads
      .filter(t => currentTick - t.lastActive < THREAD_DORMANT_TICKS)

    // Clear stale focus
    if (state.currentFocus && currentTick - state.lastUpdated >= FOCUS_CLEAR_TICKS) {
      state.currentFocus = null
    }

    // Process stale hypotheses and tensions
    const HYPOTHESIS_STALE_TICKS = 10
    const TENSION_STALE_TICKS = 15
    
    // Mark old unvalidated hypotheses as suspended
    state.hypotheses = state.hypotheses.map(h => {
      if (h.status === 'active' && currentTick - h.lastUpdated > HYPOTHESIS_STALE_TICKS) {
        return { ...h, status: 'suspended' as const, lastUpdated: currentTick }
      }
      return h
    })

    // Resolve stale tensions without evidence updates
    state.tensions = state.tensions.map(t => {
      if (!t.resolution && currentTick - t.lastActive > TENSION_STALE_TICKS) {
        return {
          ...t,
          resolution: {
            method: 'time_based' as const,
            outcome: 'Tension auto-resolved due to lack of evidence updates',
            resolvedTick: currentTick
          }
        }
      }
      return t
    })
  }

  function update(currentTick: number, updates: {
    focus?: string | null
    insight?: string
    thread?: { id: string; title: string; context: string[] }
  }): void {
    if (updates.focus !== undefined) {
      state.currentFocus = updates.focus
    }
    if (updates.insight) {
      state.recentInsights.unshift({
        content: updates.insight,
        tick: currentTick,
        relevance: 1.0,
      })
      if (state.recentInsights.length > MAX_INSIGHTS) {
        state.recentInsights = state.recentInsights.slice(0, MAX_INSIGHTS)
      }
    }
    if (updates.thread) {
      const existing = state.activeThreads.find(t => t.id === updates.thread!.id)
      if (existing) {
        existing.lastActive = currentTick
        existing.title = updates.thread.title
        existing.context = updates.thread.context
      } else {
        state.activeThreads.push({ ...updates.thread, lastActive: currentTick })
      }
    }
    state.lastUpdated = currentTick
  }

  function toContextString(): string {
    const parts: string[] = []
    if (state.currentFocus) {
      parts.push(`Focus: ${state.currentFocus}`)
    }
    if (state.recentInsights.length > 0) {
      const insights = state.recentInsights
        .slice(0, 8)
        .map(i => {
          let line = `- ${i.content} (tick ${i.tick}, rel ${i.relevance.toFixed(2)}${i.anchor ? ' ⚓' : ''})`
          // Semantic compression: show reasoning chain, not just conclusion
          if (i.reasoning) line += `\n  ∵ ${i.reasoning}`
          if (i.evidence) line += `\n  evidence: ${i.evidence}`
          return line
        })
      parts.push(`Recent insights:\n${insights.join('\n')}`)
    }
    if (state.activeThreads.length > 0) {
      const threads = state.activeThreads.map(t =>
        `- [${t.id}] ${t.title} (last active tick ${t.lastActive}): ${t.context.slice(-2).join('; ')}`
      )
      parts.push(`Active threads:\n${threads.join('\n')}`)
    }
    // Hypothesis tracking — productive confusion: show competing interpretations
    const activeHypotheses = state.hypotheses.filter(h => h.status === 'active' || h.status === 'validated')
    if (activeHypotheses.length > 0) {
      const hyps = activeHypotheses.map(h => {
        const conf = `${Math.round(h.confidence * 100)}%`
        const ev = h.evidence.length > 0 ? ` [+${h.evidence.length}]` : ''
        const ctr = h.counter.length > 0 ? ` [-${h.counter.length}]` : ''
        return `- [${conf}${ev}${ctr}] ${h.statement} (${h.status})`
      })
      parts.push(`Hypotheses:\n${hyps.join('\n')}`)
    }
    const activeTensions = state.tensions.filter(t => !t.resolution)
    if (activeTensions.length > 0) {
      const tens = activeTensions.map(t =>
        `- ⚡ ${t.description} (${t.tensionType}, ${t.hypothesesIds.length} hypotheses)`
      )
      parts.push(`Tensions:\n${tens.join('\n')}`)
    }
    return parts.length > 0 ? parts.join('\n\n') : ''
  }

  return { load, save, decay, update, toContextString, getState: () => state }
}

// Re-export join for use in tests / consumers without importing node:path directly
export { join }

export type WorkingMemorySystem = ReturnType<typeof createWorkingMemory>
