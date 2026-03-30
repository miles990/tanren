/**
 * Tanren — Crystallization Engine
 *
 * Detects repeated behavior patterns and turns them into gates.
 * This is the core of Tanren's learning: observation → pattern → code.
 *
 * Convergence Condition: Repeated patterns (failures OR successes)
 * automatically become durable structures — gates that fire every time.
 * "Repeated" means N >= 3 occurrences of the same pattern.
 *
 * Key insight from 195 cycles: if input is fixed + rule is fixed +
 * output is fixed = mechanical = write code gate. Gray area = not
 * mechanical = keep as prompt warning. Code gates > memory notes,
 * because gates fire every time.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineGate } from '../gates.js'
import type { Gate, TickResult } from '../types.js'

// === Types ===

export interface Pattern {
  id: string
  type: PatternType
  signature: string           // what makes this pattern recognizable
  description: string         // human-readable
  occurrences: number
  firstSeen: number
  lastSeen: number
  examples: PatternExample[]  // concrete evidence (capped at 5)
  crystallized: boolean       // already turned into a gate?
}

export type PatternType =
  | 'repeated-failure'   // same action fails the same way
  | 'empty-streak'       // no visible output for N ticks
  | 'action-streak'      // same action type dominates
  | 'gate-ignored'       // agent keeps triggering same gate warning

interface PatternExample {
  timestamp: number
  summary: string
}

export interface CrystallizationEngine {
  /** Feed a completed tick for pattern analysis */
  observe(tick: TickResult): void
  /** Get all tracked patterns */
  getPatterns(): Pattern[]
  /** Get patterns ready to crystallize (>= threshold, not yet crystallized) */
  getCandidates(): Pattern[]
  /** Turn a pattern into a gate */
  crystallize(pattern: Pattern): Gate
  /** Re-create gates for already-crystallized patterns (DNA bootstrap) */
  rehydrate(): Gate[]
  /** Persist state to disk */
  save(): void
}

interface CrystallizationState {
  patterns: Pattern[]
  lastObserved: number
}

// === Constants ===

const CRYSTALLIZATION_THRESHOLD = 3
const MAX_EXAMPLES = 5
const MAX_PATTERNS = 100

// === Factory ===

export function createCrystallization(stateDir: string): CrystallizationEngine {
  const statePath = join(stateDir, 'crystallization.json')
  const state = loadState(statePath)

  return {
    observe(tick: TickResult): void {
      const signatures = detectSignatures(tick)
      const now = Date.now()

      for (const sig of signatures) {
        const existing = state.patterns.find(p => p.signature === sig.signature)

        if (existing) {
          existing.occurrences++
          existing.lastSeen = now
          if (existing.examples.length < MAX_EXAMPLES) {
            existing.examples.push({ timestamp: now, summary: sig.summary })
          }
        } else {
          state.patterns.push({
            id: hashSignature(sig.signature),
            type: sig.type,
            signature: sig.signature,
            description: sig.description,
            occurrences: 1,
            firstSeen: now,
            lastSeen: now,
            examples: [{ timestamp: now, summary: sig.summary }],
            crystallized: false,
          })
        }
      }

      // Prune old patterns (keep most recent MAX_PATTERNS)
      if (state.patterns.length > MAX_PATTERNS) {
        state.patterns.sort((a, b) => b.lastSeen - a.lastSeen)
        state.patterns = state.patterns.slice(0, MAX_PATTERNS)
      }

      state.lastObserved = now
    },

    getPatterns(): Pattern[] {
      return [...state.patterns]
    },

    getCandidates(): Pattern[] {
      return state.patterns.filter(
        p => p.occurrences >= CRYSTALLIZATION_THRESHOLD && !p.crystallized
      )
    },

    crystallize(pattern: Pattern): Gate {
      const gate = patternToGate(pattern)
      pattern.crystallized = true
      return gate
    },

    rehydrate(): Gate[] {
      return state.patterns
        .filter(p => p.crystallized)
        .map(p => patternToGate(p))
    },

    save(): void {
      saveState(statePath, state)
    },
  }
}

// === Pattern Detection ===
// Each detector looks at a tick and emits zero or more signatures.

interface SignatureHit {
  type: PatternType
  signature: string
  description: string
  summary: string
}

function detectSignatures(tick: TickResult): SignatureHit[] {
  const hits: SignatureHit[] = []

  // Detector 1: Repeated failures
  // Same action type failing with similar error messages
  for (const action of tick.actions) {
    const feedback = tick.observation.environmentFeedback ?? ''
    if (feedback.includes(`action ${action.type} failed`) || tick.observation.actionsFailed > 0) {
      // Extract error essence (first 80 chars of feedback after "failed:")
      const errorMatch = feedback.match(/failed:\s*(.{1,80})/)
      const errorEssence = errorMatch ? errorMatch[1].trim() : 'unknown'

      hits.push({
        type: 'repeated-failure',
        signature: `failure:${action.type}:${normalizeError(errorEssence)}`,
        description: `Action "${action.type}" repeatedly fails: ${errorEssence}`,
        summary: `${action.type} → ${errorEssence}`,
      })
    }
  }

  // Detector 2: Empty output
  if (!tick.observation.outputExists && tick.actions.length === 0) {
    hits.push({
      type: 'empty-streak',
      signature: 'empty-output',
      description: 'Tick produced no visible output or actions',
      summary: 'No output',
    })
  }

  // Detector 3: Action type dominance
  // If all actions in this tick are the same type
  if (tick.actions.length >= 2) {
    const types = new Set(tick.actions.map(a => a.type))
    if (types.size === 1) {
      const type = tick.actions[0].type
      hits.push({
        type: 'action-streak',
        signature: `streak:${type}`,
        description: `Tick dominated by "${type}" actions (${tick.actions.length}x)`,
        summary: `${tick.actions.length}x ${type}`,
      })
    }
  }

  // Detector 4: Gate warnings ignored
  // Agent received warnings but didn't change behavior
  for (const result of tick.gateResults) {
    if (result.action === 'warn') {
      hits.push({
        type: 'gate-ignored',
        signature: `gate-ignored:${normalizeError((result as { message: string }).message)}`,
        description: `Gate warning fired but behavior unchanged: ${(result as { message: string }).message.slice(0, 100)}`,
        summary: (result as { message: string }).message.slice(0, 80),
      })
    }
  }

  return hits
}

