/**
 * Tanren — Core Types
 *
 * Shared type definitions across all modules.
 */

// === Tick & Action ===

export interface TickResult {
  perception: string
  thought: string
  actions: Action[]
  observation: Observation
  timestamp: number
  gateResults: GateResult[]
}

export interface Action {
  type: string
  content: string
  raw: string
}

// === Observation (from Learning/Self-Perception) ===

export interface Observation {
  outputExists: boolean
  outputQuality: number          // 1-5
  confidenceCalibration: number  // 0-1
  environmentFeedback?: string
  actionsExecuted: number
  actionsFailed: number
  duration: number               // ms
}

// === Gate ===

export interface Gate {
  name: string
  description: string
  check(context: GateContext): GateResult
}

export interface GateContext {
  tick: TickResult
  recentTicks: TickResult[]
  memory: MemoryReader
  state: Record<string, unknown>
}

export type GateResult =
  | { action: 'pass' }
  | { action: 'warn'; message: string }
  | { action: 'block'; message: string }

// === Memory ===

export interface MemoryReader {
  read(path: string): Promise<string | null>
  search(query: string): Promise<SearchResult[]>
}

export interface MemorySystem extends MemoryReader {
  write(path: string, content: string): Promise<void>
  append(path: string, line: string): Promise<void>
  remember(content: string, opts?: { topic?: string }): Promise<void>
  recall(query: string): Promise<string[]>
  autoCommit(): Promise<boolean>
}

export interface SearchResult {
  file: string
  line: number
  content: string
}

// === LLM ===

export interface LLMProvider {
  think(context: string, systemPrompt: string): Promise<string>
}

// === Perception ===

export interface PerceptionPlugin {
  name: string
  fn: () => Promise<string> | string
  interval?: number     // ms, default: every tick
  category?: string
}

// === Action Handler ===

export interface ActionHandler {
  type: string
  execute(action: Action, context: ActionContext): Promise<string>
}

export interface ActionContext {
  memory: MemorySystem
  workDir: string
}

// === Config ===

export interface TanrenConfig {
  identity: string              // path to soul.md or inline string
  memoryDir: string             // path to memory directory
  workDir?: string              // working directory (default: process.cwd())

  llm?: LLMProvider
  perceptionPlugins?: PerceptionPlugin[]
  gates?: Gate[]
  gatesDir?: string
  actions?: ActionHandler[]

  tickInterval?: number         // ms between ticks (default: 60000)
  maxConcurrentDelegations?: number  // default: 4

  learning?: {
    enabled?: boolean           // default: true
    selfPerception?: boolean    // default: true
    crystallization?: boolean   // default: true
    antiGoodhart?: boolean      // default: true
  }
}
