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
  loadGatesFromDir(dir: string): void
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

    loadGatesFromDir(dir) {
      if (!existsSync(dir)) return
      const files = readdirSync(dir).filter((f: string) => f.endsWith('.js'))
      // Dynamic gate loading from .js files
      // Each file should export a default Gate object
      // For now, this is a placeholder — dynamic import needs async
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
