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

import { writeFileSync, readFileSync, appendFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  TanrenConfig,
  TickResult,
  Action,
  GateContext,
  LLMProvider,
  ToolUseLLMProvider,
  SessionAwareLLMProvider,
  ConversationMessage,
  EventTrigger,
  TriggerEvent,
  TickMode,
  CognitiveContext,
} from './types.js'
import { createMemorySystem } from './memory.js'
import { createClaudeCliProvider } from './llm/claude-cli.js'
import { createPlanSystem } from './plans.js'
import { createActionHealthTracker } from './action-health.js'
import { createMPL } from './metacognitive.js'
import { createContinuationSystem } from './continuation.js'
import { createPerception, type PerceptionSystem } from './perception.js'
import { createGateSystem, defaultGates, type GateSystem } from './gates.js'
import { createActionRegistry, builtinActions, getRoundRiskTier, type ActionRegistry } from './actions.js'
import { createLearningSystem, type LearningSystem } from './learning/index.js'
import { createEvolutionEngine } from './evolution.js'
import { executeBatch } from './action-batch.js'
import { createContextMesh, createMeshPerception, createMeshAction } from './context-mesh.js'
import { groundQuestion } from './socratic.js'
import { createCognitiveModeDetector, buildCognitiveModePrompt, COGNITIVE_MODE_MODELS, type CognitiveModeDetector } from './cognitive-modes.js'
import { createWorkingMemory, type WorkingMemorySystem } from './working-memory.js'
import { detectContextMode, type ContextModeConfig } from './context-modes.js'
import { loadSkills, selectSkills, formatSkillsForPrompt } from './skills.js'
import { createHookSystem } from './hooks.js'
import {
  loadIdentity,
  buildContext,
  buildSystemPrompt,
  buildToolUseSystemPrompt,
  extractMessageContent,
  createEmptyObservation,
  parseToolUseResponse,
  buildAssistantContent,
} from './prompt-builder.js'
import { runToolUseFeedbackLoop, runTextFeedbackLoop } from './feedback-loop.js'

// currentContextMode is now loop-local (inside createLoop closure).
// Previously module-level — caused shared state between agents in same process.

// === Checkpoint for crash recovery ===

interface Checkpoint {
  tickStarted: number
  perception: string
}

// === Event Detection System ===

interface TriggerState {
  trigger: EventTrigger
  lastRun: number
  pendingEvent: TriggerEvent | null
}

// === Agent Loop ===

export interface AgentLoop {
  tick(mode?: TickMode, triggerEvent?: TriggerEvent): Promise<TickResult>
  /** Inject a message for the next tick — perception will include it */
  injectMessage(from: string, text: string): void
  /** Set/clear LLM streaming callback — streams text chunks during think phase */
  setStreamCallback(fn: ((text: string) => void) | null): void
  /** Run a self-paced chain — agent decides when to stop.
   *  `wallClockMs`: wall-clock cap across all ticks (default: no cap). */
  runChain(opts?: { wallClockMs?: number; onTick?: (result: TickResult, tickNum: number) => void | Promise<void> }): Promise<TickResult[]>
  start(interval?: number): void
  stop(): void
  isRunning(): boolean
  getRecentTicks(): TickResult[]
  getCurrentMode(): string
  setSessionId(id: string | null): void
  getSessionId(): string | null
}

/**
 * Default objective injected into scheduled autonomous ticks that arrive
 * without a pendingMessage. This is the framework's answer to the "agent
 * without goal" failure mode: when there's no user/system caller, the model
 * has full perception + all tools but no "what to do" signal, and defaults
 * to safe low-effort actions (empirically: 10+ consecutive remember-only
 * ticks observed in Akari production at 2026-04-08).
 *
 * Claude Code doesn't have this problem because every interaction has an
 * explicit user objective. Tanren synthesizes the user role here for
 * autonomous ticks so the same mode classification + tool filter + cognitive
 * guidance machinery that makes /chat work also makes autonomous work.
 *
 * Agents can override via `config.autonomousObjective` to tailor the
 * objective to their specific domain.
 */
export const DEFAULT_AUTONOMOUS_OBJECTIVE = `[autonomous-tick]
This is a scheduled autonomous tick (no human caller). Your job is to make CONCRETE PROGRESS, not to remember or reflect on what you've seen.

Action priority (do the FIRST one that applies — only ONE concrete action per tick):

1. **memory/inbox/ has *.md files?** → Read the highest-priority one (P0 > P1 > P2). Process it to completion: do the RCA, write the decision, ship a brief to memory/outbox/ with a meaningful filename. Then move the inbox file to memory/inbox/processed/.

2. **memory/outbox/ has a recent brief that needs cross-agent discussion?** → Use whatever cross-agent tools you have available (mcp__agent__agent_ask for sync quick questions, mcp__agent__agent_discuss for deeper discussion, or file-based messages/to-*.md). Don't write another brief on the same topic — have the discussion directly.

3. **NEXT.md or an active topic in memory/topics/ has stale or in-progress work?** → Pick ONE item and advance it concretely: write code via shell action, edit a file, run a verification, draft a commit, anything that produces visible output.

4. **Genuinely nothing pending?** → Check the state of your collaborators (via whatever tools you have). If a collaborator is stuck or has open issues you can help with, reach out.

FORBIDDEN this tick (these mark the tick as FAILED):
- ❌ Standalone remember action (only OK when attached to a concrete output from items 1-4)
- ❌ Standalone reflect action (only OK AFTER producing a concrete output)
- ❌ "I'll continue next tick" — do it THIS tick, that's why the autonomous loop exists
- ❌ Reading perception or memory without then acting on it

If your output for this tick is just remember/reflect with no inbox processed / outbox written / MCP call / file or code change, the tick has wasted the cycle. Pick ONE concrete action from the priority list and finish it.`

