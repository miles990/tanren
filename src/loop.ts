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

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
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
  const memory = createMemorySystem(config.memoryDir)
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

  const workDir = config.workDir ?? process.cwd()
  const recentTicks: TickResult[] = []
  const maxRecentTicks = 20
  const checkpointPath = join(config.memoryDir, 'state', '.checkpoint.json')
  const gateStatePath = join(config.memoryDir, 'state', 'gate-state.json')

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
    const context = buildContext(identity, perceptionOutput, gateWarnings, memory)

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
    const content = await memory.read(identity.startsWith('/') ? identity : identity)
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

  sections.push(`<current-time>${new Date().toISOString()}</current-time>`)

  return sections.join('\n\n')
}

function buildSystemPrompt(identity: string, actions: ActionRegistry): string {
  const actionTypes = ['remember', 'write', 'append', 'search', 'shell']
    .filter(t => actions.has(t))

  return `${identity}

## Available Actions

Use these tags in your response to take actions:

${actionTypes.map(t => `- <action:${t}>...</action:${t}>`).join('\n')}

You can include multiple actions in a single response. Actions are executed in order.`
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
