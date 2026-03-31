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
  attrs?: Record<string, string>
  input?: Record<string, unknown>  // structured input from tool_use
  toolUseId?: string               // for sending tool_result back
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

/** Tool definition for Anthropic API tool use */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** Content block in a tool-use conversation */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/** Message in a multi-turn tool-use conversation */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** Response from a tool-use LLM call */
export interface ToolUseResponse {
  content: ContentBlock[]
  usage: { input_tokens: number; output_tokens: number }
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
}

/** Extended LLM provider with native tool use support */
export interface ToolUseLLMProvider extends LLMProvider {
  thinkWithTools(
    messages: ConversationMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
  ): Promise<ToolUseResponse>
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
  description?: string
  /** JSON Schema for structured tool_use input. If omitted, defaults to { content: string } */
  toolSchema?: {
    properties: Record<string, unknown>
    required?: string[]
  }
  execute(action: Action, context: ActionContext): Promise<string>
}

export interface ActionContext {
  memory: MemorySystem
  workDir: string
}

// === Event-Driven System ===

export interface EventTrigger {
  name: string
  description: string
  detect(): Promise<TriggerEvent | null>
  priority: 'urgent' | 'normal' | 'low'
  cooldown?: number             // ms before next detection (default: 10000)
}

export interface TriggerEvent {
  type: string
  source: string
  data: Record<string, unknown>
  timestamp: number
  priority: 'urgent' | 'normal' | 'low'
}

export type TickMode = 'scheduled' | 'reactive'

// === Cognitive Modes ===

export type CognitiveMode = 'contemplative' | 'conversational' | 'collaborative'

export interface CognitiveContext {
  mode: CognitiveMode
  confidence: number  // 0-1, how confident we are in mode detection
  signals: {
    urgency?: 'low' | 'medium' | 'high'
    interactionHistory?: 'first' | 'ongoing' | 'follow_up'
    timeGap?: 'short' | 'medium' | 'long'    // since last interaction
    contentType?: 'question' | 'task' | 'discussion' | 'analysis'
  }
}

// === Config ===

export interface TanrenConfig {
  identity: string              // path to soul.md or inline string
  memoryDir: string             // path to memory directory
  workDir?: string              // working directory (default: process.cwd())
  searchPaths?: string[]        // additional directories to include in search

  llm?: LLMProvider
  perceptionPlugins?: PerceptionPlugin[]
  gates?: Gate[]
  gatesDir?: string
  actions?: ActionHandler[]
  eventTriggers?: EventTrigger[] // event detection plugins

  tickInterval?: number         // ms between ticks (default: 60000)
  maxConcurrentDelegations?: number  // default: 4
  feedbackRounds?: number        // action feedback rounds per tick (default: 1, 0 = classic single-pass)
  
  eventDriven?: {
    enabled?: boolean           // default: false
    maxReactiveRate?: number    // max reactive ticks per minute (default: 10)
    urgentBypass?: boolean      // urgent events bypass rate limiting (default: true)
  }

  cognitiveMode?: {
    enabled?: boolean           // default: false
    modelMap?: Record<CognitiveMode, string>  // custom model per mode (overrides COGNITIVE_MODE_MODELS)
    modes?: Partial<Record<CognitiveMode, {
      systemPrompt?: string     // custom system prompt for this mode
      memoryStrategy?: 'full' | 'recent' | 'contextual'
      responseStyle?: 'detailed' | 'concise' | 'interactive'
    }>>
  }

  learning?: {
    enabled?: boolean           // default: true
    selfPerception?: boolean    // default: true
    crystallization?: boolean   // default: true
    antiGoodhart?: boolean      // default: true
  }
}
