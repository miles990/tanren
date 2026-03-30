/**
 * Tanren — Loop Module
 *
 * The tick orchestrator. perceive → think → act → observe.
 * ONLY orchestration — everything else is a module the loop calls.
 *
 * Convergence Condition: Agent cycles through perceive→think→act reliably.
 * A tick always completes or fails gracefully — never hangs, never loses
 * state. If killed mid-cycle, the next start picks up where it left off.
 */

import { writeFileSync, readFileSync, appendFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  TanrenConfig,
  TickResult,
  Action,
  Observation,
  GateContext,
  GateResult,
  MemorySystem,
  LLMProvider,
} from './types.js'
import { createMemorySystem } from './memory.js'
import { createClaudeCliProvider } from './llm/claude-cli.js'
import { createPerception, type PerceptionSystem } from './perception.js'
import { createGateSystem, type GateSystem } from './gates.js'
import { createActionRegistry, builtinActions, type ActionRegistry } from './actions.js'
import { createLearningSystem, type LearningSystem } from './learning/index.js'

// === Checkpoint for crash recovery ===

interface Checkpoint {
  tickStarted: number
  perception: string
}

// === Agent Loop ===

export interface AgentLoop {
  tick(): Promise<TickResult>
  start(interval?: number): void
  stop(): void
  isRunning(): boolean
  getRecentTicks(): TickResult[]
}