export function createLoop(config: TanrenConfig): AgentLoop {
  const memory = createMemorySystem(config.memoryDir, config.searchPaths)
  const llm: LLMProvider = config.llm ?? createClaudeCliProvider()
  const perception = createPerception(config.perceptionPlugins ?? [])
  const gateSystem = createGateSystem(config.gates ?? defaultGates())
  const actionRegistry = createActionRegistry()

  // Built-in: recent memory perception — tail of memory.md (constant size).
  const memoryMdPath = join(config.memoryDir, 'memory.md')
  if (existsSync(memoryMdPath) || existsSync(config.memoryDir)) {
    perception.register({
      name: 'recent-memory',
      category: 'memory',
      fn: () => {
        if (!existsSync(memoryMdPath)) return ''
        const raw = readFileSync(memoryMdPath, 'utf-8')
        return raw.slice(-2000)
      },
    })
  }

  // Built-in: topic memory perception — loads recent topics, respects maxTopics from context mode.
  // Replaces user-land topic plugins that loaded ALL topics regardless of mode.
  // Pull-based: only loads what the mode needs, sorted by recency (mtime).
  const topicsDir = join(config.memoryDir, 'topics')
  if (existsSync(topicsDir)) {
    perception.register({
      name: 'topic-memories',
      category: 'memory',
      fn: () => {
        const files = readdirSync(topicsDir).filter(f => f.endsWith('.md'))
        if (files.length === 0) return ''

        // Sort by modification time (most recent first)
        const withMtime = files.map(f => {
          try {
            return { name: f, mtime: statSync(join(topicsDir, f)).mtimeMs }
          } catch {
            return { name: f, mtime: 0 }
          }
        }).sort((a, b) => b.mtime - a.mtime)

        // Respect maxTopics from current context mode (ghost feature → real feature)
        const mode = currentContextMode
        const limit = mode?.maxTopics ?? 10  // default 10 if no mode detected yet
        const selected = withMtime.slice(0, limit)

        const sections = selected.map(({ name }) => {
          try {
            const content = readFileSync(join(topicsDir, name), 'utf-8')
            return `--- ${name} ---\n${content.slice(-1000)}`
          } catch {
            return ''
          }
        }).filter(Boolean)

        if (sections.length === 0) return ''
        const skipped = files.length - selected.length
        const suffix = skipped > 0 ? `\n\n(${skipped} older topics available via search)` : ''
        return sections.join('\n\n') + suffix
      },
    })
  }

  // Loop-local context mode — per agent instance, not module-level
  let currentContextMode: ContextModeConfig | null = null

  // In-process message queue for chat() — consumed once per tick
  let pendingMessage: { from: string; text: string } | null = null
  let hadMessageThisTick = false  // behavioral floor: track if this tick had a message
  // Last response from action:respond — extracted per tick
  let lastResponse = ''

  // Cognitive mode detector (if enabled)
  const cognitiveModeEnabled = config.cognitiveMode?.enabled ?? false
  const cognitiveModeDetector: CognitiveModeDetector | null = cognitiveModeEnabled
    ? createCognitiveModeDetector()
    : null

  // Register built-in + user actions
  for (const handler of builtinActions) {
    actionRegistry.register(handler)
  }
  // Built-in respond action — stores response in-process for chat()
  // Semantic: FINAL answer to the caller, not running commentary.
  // A later respond overwrites earlier ones in the same chain, so writing
  // respond early with "I'll do X" and then doing work leaves the caller
  // with the stale "I'll do X" message. Use focus/reflect for progress;
  // use respond once, at the end, with actual results.
  if (!config.actions?.some(a => a.type === 'respond')) {
    actionRegistry.register({
      type: 'respond',
      description: 'Your FINAL answer to the caller. Ends the conversation turn. Rules: (1) write ONCE per chain, at the end, after all work is done. (2) Must summarize actual results, not intentions — "I did X, found Y" not "I will do X". (3) For progress updates during work, use `focus` or `reflect`, NOT respond. (4) Writing respond signals "task complete" to the framework — a later tick can still happen, but any later respond overwrites this one.',
      toolSchema: {
        properties: { content: { type: 'string', description: 'Final answer — actual results, not plans. Summarize what you did and what you found.' } },
        required: ['content'],
      },
      async execute(action) {
        const text = (action.input?.content as string) ?? action.content
        lastResponse = text
        return 'Response sent.'
      },
    })
  }
  // Built-in delegate action — sub-agent pattern from Claude Code.
  // Spawns a focused LLM call with minimal context (identity + task only).
  // Result returns to main tick as tool_result — main context stays clean.
  // Key: delegate's internal reasoning doesn't pollute the main conversation.
  actionRegistry.register({
    type: 'delegate',
    description: 'Delegate a focused sub-task to a separate LLM call with timeout and stall detection. The sub-task runs with clean context (identity + your prompt only). Returns a concise result or timeout notice.',
    toolSchema: {
      properties: {
        task: { type: 'string', description: 'Clear, focused task description. Include file paths if needed.' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait (default: 60). Prevents stalled delegates from blocking the tick.' },
      },
      required: ['task'],
    },
    async execute(action, context) {
      const task = (action.input?.task as string) ?? action.content.trim()
      if (!task) return '[delegate error: empty task]'
      const timeoutSec = (action.input?.timeout_seconds as number) ?? 60

      const startTime = Date.now()
      console.error(`[delegate] Starting: "${task.slice(0, 80)}..." (timeout: ${timeoutSec}s)`)

      try {
        const identity = await loadIdentity(config.identity, context.memory)
        const subPrompt = `You are a focused research assistant. Complete this task concisely (max 500 words):\n\n${task}`
        const subSystem = `${identity}\n\nYou have access to the filesystem. Be precise and cite line numbers when referencing code.`

        // Race: LLM call vs timeout — stalled delegates never block the parent
        const result = await Promise.race([
          llm.think(subPrompt, subSystem),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error(`Delegate stalled: no response after ${timeoutSec}s`)), timeoutSec * 1000)
          ),
        ])

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.error(`[delegate] Completed in ${elapsed}s (${result.length} chars)`)
        return result.slice(0, 4000)
      } catch (err: unknown) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[delegate] Failed after ${elapsed}s: ${msg.slice(0, 100)}`)
        return `[delegate ${elapsed}s: ${msg.slice(0, 300)}]`
      }
    },
  })

  if (config.actions) {
    for (const handler of config.actions) {
      actionRegistry.register(handler)
    }
  }

  // Injected message perception — consumed once per tick
  // Socratic grounding: abstract questions get enriched with concrete context
  perception.register({
    name: 'injected-message',
    category: 'input',
    fn: () => {
      if (!pendingMessage) return ''
      const { from, text } = pendingMessage
      pendingMessage = null  // consume
      const grounded = groundQuestion(text, config.memoryDir)
      return `<message from="${from}">\n${grounded}\n</message>`
    },
  })

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
  const liveStatusPath = join(config.memoryDir, 'state', 'live-status.json')

  const workingMemoryPath = join(config.memoryDir, 'state', 'working-memory.json')
  const workingMemory = createWorkingMemory(workingMemoryPath)

  // Evolution engine — agent self-evolution via pattern detection
  const evolution = createEvolutionEngine(join(config.memoryDir, 'state'))

  // Causal Context Mesh — unified dependency/causality/threading/question tracking
  const contextMesh = createContextMesh(config.memoryDir)
  perception.register(createMeshPerception(contextMesh))
  actionRegistry.register(createMeshAction(contextMesh))

  // Plan system — continuation management across ticks
  const planSystem = createPlanSystem(config.memoryDir, workDir)
  for (const plugin of planSystem.perceptionPlugins) {
    perception.register(plugin)
  }
  for (const handler of planSystem.actions) {
    actionRegistry.register(handler)
  }

  // Action health tracker — deterministic success/failure data for agent perception
  const actionHealth = createActionHealthTracker(join(config.memoryDir, 'state'))
  perception.register(actionHealth.getPerceptionPlugin())
  const hookSystem = createHookSystem(config.hooks ?? [])

  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let eventTimer: ReturnType<typeof setTimeout> | null = null
  let tickCount = 0

  // Mutable state — updated each tick, exposed via MPL
  let currentComplexity = ''
  let currentContextModeName = ''
  let currentMaxFeedbackRounds = 0

  // Self-paced continuation — agent decides when to stop
  const continuation = createContinuationSystem(config.memoryDir)
  perception.register(continuation.getChainPerception())

  // Metacognitive Perception Layer — let agent see its own thinking (Akari's design)
  const mpl = createMPL(config.memoryDir, {
    actions: () => actionRegistry.types(),
    plugins: () => perception.getPluginNames(),
    gates: () => gateSystem.getGateNames(),
    feedbackRounds: () => currentMaxFeedbackRounds,
    tickMode: () => running ? 'autonomous' : 'manual',
    learning: () => ({
      selfPerception: config.learning?.selfPerception ?? true,
      crystallization: config.learning?.crystallization ?? true,
      antiGoodhart: config.learning?.antiGoodhart ?? true,
    }),
    llmModel: () => {
      if ('activeModel' in llm) return (llm as { activeModel?: string }).activeModel ?? 'unknown'
      return 'claude-cli'
    },
    maxTokens: () => 8192,
  })
  for (const plugin of mpl.getPerceptionPlugins()) {
    perception.register(plugin)
  }
  actionRegistry.register(mpl.getReflectAction())

  // Event-driven system state
  const eventDrivenEnabled = config.eventDriven?.enabled ?? false
  const maxReactiveRate = config.eventDriven?.maxReactiveRate ?? 10
  const urgentBypass = config.eventDriven?.urgentBypass ?? true
  
  const triggerStates: TriggerState[] = (config.eventTriggers ?? []).map(trigger => ({
    trigger,
    lastRun: 0,
    pendingEvent: null,
  }))
  
  let reactiveTickCount = 0
  let reactiveTickWindowStart = Date.now()
  const reactiveWindowMs = 60_000 // 1 minute

  // Cognitive mode system  
  let lastInteractionTime = 0

  // Initialize tick count from existing ticks
  try {
    const ticksDir = join(journalDir, 'ticks')
    if (existsSync(ticksDir)) {
      tickCount = readdirSync(ticksDir).filter(f => f.endsWith('.md')).length
    }
  } catch { /* start from 0 */ }

  function writeLiveStatus(status: Record<string, unknown>): void {
    try {
      writeFileSync(liveStatusPath, JSON.stringify({ ...status, ts: Date.now() }), 'utf-8')
    } catch { /* best effort */ }
  }

  // Write initial idle status
  writeLiveStatus({ phase: 'idle', tickNumber: tickCount, running: false })

  // Load persistent gate state
  const gateState = loadGateState(gateStatePath)

  // ─── Pre-routing: classify message complexity BEFORE LLM call (0ms, pure code) ───
  // Decides: how much context to send, which tools to include
  type TickComplexity = 'minimal' | 'standard' | 'full'

  function classifyComplexity(messageContent: string): TickComplexity {
    const msg = messageContent.toLowerCase()
    // Minimal: greetings, simple questions, short messages
    if (msg.length < 30 && /^(hi|hello|hey|你好|早|嗨|thanks|謝|ok|好|yes|no|對|不)/.test(msg)) return 'minimal'
    if (msg.length < 80 && !/\b(edit|fix|implement|create|build|research|分析|研究|修|改|做|寫|查)\b/i.test(msg)) return 'minimal'
    // Full: explicit tool-requiring tasks
    if (/\b(edit|fix|implement|create|build|deploy|git|shell|commit|push|refactor)\b/i.test(msg)) return 'full'
    if (/\b(研究|分析|修改|實作|建|部署|重構)\b/.test(msg)) return 'full'
    return 'standard'
  }

  // Tool sets by complexity
  const MINIMAL_TOOLS = new Set(['respond', 'remember', 'clear-inbox'])
  const STANDARD_TOOLS = new Set(['respond', 'remember', 'clear-inbox', 'search', 'web_fetch', 'read'])

  async function tick(mode: TickMode = 'scheduled', triggerEvent?: TriggerEvent): Promise<TickResult> {
    const tickStart = Date.now()
    tickCount++
    const filesRead = new Set<string>()  // per-tick file tracking for read-before-edit enforcement
    lastResponse = ''  // reset per tick

    // Autonomous objective injection: scheduled ticks without a pendingMessage
    // get a synthetic "what to do this tick" objective so the model has a clear
    // signal to act on. Without this, perception + full tool surface + zero
    // goal → model defaults to safe remember/reflect actions and stalls.
    // See DEFAULT_AUTONOMOUS_OBJECTIVE JSDoc for the failure mode this fixes.
    // Agents can override via config.autonomousObjective. Reactive ticks keep
    // their triggerEvent-based path untouched.
    if (mode === 'scheduled' && pendingMessage === null) {
      const objective = config.autonomousObjective ?? DEFAULT_AUTONOMOUS_OBJECTIVE
      pendingMessage = { from: 'autonomous-loop', text: objective }
    }

    hadMessageThisTick = pendingMessage !== null
    mpl.setRecentTicks(recentTicks)  // inject history for cognitive state perception
    mpl.preTick()  // snapshot state for diff
    writeLiveStatus({ phase: 'perceive', tickStart, tickNumber: tickCount, running })

    // Load and decay working memory
    workingMemory.load()
    workingMemory.decay(tickCount)

    // 1. Perceive — filtered by context mode (Claude Code pattern: context is scarce)
    // Read pending message BEFORE perception consumes it (injected-message plugin sets pendingMessage = null).
    // Detect mode from message text, filter perception categories accordingly.
    const preMessage = pendingMessage?.text ?? ''
    const preMode = preMessage
      ? detectContextMode(preMessage, workingMemory.getState().currentFocus)
      : null
    // Mode determines structure (which categories), complexity adjusts scale — orthogonal.
    // Use mode directly for category filtering. Mode already handles greetings (interaction mode).
    const effectiveCategories = preMode?.perceptionCategories?.length
      ? preMode.perceptionCategories
      : undefined  // no message or research mode = load all
    const preComplexity = classifyComplexity(preMessage)
    const perceptionOutput = await perception.perceive(
      effectiveCategories ? { categories: effectiveCategories } : undefined
    )
    console.error(`[tanren] PERCEPTION: ${perceptionOutput.length} chars, mode=${preMode?.mode ?? 'none'}, complexity=${preComplexity}, categories=${effectiveCategories?.join(',') ?? 'all'}`)
    writeCheckpoint(checkpointPath, { tickStarted: tickStart, perception: perceptionOutput })

    // Pre-route: classify message complexity (0ms)
    const messageContent = extractMessageContent(perceptionOutput)
    const complexity = classifyComplexity(messageContent)
    currentComplexity = complexity

    // Detect context mode (0ms — orthogonal to complexity)
    currentContextMode = detectContextMode(messageContent, workingMemory.getState().currentFocus)
    currentContextModeName = currentContextMode.mode
    console.error(`[tanren] MODE: ${currentContextMode.mode} — ${currentContextMode.description}`)

    // 2. Build context — scaled by complexity
    const identity = await loadIdentity(config.identity, memory)
    const gateWarnings = gateSystem.getWarnings()
    const learningContext = learning?.getContextSection(recentTicks) ?? ''
    const evolutionContext = evolution.getPerceptionSection()
    const wmContext = workingMemory.toContextString()
    let context: string
    if (complexity === 'minimal') {
      // Minimal: just identity + message, skip heavy perception
      context = `${identity}\n\n<message>\n${messageContent}\n</message>\n\nRespond briefly (1-3 sentences max).`
    } else {
      const baseContext = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext + (evolutionContext ? '\n' + evolutionContext : ''))
      context = wmContext
        ? `<working-memory>\n${wmContext}\n</working-memory>\n\n${baseContext}`
        : baseContext
    }

    // ── Context Budget Tracking (Claude Code pattern: context is scarce) ──
    // Measure each component's contribution to total context.
    // Auto-trim if exceeding budget. Surface metrics for agent self-awareness.
    const contextBudget = {
      perception: perceptionOutput.length,
      identity: identity.length,
      workingMemory: wmContext?.length ?? 0,
      learning: learningContext.length + (evolutionContext?.length ?? 0),
      gates: gateWarnings.join('\n').length,
      total: context.length,
    }
    const CONTEXT_BUDGET_WARN = 80_000   // chars — warn agent
    const CONTEXT_BUDGET_TRIM = 120_000  // chars — auto-trim perception

    if (contextBudget.total > CONTEXT_BUDGET_TRIM && effectiveCategories === undefined) {
      // Over hard budget with full perception — re-perceive with focused categories
      const trimmedPerception = await perception.perceive({ categories: ['environment', 'input'] })
      const trimmedBase = buildContext(identity, trimmedPerception, gateWarnings, memory, learningContext + (evolutionContext ? '\n' + evolutionContext : ''))
      context = wmContext
        ? `<working-memory>\n${wmContext}\n</working-memory>\n\n${trimmedBase}`
        : trimmedBase
      contextBudget.perception = trimmedPerception.length
      contextBudget.total = context.length
      console.error(`[tanren] BUDGET: auto-trimmed perception ${perceptionOutput.length} → ${trimmedPerception.length} chars (total: ${contextBudget.total})`)
    } else if (contextBudget.total > CONTEXT_BUDGET_WARN) {
      console.error(`[tanren] BUDGET: warning — ${contextBudget.total} chars approaching limit (perception: ${contextBudget.perception})`)
    }

    const prepTime = Date.now() - tickStart
    console.error(`[tanren] CONTEXT: ${contextBudget.total} chars — perception:${contextBudget.perception} identity:${contextBudget.identity} wm:${contextBudget.workingMemory} learning:${contextBudget.learning} | prep:${prepTime}ms`)

    // 3. Think (LLM call) with cognitive mode detection
    writeLiveStatus({ phase: 'think', tickStart, tickNumber: tickCount, running, perceptionBytes: contextBudget.perception })

    // Detect cognitive mode if enabled
    let cognitiveContext: CognitiveContext | null = null
    if (cognitiveModeDetector) {
      const lastTick = recentTicks.length > 0 ? recentTicks[recentTicks.length - 1] : null
      const timeGap = lastTick ? tickStart - lastTick.timestamp : 0
      cognitiveContext = cognitiveModeDetector.detectMode(mode, triggerEvent, timeGap, messageContent)
      const modelMap = config.cognitiveMode?.modelMap ?? COGNITIVE_MODE_MODELS
      if ('activeModel' in llm) {
        (llm as { activeModel?: string }).activeModel = modelMap[cognitiveContext.mode]
      }
    }

    const baseSystemPrompt = buildSystemPrompt(identity, actionRegistry)
    // Inject mode-specific cognitive guidance — teaches HOW to think, not just WHAT tools to use.
    // Three layers of forging: perception (what you see) → tools (what you can do) → guidance (how you think)
    const modeGuidance = preMode?.cognitiveGuidance ?? ''
    // Skill loading — dynamic cognitive modules matched by mode + keywords (Claude Code pattern)
    const allSkills = config.skillsDir ? loadSkills(config.skillsDir) : []
    const activeSkills = allSkills.length > 0 && preMode
      ? selectSkills(allSkills, preMode.mode, preMessage)
      : []
    const skillsPrompt = formatSkillsForPrompt(activeSkills)
    if (activeSkills.length > 0) {
      console.error(`[tanren] SKILLS: loaded ${activeSkills.map(s => s.name).join(', ')} for mode=${preMode?.mode}`)
    }
    const promptWithGuidance = `${baseSystemPrompt}${modeGuidance ? `\n\n${modeGuidance}` : ''}${skillsPrompt}`
    const systemPrompt = cognitiveContext
      ? buildCognitiveModePrompt(identity, cognitiveContext, promptWithGuidance.split('\n\n## Available Actions')[1] || '')
      : promptWithGuidance

    let thought: string
    let structuredActions: Action[] | null = null

    // Always use tool_use when available — agent decides which tools to call.
    const useToolUse = isToolUseProvider(llm)

    // Detect if there's a message to respond to (from any source: in-process or file inbox)
    const hasIncomingMessage = hadMessageThisTick || messageContent.length > 0

    if (useToolUse) {
      // Mode-aware tool selection — different modes get different tools.
      // Claude Code pattern: tools shape cognition. Giving all tools = no guidance.
      // interaction: respond-focused (skip heavy research tools)
      // execution: action-focused (respond, write, edit, shell)
      // research: full toolset (grep, read, explore, delegate, search)
      // verification: read + search focused
      const MODE_TOOLS: Record<string, Set<string> | null> = {
        interaction: new Set(['respond', 'remember', 'clear-inbox', 'search']),
        execution: new Set(['respond', 'remember', 'write', 'edit', 'shell', 'clear-inbox']),
        research: null,    // all tools
        verification: null, // all tools
      }
      const modeToolFilter = preMode ? MODE_TOOLS[preMode.mode] ?? null : null
      // Config-registered custom actions always bypass mode filter
      const customActionNames = new Set(config.actions?.map(a => a.type) ?? [])
      const allToolDefs = actionRegistry.toToolDefinitions()
      let toolDefs = modeToolFilter
        ? allToolDefs.filter(t => modeToolFilter.has(t.name) || customActionNames.has(t.name))
        : allToolDefs
      // Research-first: exclude respond from initial round when there's a message
      if (hasIncomingMessage && !modeToolFilter) {
        toolDefs = toolDefs.filter(t => t.name !== 'respond')
      }

      const baseToolSystemPrompt = buildToolUseSystemPrompt(identity)
      const toolSystemPrompt = cognitiveContext
        ? buildCognitiveModePrompt(identity, cognitiveContext, baseToolSystemPrompt.split('\n\n## Instructions')[1] || '')
        : baseToolSystemPrompt
      const messages: ConversationMessage[] = [{ role: 'user', content: context }]

      try {
        const llmStart = Date.now()
        const response = await llm.thinkWithTools(messages, toolSystemPrompt, toolDefs)
        console.error(`[tanren] LLM: ${Date.now() - llmStart}ms (tool-use, ${contextBudget.total} chars context)`)
        const parsed = parseToolUseResponse(response, actionRegistry)
        thought = parsed.thought
        structuredActions = parsed.actions
        // Store conversation for multi-turn feedback loop
        messages.push({ role: 'assistant', content: response.content })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        thought = `[LLM error: ${msg}]`
      }
    } else {
      // Text-based path (CLI provider) — LLM uses <action:type> tags
      try {
        const llmStart = Date.now()
        thought = await llm.think(context, systemPrompt)
        console.error(`[tanren] LLM: ${Date.now() - llmStart}ms (text, ${contextBudget.total} chars context)`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        thought = `[LLM error: ${msg}]`
      }
    }

    // 4. Parse actions (structured from tool use, or parsed from text)
    // Constraint Texture: if model returned 0 tool_use blocks but thought has text tags,
    // fall back to text parsing. Empty array ≠ null — [] means "tried tools, used none".
    const actions = (structuredActions && structuredActions.length > 0)
      ? structuredActions
      : actionRegistry.parse(thought)

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
      // 6. Execute actions (with feedback mini-loop)
      writeLiveStatus({ phase: 'act', tickStart, tickNumber: tickCount, running, actionCount: actions.length, actionTypes: actions.map(a => a.type) })
      let actionsExecuted = 0
      let actionsFailed = 0
      const actionResults: string[] = []
      const allActions = [...actions]

      // Execute initial actions via ActionBatch (parallel reads, sequential writes)
      const initialBatch = await executeBatch(
        actions,
        { execute: (action, ctx) => actionRegistry.execute(action, ctx) },
        { memory, workDir, tickCount, workingMemory, filesRead },
        (event) => {
          config.onActionProgress?.(event)
          if (event.phase === 'done') actionHealth.record(event.action.type, true, tickCount)
          else if (event.phase === 'error') actionHealth.record(event.action.type, false, tickCount, event.error)
        },
      )
      actionsExecuted += initialBatch.executed
      actionsFailed += initialBatch.failed
      actionResults.push(...initialBatch.results)

      // Fire postAction hooks — auto-execute follow-up actions (e.g., auto-clear-inbox)
      for (let i = 0; i < actions.length; i++) {
        const hookActions = hookSystem.run('postAction', {
          tickCount, action: actions[i], result: initialBatch.results[i], allActions,
        }, actions[i].type)
        for (const ha of hookActions) {
          if (actionRegistry.has(ha.type)) {
            try {
              await actionRegistry.execute(ha, { memory, workDir, tickCount, workingMemory, filesRead })
              allActions.push(ha)
              actionsExecuted++
            } catch { /* hook actions are best-effort */ }
          }
        }
      }

      // Convergence Condition: feedback needed if model hasn't produced useful output yet.
      // Behavior-driven, not keyword-driven — look at what the model DID, not what the user SAID.
      const roundRisk = getRoundRiskTier(actions)
      const initialHadNoTools = actions.length === 0
      const initialRespondContent = actions.find(a => a.type === 'respond')?.content ?? ''
      // Never skip feedback when there's a message — respond was excluded from initial tools
      // and needs at least 1 feedback round to be delivered.
      const skipFeedback = hasIncomingMessage ? false
        : (!initialHadNoTools && roundRisk === 1 && actionsFailed === 0)
        || initialRespondContent.length > 300

      // Dynamic cognitive budget: framework observes environmental signals to decide
      // when to stop, rather than using a fixed number. config.feedbackRounds is now
      // a ceiling (safety net), not a target. The loop exits early when:
      //   - No novel actions (repetition detected)
      //   - Idle threshold exceeded (model stopped calling tools)
      //   - Production convergence (synthesize threshold hit)
      // This gives weak models more room and strong models less waste.
      const providerSkipsFeedback = isSessionAwareProvider(llm) && llm.skipFeedbackLoop
      const configMax = providerSkipsFeedback ? 0 : (config.feedbackRounds ?? 10)
      const maxFeedbackRounds = providerSkipsFeedback ? 0
        : skipFeedback ? 0
        : initialHadNoTools ? Math.max(configMax, 2)  // No tools yet → at least 2 rounds
        : configMax                                     // Environmental signals handle the rest
      currentMaxFeedbackRounds = maxFeedbackRounds

      if (useToolUse && structuredActions !== null) {
        // Native tool_use multi-turn feedback loop (see feedback-loop.ts)
        const degradeTools = config.toolDegradation !== false
        const CONTEXT_BUDGET = config.contextBudget ?? 50_000

        const loopResult = await runToolUseFeedbackLoop(
          {
            maxRounds: maxFeedbackRounds,
            contextBudget: CONTEXT_BUDGET,
            degradeTools,
            hasIncomingMessage,
            preMode,
          },
          actions,
          actionResults,
          thought,
          context,
          llm as ToolUseLLMProvider,
          actionRegistry,
          { memory, workDir, tickCount, workingMemory, filesRead },
          identity,
          (event) => {
            config.onActionProgress?.(event)
          },
          (type, success, tick, error) => actionHealth.record(type, success, tick, error),
          hookSystem,
        )

        thought = loopResult.thought
        allActions.push(...loopResult.actions.slice(actions.length))
        actionResults.push(...loopResult.results.slice(actionResults.length))
        actionsExecuted += loopResult.actionsExecuted
        actionsFailed += loopResult.actionsFailed
      } else {
        // Text-based feedback mini-loop (see feedback-loop.ts)
        const loopResult = await runTextFeedbackLoop(
          maxFeedbackRounds,
          actions,
          actionResults,
          thought,
          context,
          systemPrompt,
          llm,
          actionRegistry,
          { memory, workDir, tickCount, workingMemory, filesRead },
          (type, success, tick, error) => actionHealth.record(type, success, tick, error),
        )

        thought = loopResult.thought
        allActions.push(...loopResult.actions.slice(actions.length))
        actionResults.push(...loopResult.results.slice(actionResults.length))
        actionsExecuted += loopResult.actionsExecuted
        actionsFailed += loopResult.actionsFailed
      }

      // ── Behavioral Floor: code-level guarantees regardless of LLM capability ──
      // Prescription layer: non-negotiable minimums enforced by code.
      // Agent gets autonomy above the floor, not below it.

      // Floor 1: If there's a pending message, must have respond action.
      // If LLM didn't call respond, synthesize from thought + tool results.
      const hasRespond = allActions.some(a => a.type === 'respond')
      if (hasIncomingMessage && !hasRespond) {
        // Gather tool results for synthesis context
        const toolResultsSummary = actionResults
          .map((r, i) => `[${allActions[i]?.type ?? 'action'}]: ${r.slice(0, 1000)}`)
          .filter(r => r.length > 20)
          .join('\n\n')

        let autoResponse = ''

        // If we have tool results, do a focused synthesis call (last-chance LLM call)
        if (toolResultsSummary.length > 100) {
          try {
            const synthPrompt = `You gathered these results:\n\n${toolResultsSummary.slice(0, 4000)}\n\nOriginal question: ${messageContent.slice(0, 500)}\n\nSynthesize a complete, helpful response. Be thorough.`
            const synthResult = await llm.think(synthPrompt, 'You are a research assistant. Respond directly and completely.')
            autoResponse = synthResult.trim()
            console.error(`[floor] Synthesis respond: ${autoResponse.length} chars from ${toolResultsSummary.length} chars of tool results`)
          } catch {
            // Synthesis failed — fall back to thought extraction
            autoResponse = thought.replace(/<action:\w+>[\s\S]*?<\/action:\w+>/g, '').trim()
          }
        } else if (thought.length > 50) {
          // No tool results — extract from thought
          autoResponse = thought.replace(/<action:\w+>[\s\S]*?<\/action:\w+>/g, '').trim()
          console.error(`[floor] Auto-respond from thought: ${autoResponse.length} chars`)
        }

        if (autoResponse.length > 20) {
          try {
            const result = await actionRegistry.execute(
              { type: 'respond', content: autoResponse, raw: autoResponse },
              { memory, workDir, tickCount, workingMemory, filesRead },
            )
            allActions.push({ type: 'respond', content: autoResponse, raw: autoResponse })
            actionResults.push(result)
            actionsExecuted++
          } catch { /* floor best-effort */ }
        }
      }

      // Save working memory after all actions complete
      workingMemory.save()

      // Update tickResult with accumulated data from all rounds
      tickResult.thought = thought
      tickResult.actions = allActions

      // Productive = externally visible or materially changes state.
      // remember/read/search/explore/reflect/focus/clear-inbox are internal — don't count.
      const VISIBLE_OUTPUT_ACTIONS = new Set(['respond', 'write', 'edit', 'append', 'shell', 'synthesize'])
      const hasVisibleOutput = allActions.some(a => VISIBLE_OUTPUT_ACTIONS.has(a.type))

      tickResult.observation = {
        outputExists: hasVisibleOutput,
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

    // Session bridge: auto-capture state for next session (fire-and-forget)
    try {
      const { buildSessionBridge } = await import('./memory.js')
      const bridge = buildSessionBridge(
        workingMemory.getState(),
        tickResult.actions.map(a => a.type),
        tickCount,
      )
      const bridgePath = join(config.memoryDir, 'state', 'session-bridge.json')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(bridgePath, JSON.stringify(bridge, null, 2))
    } catch { /* fire-and-forget */ }

    // Clear checkpoint (tick completed successfully)
    clearCheckpoint(checkpointPath)

    // 8. Learning: observe tick, detect patterns, maybe crystallize
    if (learning) {
      const learningResult = learning.afterTick(tickResult, recentTicks)
      // Update observation quality from learning assessment
      tickResult.observation.outputQuality = learningResult.quality
    }

    // 9. Causal mesh: register this tick as a node
    try {
      const actionTypes = tickResult.actions.map(a => a.type)
      const contextSummary = messageContent.slice(0, 100) || actionTypes.join('→') || 'autonomous tick'
      contextMesh.register(`tick-${tickCount}`, tickCount, contextSummary, actionTypes)
    } catch { /* fire-and-forget */ }

    // 10. Evolution: analyze patterns, propose candidates, validate accepted ones
    try {
      evolution.analyze(tickCount, recentTicks)
      evolution.validate(tickResult)
    } catch { /* fire-and-forget */ }

    // MPL post-tick: serialize results for next tick's perception
    mpl.postTick(tickResult, tickCount)

    // Continuation: record tick in chain if active
    if (continuation.getState().active) {
      continuation.recordTick(tickResult, tickCount)
    }

    // Persist tick to journal (append-only JSONL)
    persistTick(journalDir, tickJournalPath, tickResult)

    // Auto-commit memory changes
    await memory.autoCommit().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      actionHealth.record('memory-commit', false, tickCount, msg)
    })

    // Rotate memory.md if it exceeds size threshold (prevents unbounded growth)
    await memory.rotate().catch(() => { /* best effort */ })

    // Clear gate results for next tick
    gateSystem.clearResults()

    // Update live status
    writeLiveStatus({
      phase: 'idle', tickNumber: tickCount, running,
      lastTick: {
        start: tickStart,
        duration: tickResult.observation.duration,
        actions: tickResult.actions.map(a => a.type),
        quality: tickResult.observation.outputQuality,
        executed: tickResult.observation.actionsExecuted,
        failed: tickResult.observation.actionsFailed,
      },
    })

    return tickResult
  }

  // Event detection helper functions
  async function detectEvents(): Promise<TriggerEvent[]> {
    if (!eventDrivenEnabled || triggerStates.length === 0) return []

    const events: TriggerEvent[] = []
    const now = Date.now()

    for (const state of triggerStates) {
      // Check cooldown
      const cooldown = state.trigger.cooldown ?? 10_000
      if (now - state.lastRun < cooldown) continue

      try {
        const event = await state.trigger.detect()
        if (event) {
          state.pendingEvent = event
          state.lastRun = now
          events.push(event)
        }
      } catch (err) {
        console.warn(`[tanren] trigger ${state.trigger.name} error:`, err)
      }
    }

    return events
  }

  function shouldRunReactiveTick(event: TriggerEvent): boolean {
    if (!eventDrivenEnabled) return false
    
    // Check rate limiting
    const now = Date.now()
    if (now - reactiveTickWindowStart >= reactiveWindowMs) {
      reactiveTickCount = 0
      reactiveTickWindowStart = now
    }

    // Urgent events bypass rate limiting if enabled
    if (event.priority === 'urgent' && urgentBypass) return true
    
    // Check rate limit
    if (reactiveTickCount >= maxReactiveRate) return false
    
    return true
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

    // Event detection loop (if enabled)
    if (eventDrivenEnabled && triggerStates.length > 0) {
      const runEventLoop = async () => {
        if (!running) return
        
        try {
          const events = await detectEvents()
          for (const event of events) {
            if (shouldRunReactiveTick(event)) {
              reactiveTickCount++
              console.log(`[tanren] reactive tick triggered by ${event.source}`)
              await tick('reactive', event)
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[tanren] event detection error: ${msg}`)
        }

        // Schedule next event detection
        if (running) {
          eventTimer = setTimeout(runEventLoop, 1000) // Check events every second
        }
      }

      // Start event loop
      runEventLoop()
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
    if (eventTimer) {
      clearTimeout(eventTimer)
      eventTimer = null
    }
    writeLiveStatus({ phase: 'stopped', tickNumber: tickCount, running: false })
  }

  return {
    tick,
    injectMessage(from: string, text: string) {
      pendingMessage = { from, text }
    },
    setStreamCallback(fn: ((text: string) => void) | null) {
      if ('onStreamText' in llm) {
        (llm as { onStreamText?: ((text: string) => void) | undefined }).onStreamText = fn ?? undefined
      }
    },
    async runChain(opts?: { wallClockMs?: number; onTick?: (result: TickResult, tickNum: number) => void | Promise<void> }): Promise<TickResult[]> {
      const results: TickResult[] = []
      continuation.startChain()
      const chainStart = Date.now()

      while (true) {
        const result = await tick()
        results.push(result)
        if (opts?.onTick) {
          try { await opts.onTick(result, results.length) } catch { /* ignore stream errors */ }
        }

        // Wall-clock cap — bounds total chain duration for sync HTTP callers
        if (opts?.wallClockMs && (Date.now() - chainStart) >= opts.wallClockMs) {
          console.error(`[tanren] Chain tick ${results.length}: stop — wall-clock cap ${opts.wallClockMs}ms reached`)
          break
        }

        const decision = continuation.shouldContinue(result)
        console.error(`[tanren] Chain tick ${results.length}: ${decision.continue ? 'continue' : 'stop'} — ${decision.reason}`)

        if (!decision.continue) break
      }

      continuation.endChain()
      return results
    },
    start,
    stop,
    isRunning: () => running,
    getRecentTicks: () => [...recentTicks],
    getCurrentMode: () => currentContextMode?.mode ?? 'unknown',
    setSessionId(id: string | null) {
      if (isSessionAwareProvider(llm)) llm.setResumeSession(id)
    },
    getSessionId(): string | null {
      if (isSessionAwareProvider(llm)) return llm.getSessionId()
      return null
    },
  }
}

// === Helpers (checkpoint, gate state, journal — loop-local I/O) ===

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

// === Tool Use Integration ===

function isToolUseProvider(provider: LLMProvider): provider is ToolUseLLMProvider {
  return 'thinkWithTools' in provider && typeof (provider as ToolUseLLMProvider).thinkWithTools === 'function'
}

function isSessionAwareProvider(provider: LLMProvider): provider is SessionAwareLLMProvider {
  return 'skipFeedbackLoop' in provider && 'getSessionId' in provider
}
