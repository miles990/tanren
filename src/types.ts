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

export interface ChatResult {
  response: string            // from action:respond, or empty if no response
  thought: string             // full LLM output
  actions: string[]           // action types executed
  duration: number            // ms
  quality: number             // observation quality 1-5
  // Structured metadata — any agent or human can programmatically understand what happened
  meta?: {
    mode: string              // context mode (research/interaction/execution/verification)
    filesRead: string[]       // files the agent read this tick
    filesWritten: string[]    // files the agent wrote/edited this tick
    toolsUsed: string[]       // unique tool types called
    hypotheses: number        // active hypotheses in working memory
    contextChars: number      // total context size used
  }
}

/** Risk tier for graduated action handling.
 *  Tier 1: Safe/read-only — skip feedback entirely
 *  Tier 2: Moderate/additive — execute + log, no verification round
 *  Tier 3: High-risk/destructive — full feedback loop */
export type RiskTier = 1 | 2 | 3

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
  remember(content: string, opts?: { topic?: string; tickCount?: number }): Promise<void>
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
  /**
   * Generate a response from the LLM.
   *
   * **Semantic contract — MUST be honored by every provider:**
   *
   * - `context` → the **user message layer**. What the agent is seeing right
   *   now: perception output, working memory digest, task description, incoming
   *   messages. Goes to the `user` role / stdin / prompt body.
   *
   * - `systemPrompt` → the **identity layer**. Who the agent IS: its soul,
   *   cognitive framework, behavioral constraints, hard limits. MUST be routed
   *   to the backend's native system-prompt mechanism:
   *     • Anthropic API:  `system` field on messages.create
   *     • OpenAI API:     `role: 'system'` message
   *     • Claude CLI:     `--system-prompt` (override) or `--append-system-prompt` (inherit)
   *     • Agent SDK:      `options.systemPrompt` as plain string (override) or
   *                       `{type:'preset', preset:'claude_code', append}` (inherit)
   *     • Local models:   the model's equivalent system role
   *
   * **DO NOT concatenate `systemPrompt` into `context`.** That demotes the
   * agent's identity to user input — the model's attention treats it as data
   * instead of framing. This was the root cause of the "agent wearing Claude
   * Code's skin" bug and led to identity-layer pollution across the
   * harness-wrapping providers (claude-cli, agent-sdk) while the pure-API
   * providers (anthropic, openai) happened to get it right.
   *
   * **Tanren's philosophy on identity (for harness-wrapping providers):** by
   * default the agent's identity should OVERRIDE Claude Code's preset, not
   * append to it. Tanren's mission is for its agents to surpass Claude Code,
   * not wear its skin. Providers that wrap a Claude Code harness (claude-cli,
   * agent-sdk) expose an `identityMode` option — default is `'override'`;
   * `'inherit-claude-code'` is an explicit opt-in for agents that want to
   * inherit Claude Code's persona and tool-use tuning.
   */
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
  tickCount?: number  // current tick number for temporal tagging
  workingMemory?: import('./working-memory.js').WorkingMemorySystem
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
  /** Directory containing skill .md files — loaded dynamically based on context mode + keywords.
   *  Claude Code pattern: specialized cognitive modules injected per task type. */
  skillsDir?: string
  /** Lifecycle hooks — automate mechanical patterns (e.g., auto-clear-inbox after respond).
   *  Claude Code pattern: cognitive budget goes to thinking, not bookkeeping. */
  hooks?: import('./hooks.js').Hook[]

  /** Callback when an action starts/completes — for live progress display */
  onActionProgress?: (event: { phase: 'start' | 'done' | 'error'; action: Action; result?: string; error?: string }) => void

  tickInterval?: number         // ms between ticks (default: 60000)
  maxConcurrentDelegations?: number  // default: 4
  feedbackRounds?: number        // action feedback rounds per tick (default: 1, 0 = classic single-pass)
  /** Context budget in chars for feedback loop. When accumulated conversation exceeds this,
   *  force synthesis with existing data instead of reading more. Prevents O(n²) context bloat.
   *  Default: 50000 chars (~3-4 file reads). */
  contextBudget?: number
  /** Disable read-only tool degradation after round 0. Default: true (degrade).
   *  Set false for capable models (Sonnet 4.6+) that can self-regulate read depth. */
  toolDegradation?: boolean
  
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

  /**
   * Default objective injected into scheduled autonomous ticks when there is
   * no pendingMessage. Without this, the model gets full perception + all
   * tools but NO "what to do this tick" signal, and defaults to safe low-effort
   * actions like `remember` (empirically observed: 10+ consecutive remember-only
   * ticks in Akari's production run at 2026-04-08). Claude Code does not have
   * this problem because every interaction has an explicit user objective.
   *
   * When set, scheduled ticks with no message use this string as a synthetic
   * message, routing through the normal message path (mode classification,
   * tool filter, cognitive guidance). When unset, the framework injects a
   * reasonable default (see DEFAULT_AUTONOMOUS_OBJECTIVE in loop.ts).
   *
   * Override this to tailor the objective to your agent's specific domain.
   */
  autonomousObjective?: string
}