// === Gate Generation ===
// Turn a detected pattern into a concrete Gate.

function patternToGate(pattern: Pattern): Gate {
  switch (pattern.type) {
    case 'repeated-failure':
      return makeFailureGate(pattern)
    case 'empty-streak':
      return makeEmptyStreakGate(pattern)
    case 'action-streak':
      return makeActionStreakGate(pattern)
    case 'gate-ignored':
      return makeEscalationGate(pattern)
  }
}

function makeFailureGate(pattern: Pattern): Gate {
  // Extract action type from signature: "failure:{type}:{error}"
  const parts = pattern.signature.split(':')
  const actionType = parts[1] ?? 'unknown'

  return defineGate({
    name: `auto-${pattern.id}`,
    description: `Auto-crystallized: ${pattern.description}`,
    check(ctx) {
      const attempting = ctx.tick.actions.some(a => a.type === actionType)
      if (attempting) {
        return {
          action: 'warn',
          message: `⚠ This action ("${actionType}") has failed ${pattern.occurrences} times before. Pattern: ${pattern.description}. Consider a different approach.`,
        }
      }
      return { action: 'pass' }
    },
  })
}

function makeEmptyStreakGate(pattern: Pattern): Gate {
  // Adaptive threshold based on how many times this pattern was seen
  const threshold = Math.max(2, Math.min(5, pattern.occurrences))

  let consecutiveEmpty = 0

  return defineGate({
    name: `auto-${pattern.id}`,
    description: `Auto-crystallized: empty output streak detected (threshold: ${threshold})`,
    check(ctx) {
      if (ctx.tick.observation.outputExists || ctx.tick.actions.length > 0) {
        consecutiveEmpty = 0
        return { action: 'pass' }
      }

      consecutiveEmpty++
      if (consecutiveEmpty >= threshold) {
        return {
          action: 'warn',
          message: `${consecutiveEmpty} ticks without output. Auto-detected pattern: thinking without acting.`,
        }
      }
      return { action: 'pass' }
    },
  })
}

function makeActionStreakGate(pattern: Pattern): Gate {
  const parts = pattern.signature.split(':')
  const actionType = parts[1] ?? 'unknown'

  return defineGate({
    name: `auto-${pattern.id}`,
    description: `Auto-crystallized: "${actionType}" action streak`,
    check(ctx) {
      // Check recent ticks for same action dominance
      const recent = ctx.recentTicks.slice(-5)
      const streakCount = recent.filter(t =>
        t.actions.length > 0 && t.actions.every(a => a.type === actionType)
      ).length

      if (streakCount >= 3) {
        return {
          action: 'warn',
          message: `"${actionType}" has dominated ${streakCount} recent ticks. Are you stuck in a loop, or is this intentional?`,
        }
      }
      return { action: 'pass' }
    },
  })
}

function makeEscalationGate(pattern: Pattern): Gate {
  // When a warning has been ignored too many times, escalate to block
  return defineGate({
    name: `auto-${pattern.id}`,
    description: `Auto-escalated: warning ignored ${pattern.occurrences} times`,
    check(ctx) {
      // Check if the same warning pattern is still firing
      const stillFiring = ctx.tick.gateResults.some(r =>
        r.action === 'warn' &&
        normalizeError((r as { message: string }).message) === extractGateMessage(pattern.signature)
      )

      if (stillFiring && pattern.occurrences >= CRYSTALLIZATION_THRESHOLD * 2) {
        return {
          action: 'block',
          message: `🛑 Escalated to block: this warning has been ignored ${pattern.occurrences} times. Original: ${pattern.description}`,
        }
      }
      return { action: 'pass' }
    },
  })
}

// === Helpers ===

function normalizeError(error: string): string {
  // Strip variable parts (timestamps, IDs, paths) to find the error "shape"
  return error
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<timestamp>')
    .replace(/\/[\w/.-]+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .replace(/\d+/g, '<n>')
    .trim()
    .slice(0, 100)
}

function extractGateMessage(signature: string): string {
  // "gate-ignored:{normalized_message}" → extract message
  return signature.replace(/^gate-ignored:/, '')
}

function hashSignature(sig: string): string {
  // Simple hash for pattern ID — not crypto, just uniqueness
  let hash = 0
  for (let i = 0; i < sig.length; i++) {
    const chr = sig.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0 // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36)
}

function loadState(path: string): CrystallizationState {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch { /* start fresh */ }
  return { patterns: [], lastObserved: 0 }
}

function saveState(path: string, state: CrystallizationState): void {
  try {
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch { /* best effort */ }
}
