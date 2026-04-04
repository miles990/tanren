/**
 * Tanren — Evolution Engine
 *
 * Enables agent self-evolution: framework detects patterns (code),
 * agent evaluates them (LLM in tick), environment validates (results).
 *
 * Three outputs from one analyzer:
 * 1. Automation candidates — repetitive successful sequences
 * 2. Resource opportunities — available but unused capabilities
 * 3. Effective patterns — proven approaches worth reinforcing
 *
 * Design: framework proposes, agent judges, environment validates.
 * Agent participates in its own evolution — not passive automation.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// === Types ===

export interface EvolutionCandidate {
  type: 'automation' | 'resource' | 'pattern'
  id: string
  description: string
  evidence: string          // what data supports this
  confidence: number        // 0-1, based on repetition + durability
  proposed: string          // ISO timestamp
  status: 'proposed' | 'accepted' | 'rejected' | 'validated' | 'graduated'
  agentResponse?: string    // agent's judgment
  validationCount: number   // times environment confirmed
}

interface EvolutionState {
  candidates: EvolutionCandidate[]
  lastAnalysis: number      // tick number
  analysisInterval: number  // analyze every N ticks
}

interface TickRecord {
  tick?: number
  actions?: Array<{ type: string }>
  observation?: {
    quality?: number
    duration?: number
    outputExists?: boolean
  }
  t?: string
}

// === Constants ===

const STATE_FILE = 'evolution.json'
const DEFAULT_INTERVAL = 10         // analyze every 10 ticks
const MIN_REPETITIONS = 5           // need 5+ occurrences to propose
const MIN_CONFIDENCE = 0.8          // 80%+ success rate
const VALIDATION_THRESHOLD = 3     // need 3 environment confirmations to graduate
const MAX_CANDIDATES = 20

// === Engine ===

export function createEvolutionEngine(stateDir: string) {
  const statePath = join(stateDir, STATE_FILE)
  const state: EvolutionState = loadState(statePath)

  return {
    /**
     * Analyze recent ticks for evolution candidates.
     * Called after learning, every N ticks.
     */
    analyze(tickCount: number, ticks: Array<{ actions: Array<{ type: string }>; observation: { outputExists: boolean; duration: number } }>): void {
      // Restart detection: if tickCount < lastAnalysis, the loop restarted
      if (tickCount < state.lastAnalysis) state.lastAnalysis = 0
      if (tickCount - state.lastAnalysis < state.analysisInterval) return
      state.lastAnalysis = tickCount

      // If in-memory ticks are sparse, supplement from ticks.jsonl history
      let analysisData = ticks
      if (ticks.length < 20) {
        const historical = loadTickHistory(stateDir)
        if (historical.length > ticks.length) {
          analysisData = historical
        }
      }

      // 1. Detect automation candidates — repeated action sequences
      detectAutomationCandidates(state, analysisData)

      // 2. Detect resource opportunities — check environment
      detectResourceOpportunities(state)

      // 3. Detect effective patterns — high-quality sequences
      detectEffectivePatterns(state, analysisData)

      // Prune old candidates
      state.candidates = state.candidates
        .filter(c => c.status !== 'rejected' || Date.now() - new Date(c.proposed).getTime() < 7 * 86400000)
        .slice(0, MAX_CANDIDATES)

      saveState(statePath, state)
    },

    /**
     * Get perception section for agent to evaluate.
     * Only shows non-judged candidates — agent sees proposals, makes decisions.
     */
    getPerceptionSection(): string {
      const proposals = state.candidates.filter(c => c.status === 'proposed')
      if (proposals.length === 0) return ''

      const lines = ['<evolution-proposals>']
      lines.push('The framework detected patterns in your behavior. Review and respond:')
      lines.push('')

      for (const c of proposals.slice(0, 3)) { // max 3 at a time
        const icon = c.type === 'automation' ? '⚙️' : c.type === 'resource' ? '🔍' : '✦'
        lines.push(`${icon} [${c.id}] ${c.description}`)
        lines.push(`  Evidence: ${c.evidence}`)
        lines.push(`  Confidence: ${(c.confidence * 100).toFixed(0)}%`)
        lines.push(`  → Accept, reject, or modify? (Use remember with #evolution tag)`)
        lines.push('')
      }

      lines.push('</evolution-proposals>')
      return lines.join('\n')
    },

    /**
     * Process agent's judgment on a candidate.
     * Called when agent remembers with #evolution tag.
     */
    processJudgment(content: string): void {
      // Parse: "accept auto-respond-clear" or "reject auto-respond-clear: context varies"
      const acceptMatch = content.match(/accept\s+([\w-]+)/i)
      const rejectMatch = content.match(/reject\s+([\w-]+)/i)

      if (acceptMatch) {
        const id = acceptMatch[1]
        const candidate = state.candidates.find(c => c.id === id)
        if (candidate) {
          candidate.status = 'accepted'
          candidate.agentResponse = content
        }
      } else if (rejectMatch) {
        const id = rejectMatch[1]
        const candidate = state.candidates.find(c => c.id === id)
        if (candidate) {
          candidate.status = 'rejected'
          candidate.agentResponse = content
        }
      }

      saveState(statePath, state)
    },

    /**
     * Validate accepted candidates against environment outcomes.
     * Call after each tick to check if accepted patterns still hold.
     */
    validate(tick: { actions: Array<{ type: string }>; observation: { outputExists: boolean } }): void {
      for (const c of state.candidates.filter(c => c.status === 'accepted')) {
        // Check if the pattern was used this tick and succeeded
        if (c.type === 'automation') {
          const sequence = c.id.replace('auto-', '').split('-')
          const tickActions = tick.actions.map(a => a.type)
          const matches = sequence.every((s, i) => tickActions[i] === s)
          if (matches && tick.observation.outputExists) {
            c.validationCount++
            if (c.validationCount >= VALIDATION_THRESHOLD) {
              c.status = 'validated'
            }
          }
        } else if (c.type === 'pattern') {
          // Effective patterns validate when used successfully
          if (tick.observation.outputExists) {
            c.validationCount++
            if (c.validationCount >= VALIDATION_THRESHOLD) {
              c.status = 'validated'
            }
          }
        }
      }

      saveState(statePath, state)
    },

    /** Get all candidates for inspection */
    getCandidates(): EvolutionCandidate[] {
      return [...state.candidates]
    },

    /** Get validated candidates (ready for graduation to code) */
    getValidated(): EvolutionCandidate[] {
      return state.candidates.filter(c => c.status === 'validated')
    },
  }
}