export function createLoop(config: TanrenConfig): AgentLoop {
  const memory = createMemorySystem(config.memoryDir, config.searchPaths)
  const llm: LLMProvider = config.llm ?? createClaudeCliProvider()
  const perception = createPerception(config.perceptionPlugins ?? [])
  const gateSystem = createGateSystem(config.gates ?? [])
  const actionRegistry = createActionRegistry()

  // Register built-in + user actions
  for (const handler of builtinActions) {
    actionRegistry.register(handler)
  }
  if (config.actions) {
    for (const handler of config.actions) {
      actionRegistry.register(handler)
    }
  }

  // Learning system
  const learningEnabled = config.learning?.enabled ?? true
  const learning: LearningSystem | null = learningEnabled
    ? createLearningSystem({
        stateDir: join(config.memoryDir, 'state'),
        gateSystem,
        enabled: true,
        crystallization: config.learning?.crystallization ?? true,
        selfPerception: config.learning?.selfPerception ?? true,
      })
    : null

  const workDir = config.workDir ?? process.cwd()
  const recentTicks: TickResult[] = []
  const maxRecentTicks = 20
  const checkpointPath = join(config.memoryDir, 'state', '.checkpoint.json')
  const gateStatePath = join(config.memoryDir, 'state', 'gate-state.json')
  const journalDir = join(config.memoryDir, 'journal')
  const tickJournalPath = join(journalDir, 'ticks.jsonl')

  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null

  // Load persistent gate state
  const gateState = loadGateState(gateStatePath)

  async function tick(): Promise<TickResult> {
    const tickStart = Date.now()

    // 1. Perceive
    const perceptionOutput = await perception.perceive()
    writeCheckpoint(checkpointPath, { tickStarted: tickStart, perception: perceptionOutput })

    // 2. Build context
    const identity = await loadIdentity(config.identity, memory)
    const gateWarnings = gateSystem.getWarnings()
    const learningContext = learning?.getContextSection() ?? ''
    const context = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext)

    // 3. Think (LLM call)
    const systemPrompt = buildSystemPrompt(identity, actionRegistry)
    let thought: string
    try {
      thought = await llm.think(context, systemPrompt)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      thought = `[LLM error: ${msg}]`
    }

    // 4. Parse actions
    const actions = actionRegistry.parse(thought)

    // 5. Gate check (before execution)
    const observation = createEmptyObservation(tickStart)
    const tickResult: TickResult = {
      perception: perceptionOutput,
      thought,
      actions,
      observation,
      timestamp: tickStart,
      gateResults: [],
    }

    const gateContext: GateContext = {
      tick: tickResult,
      recentTicks: [...recentTicks],
      memory,
      state: gateState,
    }

    const gateResults = gateSystem.runAll(gateContext)
    tickResult.gateResults = gateResults

    // Check for blocks
    const blocks = gateResults.filter(r => r.action === 'block')
    if (blocks.length > 0) {
      tickResult.observation = {
        ...observation,
        outputExists: false,
        environmentFeedback: `Blocked by gates: ${blocks.map(b => (b as { message: string }).message).join('; ')}`,
        duration: Date.now() - tickStart,
      }
    } else {
      // 6. Execute actions
      let actionsExecuted = 0
      let actionsFailed = 0
      const actionResults: string[] = []

      for (const action of actions) {
        try {
          const result = await actionRegistry.execute(action, { memory, workDir })
          actionResults.push(result)
          actionsExecuted++
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          actionResults.push(`[action ${action.type} failed: ${msg}]`)
          actionsFailed++
        }
      }

      tickResult.observation = {
        outputExists: actions.length > 0,
        outputQuality: 0,  // assessed by learning system later
        confidenceCalibration: 0,
        actionsExecuted,
        actionsFailed,
        duration: Date.now() - tickStart,
        environmentFeedback: actionResults.length > 0
          ? actionResults.join('\n')
          : undefined,
      }
    }

    // 7. Store tick & cleanup
    recentTicks.push(tickResult)
    if (recentTicks.length > maxRecentTicks) {
      recentTicks.shift()
    }

    // Save gate state
    saveGateState(gateStatePath, gateState)

    // Clear checkpoint (tick completed successfully)
    clearCheckpoint(checkpointPath)

    // 8. Learning: observe tick, detect patterns, maybe crystallize
    if (learning) {
      const learningResult = learning.afterTick(tickResult, recentTicks)
      // Update observation quality from learning assessment
      tickResult.observation.outputQuality = learningResult.quality
    }

    // Persist tick to journal (append-only JSONL)
    persistTick(journalDir, tickJournalPath, tickResult)

    // Auto-commit memory changes
    await memory.autoCommit().catch(() => {})

    // Clear gate results for next tick
    gateSystem.clearResults()

    return tickResult
  }

  function start(interval?: number): void {
    if (running) return
    running = true
    const ms = interval ?? config.tickInterval ?? 60_000

    const scheduleNext = () => {
      if (!running) return
      timer = setTimeout(async () => {
        try {
          await tick()
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[tanren] tick error: ${msg}`)
        }
        scheduleNext()
      }, ms)
    }

    // Run first tick immediately
    tick()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[tanren] first tick error: ${msg}`)
      })
      .finally(scheduleNext)
  }

  function stop(): void {
    running = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    tick,
    start,
    stop,
    isRunning: () => running,
    getRecentTicks: () => [...recentTicks],
  }
}

// === Helpers ===

async function loadIdentity(identity: string, memory: MemorySystem): Promise<string> {
  // If it looks like a file path, read it
  if (identity.endsWith('.md') || identity.includes('/')) {
    const content = await memory.read(identity)
    if (content) return content
    // Try as absolute path
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile(identity, 'utf-8')
    } catch {
      return identity  // fall back to treating as inline string
    }
  }
  return identity
}

function buildContext(
  identity: string,
  perception: string,
  gateWarnings: string[],
  _memory: MemorySystem,
  learningContext: string = '',
): string {
  const sections: string[] = []

  if (perception) {
    sections.push(perception)
  }

  if (gateWarnings.length > 0) {
    sections.push(
      `<gate-warnings>\n${gateWarnings.map(w => `- ${w}`).join('\n')}\n</gate-warnings>`
    )
  }

  if (learningContext) {
    sections.push(learningContext)
  }

  sections.push(`<current-time>${new Date().toISOString()}</current-time>`)

  return sections.join('\n\n')
}

