/**
 * Tanren — Gates Module
 *
 * Code-level behavioral constraints. Gates intercept actions — they're
 * code that fires, not prompts that suggest. A gate either blocks, warns,
 * or passes. Never silently ignored.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Gate,
  GateContext,
  GateResult,
  TickResult,
  MemoryReader,
} from './types.js'

export interface GateSpec {
  name: string
  description: string
  check: (context: GateContext) => GateResult
}

export interface GateSystem {
  register(gate: Gate): void
  runAll(context: GateContext): GateResult[]
  createGate(spec: GateSpec): Gate
  installGate(gate: Gate, gatesDir: string): void
  loadGatesFromDir(dir: string): Promise<void>
  getWarnings(): string[]
  getBlocks(): string[]
  getGateNames(): string[]
  clearResults(): void
}

export function createGateSystem(initialGates: Gate[] = []): GateSystem {
  const gates: Gate[] = [...initialGates]
  let lastResults: GateResult[] = []

  return {
    register(gate) {
      // Prevent duplicates
      const idx = gates.findIndex((g) => g.name === gate.name)
      if (idx >= 0) {
        gates[idx] = gate
      } else {
        gates.push(gate)
      }
    },

    runAll(context) {
      lastResults = []
      for (const gate of gates) {
        try {
          const result = gate.check(context)
          if (result.action !== 'pass') {
            lastResults.push(result)
          }
        } catch (err) {
          lastResults.push({
            action: 'warn',
            message: `Gate "${gate.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
      return lastResults
    },

    createGate(spec) {
      return {
        name: spec.name,
        description: spec.description,
        check: spec.check,
      }
    },

    installGate(gate, gatesDir) {
      // Persist gate definition to disk
      const filePath = join(gatesDir, `${gate.name}.json`)
      writeFileSync(
        filePath,
        JSON.stringify(
          { name: gate.name, description: gate.description },
          null,
          2,
        ),
      )
      this.register(gate)
    },

    async loadGatesFromDir(dir) {
      if (!existsSync(dir)) return
      const files = readdirSync(dir).filter((f: string) => f.endsWith('.js') || f.endsWith('.mjs'))
      for (const file of files) {
        try {
          const mod = await import(join(dir, file))
          const gate = mod.default ?? mod.gate ?? mod
          if (gate && typeof gate.name === 'string' && typeof gate.check === 'function') {
            this.register(gate)
          }
        } catch (err) {
          console.error(`[gates] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },

    getWarnings() {
      return lastResults
        .filter((r): r is { action: 'warn'; message: string } =>
          r.action === 'warn',
        )
        .map((r) => r.message)
    },

    getBlocks() {
      return lastResults
        .filter((r): r is { action: 'block'; message: string } =>
          r.action === 'block',
        )
        .map((r) => r.message)
    },

    getGateNames() {
      return gates.map(g => g.name)
    },

    clearResults() {
      lastResults = []
    },
  }
}

// === Convenience: defineGate ===

export function defineGate(spec: GateSpec): Gate {
  return {
    name: spec.name,
    description: spec.description,
    check: spec.check,
  }
}

// === Default Gates ===
// All recommended gates with sensible defaults. Use this in config for full protection.

export function defaultGates(): Gate[] {
  return [
    createOutputGate(3),
    createAnalysisWithoutActionGate(2),
    createProductivityGate(3),
    createSymptomFixGate(5),
    createGroundBeforeOpineGate(),
    createWriteThroughGate(3),
    createCommitmentGate(),
  ]
}

// === Built-in Gate: Output Gate ===
// Warns after N consecutive ticks without visible output

export function createOutputGate(threshold: number = 3): Gate {
  let consecutiveEmpty = 0

  return {
    name: 'output-gate',
    description: `Warn after ${threshold} ticks without visible output`,
    check(ctx) {
      if (ctx.tick.observation.outputExists) {
        consecutiveEmpty = 0
        return { action: 'pass' }
      }

      consecutiveEmpty++
      if (consecutiveEmpty >= threshold) {
        return {
          action: 'warn',
          message: `${consecutiveEmpty} consecutive ticks without visible output. Are you producing value, or just thinking?`,
        }
      }
      return { action: 'pass' }
    },
  }
}

// === Built-in Gate: Analysis Without Action ===
// Warns when thought is substantial but zero actions executed
// Catches "cognitive paralysis" — active analysis but behavioral shutdown

export function createAnalysisWithoutActionGate(
  threshold: number = 2,
  minThoughtLength: number = 200,
): Gate {
  let consecutiveParalysis = 0

  return {
    name: 'analysis-without-action',
    description: `Warn after ${threshold} consecutive ticks with substantial thought but zero actions`,
    check(ctx) {
      const hasSubstantialThought = ctx.tick.thought.length > minThoughtLength
      const hasZeroActions = ctx.tick.actions.length === 0

      if (hasSubstantialThought && hasZeroActions) {
        consecutiveParalysis++
        if (consecutiveParalysis >= threshold) {
          return {
            action: 'warn',
            message: `${consecutiveParalysis} consecutive ticks with analysis (${ctx.tick.thought.length} chars) but zero actions. Thinking without acting — are action tags being emitted?`,
          }
        }
        return { action: 'pass' }
      }

      consecutiveParalysis = 0
      return { action: 'pass' }
    },
  }
}

// === Built-in Gate: Productivity Gate ===
// Warns when agent has been doing only internal actions (remember/read/search)
// without any externally visible output (respond/write/edit/shell)

export function createProductivityGate(threshold: number = 3): Gate {
  let consecutiveInternalOnly = 0
  const INTERNAL_ONLY = new Set(['remember', 'read', 'search', 'explore', 'reflect', 'focus', 'clear-inbox'])

  return {
    name: 'productivity-gate',
    description: `Warn after ${threshold} ticks with only internal actions (no visible output)`,
    check(ctx) {
      const actions = ctx.tick.actions
      // Has actions, but all are internal
      if (actions.length > 0 && actions.every(a => INTERNAL_ONLY.has(a.type))) {
        consecutiveInternalOnly++
        if (consecutiveInternalOnly >= threshold) {
          return {
            action: 'warn',
            message: `${consecutiveInternalOnly} consecutive ticks with only internal actions (${actions.map(a => a.type).join(', ')}). Reading and remembering is not output — write, respond, or build something.`,
          }
        }
        return { action: 'pass' }
      }

      consecutiveInternalOnly = 0
      return { action: 'pass' }
    },
  }
}

// === Built-in Gate: Symptom Fix Streak ===
// Warns when too many consecutive fixes might be treating symptoms

export function createSymptomFixGate(threshold: number = 5): Gate {
  return {
    name: 'symptom-fix-streak',
    description: `Warn after ${threshold} consecutive fix-like actions`,
    check(ctx) {
      const recent = ctx.recentTicks.slice(-threshold)
      if (recent.length < threshold) return { action: 'pass' }

      const allFixes = recent.every((tick) =>
        tick.actions.some(
          (a) =>
            a.type === 'fix' ||
            a.content.toLowerCase().includes('fix') ||
            a.content.toLowerCase().includes('patch'),
        ),
      )

      if (allFixes) {
        return {
          action: 'warn',
          message: `${threshold} consecutive fix actions. Are you fixing the root cause, or just patching symptoms?`,
        }
      }
      return { action: 'pass' }
    },
  }
}

// === Agent Integrity Gate: Ground Before Opine ===
// If agent responds about a URL/resource without having read/fetched it first,
// warn. Prevents hallucinated opinions on unread sources.
// Crystallized from repeated agent failure: opining on projects/articles without reading them.

export function createGroundBeforeOpineGate(): Gate {
  return {
    name: 'ground-before-opine',
    description: 'Warn when agent responds about external resources without reading them first',
    check(ctx) {
      const actions = ctx.tick.actions
      const respondActions = actions.filter(a => a.type === 'respond')
      if (respondActions.length === 0) return { action: 'pass' }

      // Check if response references URLs or external resources
      const responseText = respondActions.map(a => a.content).join(' ')
      const mentionsUrl = /https?:\/\/|\.com|\.io|\.org|\.dev|github|npm|pypi/i.test(responseText)
      if (!mentionsUrl) return { action: 'pass' }

      // Check if agent read/fetched anything this tick
      const READ_ACTIONS = new Set(['read', 'web_fetch', 'search', 'explore', 'shell'])
      const hasGrounding = actions.some(a => READ_ACTIONS.has(a.type))
      if (hasGrounding) return { action: 'pass' }

      return {
        action: 'warn',
        message: `Response references external resources but no read/fetch/search action was taken this tick. Ground your claims in actual source material — don't opine on what you haven't read.`,
      }
    },
  }
}

// === Agent Integrity Gate: Write-Through ===
// If agent claims completion but has no write/edit/shell in recent ticks,
// warn. Prevents "done" without persistent state change.
// Crystallized from repeated agent failure: claiming tasks complete without verification.

export function createWriteThroughGate(lookback: number = 3): Gate {
  const COMPLETION_WORDS = /done|fixed|completed|finished|已完成|完成|修好|搞定|解決/i
  const PERSISTENT_ACTIONS = new Set(['write', 'edit', 'shell', 'git'])

  return {
    name: 'write-through',
    description: 'Warn when agent claims completion without persistent state change',
    check(ctx) {
      const respondActions = ctx.tick.actions.filter(a => a.type === 'respond')
      if (respondActions.length === 0) return { action: 'pass' }

      const responseText = respondActions.map(a => a.content).join(' ')
      if (!COMPLETION_WORDS.test(responseText)) return { action: 'pass' }

      // Check recent ticks (including current) for persistent actions
      const recentWindow = [...ctx.recentTicks.slice(-lookback), ctx.tick]
      const hasPersistentAction = recentWindow.some(tick =>
        tick.actions.some(a => PERSISTENT_ACTIONS.has(a.type)),
      )

      if (hasPersistentAction) return { action: 'pass' }

      return {
        action: 'warn',
        message: `Claiming completion ("${responseText.slice(0, 60)}...") but no write/edit/shell action in the last ${lookback} ticks. An action that doesn't change persistent state is noise — verify the state actually changed.`,
      }
    },
  }
}

// === Agent Integrity Gate: Commitment ===
// If agent promises future action ("let me", "I'll", "讓我") but doesn't
// act on it within the same tick, warn. Prevents unfulfilled promises.
// Crystallized from repeated agent failure: ACK-only replies without follow-through.

export function createCommitmentGate(): Gate {
  const COMMITMENT_WORDS = /let me|i'll|i will|going to|讓我|我來|我去|馬上|等下|稍後|先去/i

  return {
    name: 'commitment',
    description: 'Warn when agent promises action but does not follow through in the same tick',
    check(ctx) {
      const respondActions = ctx.tick.actions.filter(a => a.type === 'respond')
      if (respondActions.length === 0) return { action: 'pass' }

      const responseText = respondActions.map(a => a.content).join(' ')
      if (!COMMITMENT_WORDS.test(responseText)) return { action: 'pass' }

      // Short responses with commitment words + no substantive action = unfulfilled promise
      const SUBSTANTIVE_ACTIONS = new Set(['write', 'edit', 'shell', 'web_fetch', 'read', 'search', 'explore'])
      const hasSubstantiveAction = ctx.tick.actions.some(a => SUBSTANTIVE_ACTIONS.has(a.type))

      if (hasSubstantiveAction) return { action: 'pass' }

      // Only warn on short responses (likely ACK-only, not detailed explanation with future plans)
      if (responseText.length > 200) return { action: 'pass' }

      return {
        action: 'warn',
        message: `Response contains commitment ("${responseText.slice(0, 60)}...") but no substantive action was taken. Promises without follow-through are write-through failures — either act now or explicitly track the pending task.`,
      }
    },
  }
}