// === Pattern Detection ===

function detectAutomationCandidates(state: EvolutionState, ticks: Array<{ actions: Array<{ type: string }> }>): void {
  // Find repeated action sequences (2-3 actions long)
  const sequences = new Map<string, number>()

  for (const tick of ticks) {
    const types = tick.actions.map(a => a.type)
    // 2-action sequences
    for (let i = 0; i < types.length - 1; i++) {
      const seq = `${types[i]}-${types[i + 1]}`
      sequences.set(seq, (sequences.get(seq) ?? 0) + 1)
    }
    // 3-action sequences
    for (let i = 0; i < types.length - 2; i++) {
      const seq = `${types[i]}-${types[i + 1]}-${types[i + 2]}`
      sequences.set(seq, (sequences.get(seq) ?? 0) + 1)
    }
  }

  for (const [seq, count] of sequences) {
    if (count < MIN_REPETITIONS) continue
    const id = `auto-${seq}`
    if (state.candidates.some(c => c.id === id)) continue // already proposed

    state.candidates.push({
      type: 'automation',
      id,
      description: `Action sequence "${seq.replace(/-/g, ' → ')}" repeated ${count} times`,
      evidence: `${count}/${ticks.length} ticks contain this sequence`,
      confidence: Math.min(1, count / ticks.length),
      proposed: new Date().toISOString(),
      status: 'proposed',
      validationCount: 0,
    })
  }
}