function buildSystemPrompt(identity: string, actions: ActionRegistry): string {
  const actionTypes = actions.types()

  const actionLines = actionTypes.map(t => {
    const desc = actions.getDescription(t)
    return desc ? `- <action:${t}>...</action:${t}> — ${desc}` : `- <action:${t}>...</action:${t}>`
  })

  return `${identity}

## Available Actions

Use these tags in your response to take actions:

${actionLines.join('\n')}

You can include multiple actions in a single response. Actions are executed in order.

CRITICAL: Your output MUST contain action tags to produce any effect. Text without action tags is recorded but has no side effects. If you want to respond to a message, you MUST use <action:respond>. If you want to remember something, you MUST use <action:remember>. Analysis without action tags = wasted tick.`
}

function createEmptyObservation(tickStart: number): Observation {
  return {
    outputExists: false,
    outputQuality: 0,
    confidenceCalibration: 0,
    actionsExecuted: 0,
    actionsFailed: 0,
    duration: Date.now() - tickStart,
  }
}

function writeCheckpoint(path: string, data: Checkpoint): void {
  try {
    writeFileSync(path, JSON.stringify(data), 'utf-8')
  } catch { /* best effort */ }
}

function clearCheckpoint(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch { /* best effort */ }
}

function loadGateState(path: string): Record<string, unknown> {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch { /* start fresh */ }
  return {}
}

function saveGateState(path: string, state: Record<string, unknown>): void {
  try {
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch { /* best effort */ }
}

function persistTick(journalDir: string, journalPath: string, tick: TickResult): void {
  try {
    if (!existsSync(journalDir)) {
      mkdirSync(journalDir, { recursive: true })
    }
    const entry = JSON.stringify({
      t: tick.timestamp,
      thought: tick.thought,
      actions: tick.actions.map(a => ({ type: a.type, content: a.content })),
      observation: {
        outputExists: tick.observation.outputExists,
        quality: tick.observation.outputQuality,
        actionsExecuted: tick.observation.actionsExecuted,
        actionsFailed: tick.observation.actionsFailed,
        duration: tick.observation.duration,
        feedback: tick.observation.environmentFeedback,
      },
      gates: tick.gateResults.filter(g => g.action !== 'pass'),
      perception: tick.perception.slice(0, 500),  // truncate for space
    })
    appendFileSync(journalPath, entry + '\n', 'utf-8')

    // Human-readable tick log (one file per tick)
    const ticksDir = join(journalDir, 'ticks')
    if (!existsSync(ticksDir)) {
      mkdirSync(ticksDir, { recursive: true })
    }
    const existing = readdirSync(ticksDir).filter(f => f.endsWith('.md')).length
    const tickNum = String(existing + 1).padStart(3, '0')
    const date = new Date(tick.timestamp).toISOString().replace('T', ' ').slice(0, 19)
    const duration = (tick.observation.duration / 1000).toFixed(1)
    const gateNotes = tick.gateResults
      .filter(g => g.action !== 'pass')
      .map(g => `- [${g.action}] ${(g as { message: string }).message}`)
      .join('\n')

    const md = [
      `# Tick ${tickNum}`,
      ``,
      `**Time**: ${date}  `,
      `**Duration**: ${duration}s  `,
      `**Actions**: ${tick.observation.actionsExecuted} executed, ${tick.observation.actionsFailed} failed  `,
      `**Quality**: ${tick.observation.outputQuality}/5`,
      gateNotes ? `\n## Gate Results\n${gateNotes}` : '',
      ``,
      `## Thought`,
      ``,
      tick.thought,
      ``,
      `## Observation`,
      ``,
      tick.observation.environmentFeedback ?? '_No feedback_',
      ``,
    ].join('\n')

    writeFileSync(join(ticksDir, `tick-${tickNum}.md`), md, 'utf-8')
  } catch { /* best effort — don't break the loop */ }
}
