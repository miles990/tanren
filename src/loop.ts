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
  ToolUseLLMProvider,
  ConversationMessage,
  ContentBlock,
  ToolUseResponse,
  EventTrigger,
  TriggerEvent,
  TickMode,
  CognitiveMode,
  CognitiveContext,
} from './types.js'
import { createMemorySystem } from './memory.js'
import { createClaudeCliProvider } from './llm/claude-cli.js'
import { createPlanSystem } from './plans.js'
import { createActionHealthTracker } from './action-health.js'
import { createMPL } from './metacognitive.js'
import { createContinuationSystem } from './continuation.js'
import { createPerception, type PerceptionSystem } from './perception.js'
import { createGateSystem, type GateSystem } from './gates.js'
import { createActionRegistry, builtinActions, getRoundRiskTier, resetFilesRead, type ActionRegistry } from './actions.js'
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
import { formatErrorForAgent } from './error-classification.js'

// === Context Mode (module-level, readable by perception plugins) ===

let currentContextMode: ContextModeConfig | null = null
export function getCurrentContextMode(): ContextModeConfig | null { return currentContextMode }

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
  /** Run a self-paced chain — agent decides when to stop */
  runChain(): Promise<TickResult[]>
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
  if (!config.actions?.some(a => a.type === 'respond')) {
    actionRegistry.register({
      type: 'respond',
      description: 'Send a response message back to the caller.',
      toolSchema: {
        properties: { content: { type: 'string', description: 'Response text' } },
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
    description: 'Delegate a focused sub-task to a separate LLM call. The sub-task runs with clean context (identity + your prompt only). Use for: exploring code, summarizing files, or analysis that would clutter your main context. Returns a concise result.',
    toolSchema: {
      properties: {
        task: { type: 'string', description: 'Clear, focused task description. Include file paths if needed.' },
      },
      required: ['task'],
    },
    async execute(action, context) {
      const task = (action.input?.task as string) ?? action.content.trim()
      if (!task) return '[delegate error: empty task]'

      try {
        const identity = await loadIdentity(config.identity, context.memory)
        const subPrompt = `You are a focused research assistant. Complete this task concisely (max 500 words):\n\n${task}`
        const subSystem = `${identity}\n\nYou have access to the filesystem. Be precise and cite line numbers when referencing code.`

        // Use the same LLM but with clean context (no perception, no conversation history)
        const result = await llm.think(subPrompt, subSystem)
        // Cap result to prevent context explosion in main tick
        return result.slice(0, 4000)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[delegate error: ${msg.slice(0, 300)}]`
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
    resetFilesRead()  // convergence condition: each tick starts fresh file tracking
    lastResponse = ''  // reset per tick
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
      identity: (await loadIdentity(config.identity, memory)).length,
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

    console.error(`[tanren] CONTEXT: ${contextBudget.total} chars — perception:${contextBudget.perception} identity:${contextBudget.identity} wm:${contextBudget.workingMemory} learning:${contextBudget.learning}`)

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
      const allToolDefs = actionRegistry.toToolDefinitions()
      let toolDefs = modeToolFilter
        ? allToolDefs.filter(t => modeToolFilter.has(t.name))
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
        const response = await llm.thinkWithTools(messages, toolSystemPrompt, toolDefs)
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
        thought = await llm.think(context, systemPrompt)
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
        { memory, workDir, tickCount, workingMemory },
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
              await actionRegistry.execute(ha, { memory, workDir, tickCount, workingMemory })
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
      const configMax = config.feedbackRounds ?? 10
      const maxFeedbackRounds = skipFeedback ? 0
        : initialHadNoTools ? Math.max(configMax, 2)  // No tools yet → at least 2 rounds
        : configMax                                     // Environmental signals handle the rest
      currentMaxFeedbackRounds = maxFeedbackRounds

      if (useToolUse && structuredActions !== null) {
        // Native tool_use multi-turn: send tool_results, get follow-up tool calls
        const allToolDefs = actionRegistry.toToolDefinitions()
        // Tool degradation: round 2+ removes read-only tools → forces action over exploration
        // Disabled when config.toolDegradation === false (for capable models like Sonnet 4.6+)
        const degradeTools = config.toolDegradation !== false
        const READ_ONLY_TOOLS = new Set(['read', 'explore', 'search', 'shell', 'web_fetch'])
        const actionOnlyToolDefs = allToolDefs.filter(t => !READ_ONLY_TOOLS.has(t.name))
        const toolSystemPrompt = buildToolUseSystemPrompt(identity)
        // messages already has [user context, assistant response] from above
        const messages: ConversationMessage[] = [
          { role: 'user', content: context },
          { role: 'assistant', content: structuredActions.length > 0
            ? buildAssistantContent(thought, structuredActions)
            : [{ type: 'text' as const, text: thought }]
          },
        ]

        // Track used tool+target combos to prevent repetitive actions
        const usedToolTargets = new Set<string>()
        for (const a of actions) {
          const target = a.input?.path ?? a.input?.url ?? a.input?.query ?? a.input?.pattern ?? ''
          usedToolTargets.add(`${a.type}:${target}`)
        }

        // Hybrid model-driven loop (Akari's design):
        // Keep going as long as model calls tools. Only exit when:
        //   (end_turn or no novel actions) AND (IDLE_THRESHOLD rounds since last tool_use)
        // This lets capable models do deep multi-file research across many rounds.
        const IDLE_THRESHOLD = degradeTools ? 0 : 2  // degraded: exit immediately; non-degraded: allow 2 idle rounds for thinking
        let roundsSinceLastToolUse = 0
        // Track rounds without productive output (write/respond/synthesize)
        // Counts both read-only rounds AND idle thinking rounds as "unproductive"
        const PRODUCTIVE_ACTIONS = new Set(['write', 'edit', 'append', 'respond', 'synthesize', 'shell'])
        let roundsWithoutProduction = actions.every(a => !PRODUCTIVE_ACTIONS.has(a.type)) ? 1 : 0  // count initial round
        const SYNTHESIZE_THRESHOLD = 2  // force synthesize after N unproductive rounds (lowered: model typically does 1 read round then goes idle)

        for (let round = 0; round < maxFeedbackRounds; round++) {
          // Conversation compression: when accumulated context exceeds threshold,
          // compress older tool_results to summaries. Keeps recent results verbatim.
          // Claude Code pattern: auto-compress when context fills up.
          const COMPRESS_THRESHOLD = 60_000 // chars
          const totalMsgSize = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
          if (totalMsgSize > COMPRESS_THRESHOLD && messages.length > 3) {
            // Compress all tool_result messages except the last 2 rounds
            const keepVerbatim = 4 // keep last N messages verbatim (2 assistant + 2 user/results)
            for (let mi = 1; mi < messages.length - keepVerbatim; mi++) {
              const msg = messages[mi]
              if (msg.role === 'user' && Array.isArray(msg.content)) {
                const compressed = msg.content.map(block => {
                  if (block.type === 'tool_result' && block.content.length > 500) {
                    return { ...block, content: block.content.slice(0, 200) + '\n[... compressed]' }
                  }
                  return block
                })
                messages[mi] = { ...msg, content: compressed }
              }
            }
            const newSize = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
            console.error(`[tanren] COMPRESS: ${totalMsgSize} → ${newSize} chars (round ${round})`)
          }

          // Build tool_result messages for all actions in this round
          const toolResults: ContentBlock[] = []
          const roundStartIdx = allActions.length - actionResults.slice(-actions.length).length
          for (let i = 0; i < allActions.length; i++) {
            const action = allActions[i]
            if (!action.toolUseId) continue
            // Only send results for actions from current round
            if (i < allActions.length - actionResults.length + roundStartIdx) continue
            toolResults.push({
              type: 'tool_result',
              tool_use_id: action.toolUseId,
              content: actionResults[i] ?? '',
            })
          }

          if (toolResults.length === 0) {
            // No tool results to send — model returned text-only
            const neverCalledTools = allActions.length === 0
            if (neverCalledTools && round === 0) {
              // Model hasn't called ANY tools yet — must force at least one attempt
              messages.push({ role: 'user', content: [{ type: 'text', text: 'You MUST call a tool now — respond, write, edit, read, or search. Text-only responses are not allowed. Use the respond tool to deliver your answer.' }] })
            } else if (!degradeTools && roundsSinceLastToolUse <= IDLE_THRESHOLD) {
              const needsRespond = hasIncomingMessage && !allActions.some(a => a.type === 'respond')
              messages.push({ role: 'user', content: [{ type: 'text', text: needsRespond
                ? 'You MUST call the respond tool NOW to answer the pending message. Include your complete analysis in the respond content.'
                : 'You MUST call a tool now — respond, write, edit, read, or search. Text-only responses are not allowed in feedback rounds.'
              }] })
            } else {
              break
            }
          } else {
            // Append action guidance — if there's an unanswered message, explicitly require respond
            const needsRespond = hasIncomingMessage && !allActions.some(a => a.type === 'respond')
            const actionHint: ContentBlock = { type: 'text', text: needsRespond
              ? 'Tool results above. You have an unanswered message. Call the respond tool NOW with your complete analysis. Do NOT return text without calling respond.'
              : 'Tool results above. Now: call write/edit to create files, or call respond when done. Do NOT return text without a tool call.'
            }
            messages.push({ role: 'user', content: [...toolResults, actionHint] })
          }

          // Tool degradation: round 2+ only gets action tools (respond/edit/remember/git)
          // Skipped when toolDegradation is disabled (capable models self-regulate)
          const roundToolDefs = (round === 0 || !degradeTools) ? allToolDefs : actionOnlyToolDefs

          let response: ToolUseResponse
          try {
            response = await (llm as ToolUseLLMProvider).thinkWithTools(messages, toolSystemPrompt, roundToolDefs)
          } catch {
            break
          }

          const parsed = parseToolUseResponse(response, actionRegistry)

          // Filter out repetitive actions — same tool + same target = wasted round
          const novelActions = parsed.actions.filter(a => {
            const target = a.input?.path ?? a.input?.url ?? a.input?.query ?? a.input?.pattern ?? ''
            const key = `${a.type}:${target}`
            if (usedToolTargets.has(key)) return false
            usedToolTargets.add(key)
            return true
          })

          thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${parsed.thought}`

          if (novelActions.length === 0) {
            roundsSinceLastToolUse++
            roundsWithoutProduction++

            // Convergence check: if stuck in research mode, surface the gap between current state and desired state
            if (!degradeTools && roundsWithoutProduction >= SYNTHESIZE_THRESHOLD) {
              messages.push({ role: 'assistant', content: response.content })
              messages.push({ role: 'user', content: [{ type: 'text', text: `Convergence check: The user asked you to BUILD something. After ${roundsWithoutProduction} rounds, you have not produced any output (no write, no respond, no synthesize). Your current state: research accumulated. Desired state: a file exists that didn't before, or a response delivered. What is the smallest step that moves you from current to desired? Take that step now.` }] })
              roundsWithoutProduction = 0
              continue
            }

            if (roundsSinceLastToolUse > IDLE_THRESHOLD) break

            messages.push({ role: 'assistant', content: response.content })
            continue
          }

          roundsSinceLastToolUse = 0
          // Track productive vs unproductive rounds
          const hasProduction = novelActions.some(a => PRODUCTIVE_ACTIONS.has(a.type))
          if (hasProduction) {
            roundsWithoutProduction = 0
          } else {
            roundsWithoutProduction++
          }
          messages.push({ role: 'assistant', content: response.content })

          // Execute actions via ActionBatch — auto-parallelizes read-only,
          // sequences writes, tracks per-action health.
          const batchResult = await executeBatch(
            novelActions,
            { execute: (action, ctx) => actionRegistry.execute(action, ctx) },
            { memory, workDir, tickCount, workingMemory },
            (event) => {
              config.onActionProgress?.(event)
              if (event.phase === 'done') {
                actionHealth.record(event.action.type, true, tickCount)
              } else if (event.phase === 'error') {
                actionHealth.record(event.action.type, false, tickCount, event.error)
              }
            },
          )
          actionsExecuted += batchResult.executed
          actionsFailed += batchResult.failed

          allActions.push(...novelActions)
          actionResults.push(...batchResult.results)

          // Fire postAction hooks for feedback round actions
          for (let hi = 0; hi < novelActions.length; hi++) {
            const hookActions = hookSystem.run('postAction', {
              tickCount, action: novelActions[hi], result: batchResult.results[hi], allActions,
            }, novelActions[hi].type)
            for (const ha of hookActions) {
              if (actionRegistry.has(ha.type)) {
                try {
                  await actionRegistry.execute(ha, { memory, workDir, tickCount, workingMemory })
                  allActions.push(ha)
                  actionsExecuted++
                } catch { /* hook actions best-effort */ }
              }
            }
          }

          // Exit on substantial respond — threshold varies by mode.
          // Research/verification need thorough answers. Interaction can be brief.
          // Convergence condition: response must be COMPLETE for the mode, not just present.
          const RESPOND_THRESHOLD: Record<string, number> = {
            research: 500,      // deep analysis needs substance
            verification: 400,  // fact-checking needs detail
            execution: 100,     // action confirmation can be brief
            interaction: 50,    // greetings/chat can be short
          }
          const minRespond = RESPOND_THRESHOLD[preMode?.mode ?? 'research'] ?? 300
          const feedbackRespond = novelActions.find(a => a.type === 'respond')
          if (feedbackRespond && feedbackRespond.content.length > minRespond) break
        }
      } else {
        // Text-based feedback mini-loop (legacy)
        let lastRoundResults = [...actionResults]

        for (let round = 0; round < maxFeedbackRounds && lastRoundResults.length > 0; round++) {
          const resultSummary = lastRoundResults.map((r, i) => {
            const idx = allActions.length - lastRoundResults.length + i
            return `[${allActions[idx]?.type ?? 'action'}] ${r}`
          }).join('\n')

          const feedbackContext = `${context}\n\n<action-feedback round="${round + 1}">\nYou just executed actions and received these results:\n${resultSummary}\n</action-feedback>\n\nBased on these results, you may take additional actions or produce no actions if satisfied.`

          let followUpThought: string
          try {
            followUpThought = await llm.think(feedbackContext, systemPrompt)
          } catch {
            break
          }

          thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${followUpThought}`
          const followUpActions = actionRegistry.parse(followUpThought)

          if (followUpActions.length === 0) break

          const roundResults: string[] = []
          for (const action of followUpActions) {
            try {
              const result = await actionRegistry.execute(action, { memory, workDir, tickCount, workingMemory })
              roundResults.push(result)
              actionsExecuted++
              actionHealth.record(action.type, true, tickCount)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              roundResults.push(formatErrorForAgent(err, action.type))
              actionsFailed++
              actionHealth.record(action.type, false, tickCount, msg)
            }
          }

          allActions.push(...followUpActions)
          actionResults.push(...roundResults)
          lastRoundResults = roundResults
        }
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
              { memory, workDir, tickCount, workingMemory },
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
      // Don't swallow silently — record as health data so agent can see it
      const msg = err instanceof Error ? err.message : String(err)
      actionHealth.record('memory-commit', false, tickCount, msg)
    })

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
    async runChain(): Promise<TickResult[]> {
      const results: TickResult[] = []
      continuation.startChain()

      while (true) {
        const result = await tick()
        results.push(result)

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

CRITICAL: Your output MUST contain action tags to produce any effect. Text without action tags is recorded but has no side effects. If you want to respond to a message, you MUST use <action:respond>. If you want to remember something, you MUST use <action:remember>. Analysis without action tags = wasted tick.

IMPORTANT: Action tags are executed by the Tanren framework on your behalf. You do NOT need file access, write permissions, or any external tools. Simply include the action tag in your response and the framework handles all I/O. For example, <action:respond>your message</action:respond> will be delivered to Kuro automatically — you don't write to any file yourself.`
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

// === Tool Use Integration ===

function isToolUseProvider(provider: LLMProvider): provider is ToolUseLLMProvider {
  return 'thinkWithTools' in provider && typeof (provider as ToolUseLLMProvider).thinkWithTools === 'function'
}

function parseToolUseResponse(response: ToolUseResponse, registry: ActionRegistry): { thought: string; actions: Action[] } {
  const textParts: string[] = []
  const actions: Action[] = []

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      actions.push(registry.fromToolUse(block.name, block.id, block.input as Record<string, unknown>))
    }
  }

  return { thought: textParts.join('\n'), actions }
}

/** Build assistant content blocks for multi-turn conversation */
function buildAssistantContent(thought: string, actions: Action[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (thought) {
    blocks.push({ type: 'text', text: thought })
  }
  for (const action of actions) {
    if (action.toolUseId) {
      blocks.push({
        type: 'tool_use',
        id: action.toolUseId,
        name: action.type,
        input: action.input ?? { content: action.content },
      })
    }
  }
  return blocks
}

function buildToolUseSystemPrompt(identity: string): string {
  return `${identity}

## How This Works

You have tools. Only tool calls produce effects — text is thinking. You get multiple rounds: call tools, see results, call more. The tick ends when you stop calling tools.

Call MULTIPLE tools per response when they're independent. Batch reads. Batch writes. Don't serialize what can parallelize.

## Engineering Standard

Act like a senior engineer:
- Do the work. Don't narrate. "Let me find..." → just call the tool.
- Know the path? Read it. Know the answer? Respond. Simplest approach first.
- Read code BEFORE editing. The framework warns if you don't.
- After editing .ts: the framework auto-runs tsc. Fix errors in the same tick.
- Add a field? Handle it EVERYWHERE — constructors, defaults, display, serialization. The framework checks.
- No dead code. Wire features end-to-end or don't ship them.
- Each response the user sees should be COMPLETE and ACTIONABLE — not a progress update.`
}

function extractMessageContent(perception: string): string {
  // Try multiple extraction patterns — code handles determinism, not format prescription
  const patterns = [
    /<kuro-message>([\s\S]*?)<\/kuro-message>/i,
    /<inbox>([\s\S]*?)<\/inbox>/i,
    /<message>([\s\S]*?)<\/message>/i,
    /<from-[\w-]+>([\s\S]*?)<\/from-[\w-]+>/i,
  ]

  for (const pattern of patterns) {
    const match = perception.match(pattern)
    if (match) return match[1].trim()
  }

  // Unclosed tag fallback (same principle as action parser)
  const unclosed = perception.match(/<(?:kuro-message|inbox|message|from-[\w-]+)>([\s\S]*?)(?=<\w|$)/i)
  if (unclosed) return unclosed[1].trim()

  // No structured message found — return empty to signal "no message detected"
  return ''
}