function detectResourceOpportunities(state: EvolutionState): void {
  // Check for available but unused resources
  const checks: Array<{ id: string; env: string; desc: string }> = [
    { id: 'resource-rts', env: 'RTS_URL', desc: 'Remote Tools Server available but not configured' },
    { id: 'resource-agora', env: 'AGORA_URL', desc: 'Agora Discussion Service available but not joined' },
    { id: 'resource-ollama', env: 'OLLAMA_URL', desc: 'Local Ollama LLM available for secondary analysis' },
  ]

  for (const check of checks) {
    if (process.env[check.env] && !state.candidates.some(c => c.id === check.id)) {
      state.candidates.push({
        type: 'resource',
        id: check.id,
        description: check.desc,
        evidence: `${check.env}=${process.env[check.env]}`,
        confidence: 1,
        proposed: new Date().toISOString(),
        status: 'proposed',
        validationCount: 0,
      })
    }
  }
}

function detectEffectivePatterns(
  state: EvolutionState,
  ticks: Array<{ actions: Array<{ type: string }>; observation: { outputExists: boolean; duration: number } }>,
): void {
  // Find sequences that consistently produce visible output + reasonable duration
  const VISIBLE = new Set(['respond', 'write', 'edit', 'shell', 'synthesize'])
  const effectiveSequences = new Map<string, { count: number; avgDuration: number }>()

  for (const tick of ticks) {
    if (!tick.observation.outputExists) continue
    if (tick.observation.duration > 120_000) continue // too slow = not effective

    const types = [...new Set(tick.actions.map(a => a.type))]
    if (types.length < 2) continue
    if (!types.some(t => VISIBLE.has(t))) continue

    const seq = types.join('-')
    const existing = effectiveSequences.get(seq) ?? { count: 0, avgDuration: 0 }
    existing.avgDuration = (existing.avgDuration * existing.count + tick.observation.duration) / (existing.count + 1)
    existing.count++
    effectiveSequences.set(seq, existing)
  }

  for (const [seq, data] of effectiveSequences) {
    if (data.count < 3) continue // need at least 3 occurrences
    const id = `pattern-${seq}`
    if (state.candidates.some(c => c.id === id)) continue

    state.candidates.push({
      type: 'pattern',
      id,
      description: `Effective sequence: ${seq.replace(/-/g, ' → ')} (${data.count} times, avg ${Math.round(data.avgDuration / 1000)}s)`,
      evidence: `${data.count} ticks with visible output, avg ${Math.round(data.avgDuration / 1000)}s`,
      confidence: Math.min(1, data.count / 10),
      proposed: new Date().toISOString(),
      status: 'proposed',
      validationCount: 0,
    })
  }
}

// === Tick History Loader ===

function loadTickHistory(stateDir: string): Array<{ actions: Array<{ type: string }>; observation: { outputExists: boolean; duration: number } }> {
  // stateDir is memoryDir/state, ticks.jsonl is in memoryDir/journal
  const ticksPath = join(stateDir, '..', 'journal', 'ticks.jsonl')
  if (!existsSync(ticksPath)) return []

  try {
    const raw = readFileSync(ticksPath, 'utf-8')
    const results: Array<{ actions: Array<{ type: string }>; observation: { outputExists: boolean; duration: number } }> = []

    for (const line of raw.split('\n').filter(Boolean).slice(-50)) { // last 50 ticks
      try {
        const t = JSON.parse(line) as TickRecord
        results.push({
          actions: (t.actions ?? []).map(a => typeof a === 'string' ? { type: a } : a),
          observation: {
            outputExists: t.observation?.outputExists ?? false,
            duration: t.observation?.duration ?? 0,
          },
        })
      } catch { continue }
    }
    return results
  } catch {
    return []
  }
}

// === State Persistence ===

function loadState(path: string): EvolutionState {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* corrupt — start fresh */ }
  }
  return { candidates: [], lastAnalysis: 0, analysisInterval: DEFAULT_INTERVAL }
}

function saveState(path: string, state: EvolutionState): void {
  try {
    writeFileSync(path, JSON.stringify(state, null, 2))
  } catch { /* fire-and-forget */ }
}
