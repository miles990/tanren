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
import { createActionRegistry, builtinActions, getRoundRiskTier, type ActionRegistry } from './actions.js'
import { createLearningSystem, type LearningSystem } from './learning/index.js'
import { createCognitiveModeDetector, buildCognitiveModePrompt, COGNITIVE_MODE_MODELS, type CognitiveModeDetector } from './cognitive-modes.js'
import { createWorkingMemory, type WorkingMemorySystem } from './working-memory.js'
import { detectContextMode, type ContextModeConfig } from './context-modes.js'

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
  if (config.actions) {
    for (const handler of config.actions) {
      actionRegistry.register(handler)
    }
  }

  // Injected message perception — consumed once per tick
  perception.register({
    name: 'injected-message',
    category: 'input',
    fn: () => {
      if (!pendingMessage) return ''
      const { from, text } = pendingMessage
      pendingMessage = null  // consume
      return `<message from="${from}">\n${text}\n</message>`
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
    lastResponse = ''  // reset per tick
    hadMessageThisTick = pendingMessage !== null
    mpl.setRecentTicks(recentTicks)  // inject history for cognitive state perception
    mpl.preTick()  // snapshot state for diff
    writeLiveStatus({ phase: 'perceive', tickStart, tickNumber: tickCount, running })

    // Load and decay working memory
    workingMemory.load()
    workingMemory.decay(tickCount)

    // 1. Perceive
    const perceptionOutput = await perception.perceive()
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
    const wmContext = workingMemory.toContextString()
    let context: string
    if (complexity === 'minimal') {
      // Minimal: just identity + message, skip heavy perception
      context = `${identity}\n\n<message>\n${messageContent}\n</message>\n\nRespond briefly (1-3 sentences max).`
    } else {
      const baseContext = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext)
      context = wmContext
        ? `<working-memory>\n${wmContext}\n</working-memory>\n\n${baseContext}`
        : baseContext
    }

    // 3. Think (LLM call) with cognitive mode detection
    writeLiveStatus({ phase: 'think', tickStart, tickNumber: tickCount, running, perceptionBytes: perceptionOutput.length })

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
    const systemPrompt = cognitiveContext
      ? buildCognitiveModePrompt(identity, cognitiveContext, baseSystemPrompt.split('\n\n## Available Actions')[1] || '')
      : baseSystemPrompt

    let thought: string
    let structuredActions: Action[] | null = null

    // Always use tool_use when available — agent decides which tools to call.
    // Previous design gated tool_use on complexity classification, but char-length
    // thresholds are unreliable across languages and rob the agent of choice.
    const useToolUse = isToolUseProvider(llm)

    if (useToolUse) {
      // Context-sensitive tool exposure: environment state shapes available tools.
      // Make correct behavior the path of least resistance.
      const allToolDefs = actionRegistry.toToolDefinitions()
      const RESPONSE_TOOLS = new Set(['respond', 'remember', 'clear-inbox', 'reflect'])
      const toolDefs = hadMessageThisTick
        ? allToolDefs.filter(t => RESPONSE_TOOLS.has(t.name))  // message → respond is the natural path
        : allToolDefs

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

      // Execute initial actions
      for (const action of actions) {
        config.onActionProgress?.({ phase: 'start', action })
        try {
          const result = await actionRegistry.execute(action, { memory, workDir, tickCount, workingMemory })
          actionResults.push(result)
          actionsExecuted++
          actionHealth.record(action.type, true, tickCount)
          config.onActionProgress?.({ phase: 'done', action, result: result.slice(0, 200) })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          actionResults.push(`[action ${action.type} failed: ${msg}]`)
          actionsFailed++
          actionHealth.record(action.type, false, tickCount, msg)
          config.onActionProgress?.({ phase: 'error', action, error: msg })
        }
      }

      // Convergence Condition: feedback needed if model hasn't produced useful output yet.
      // Behavior-driven, not keyword-driven — look at what the model DID, not what the user SAID.
      const roundRisk = getRoundRiskTier(actions)
      const initialHadNoTools = actions.length === 0
      const initialHasRespond = actions.some(a => a.type === 'respond')
      const skipFeedback = (!initialHadNoTools && roundRisk === 1 && actionsFailed === 0)
        || initialHasRespond  // Agent already responded — tick is complete

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
              messages.push({ role: 'user', content: [{ type: 'text', text: 'You MUST call a tool now — respond, write, edit, read, or search. Text-only responses are not allowed in feedback rounds.' }] })
            } else {
              break
            }
          } else {
            // Append action guidance alongside tool results to prevent model from going text-only
            const actionHint: ContentBlock = { type: 'text', text: 'Tool results above. Now: call write/edit to create files, or call respond when done. Do NOT return text without a tool call.' }
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

          const roundResults: string[] = []
          for (const action of novelActions) {
            config.onActionProgress?.({ phase: 'start', action })
            try {
              const result = await actionRegistry.execute(action, { memory, workDir, tickCount, workingMemory })
              roundResults.push(result)
              actionsExecuted++
              actionHealth.record(action.type, true, tickCount)
              config.onActionProgress?.({ phase: 'done', action, result: result.slice(0, 200) })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              roundResults.push(`[action ${action.type} failed: ${msg}]`)
              actionsFailed++
              actionHealth.record(action.type, false, tickCount, msg)
              config.onActionProgress?.({ phase: 'error', action, error: msg })
            }
          }

          allActions.push(...novelActions)
          actionResults.push(...roundResults)

          // Early exit: if agent called respond, it believes the tick is complete.
          // Don't keep looping — respect the agent's cognitive signal.
          if (novelActions.some(a => a.type === 'respond')) break
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
              roundResults.push(`[action ${action.type} failed: ${msg}]`)
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
      // If LLM didn't call respond, extract a response from thought.
      const hasRespond = allActions.some(a => a.type === 'respond')
      if (hadMessageThisTick && !hasRespond && thought.length > 50) {
        // Auto-extract: use thought as response (code guarantee, not prompt hope)
        const autoResponse = thought.replace(/<action:\w+>[\s\S]*?<\/action:\w+>/g, '').trim()
        if (autoResponse.length > 20) {
          try {
            const result = await actionRegistry.execute(
              { type: 'respond', content: autoResponse, raw: autoResponse },
              { memory, workDir, tickCount, workingMemory },
            )
            allActions.push({ type: 'respond', content: autoResponse, raw: autoResponse })
            actionResults.push(result)
            actionsExecuted++
            console.error(`[floor] Auto-respond: LLM thought but did not call respond (${autoResponse.length} chars)`)
          } catch { /* floor best-effort, don't break tick */ }
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

    // Clear checkpoint (tick completed successfully)
    clearCheckpoint(checkpointPath)

    // 8. Learning: observe tick, detect patterns, maybe crystallize
    if (learning) {
      const learningResult = learning.afterTick(tickResult, recentTicks)
      // Update observation quality from learning assessment
      tickResult.observation.outputQuality = learningResult.quality
    }

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

## Instructions

You have tools available. Use them to take actions. Your text response is your thinking/reflection — it will be recorded but has no side effects. Only tool calls produce effects.

CRITICAL: You MUST call at least one tool per tick to produce any effect. If you want to respond to a message, call the 'respond' tool. If you want to remember something, call the 'remember' tool. Thinking without tool calls = wasted tick.

You can call MULTIPLE tools in a single response. After seeing results, you can call more tools in the next round. Only use 'respond' when you have gathered enough information to give a complete answer.

HOW THIS WORKS: The framework gives you multiple rounds per tick. Each round, you call tools and see results. The framework decides when to stop based on your behavior — if you stop calling tools, the tick ends. There is no fixed number of rounds. Use as many as you need.

CONVERGENCE CONDITION: A tick is complete when you have produced a visible output (file written, response delivered, or memory saved). The path to get there is yours to decide — read first, write first, or both at once. The framework tracks your progress, not your process.

IMPLEMENTATION COURAGE: You are allowed to be wrong. Write code that teaches you something about the problem, not code that proves you understand it. First drafts are explorations, not commitments. The cost of imperfect code is near zero (git revert exists). The cost of not writing is infinite (you stay stuck). Ship the draft, learn from the result, iterate.

IMPLEMENTATION DISCIPLINE: Before writing TypeScript code, ALWAYS read the relevant type files first (e.g. src/types.ts). Use ONLY fields that actually exist in the interfaces — never invent plausible-sounding fields. After writing, run \`npx tsc --noEmit\` via the shell tool to verify. Fix any type errors before responding.

OPEN-ENDED TASKS: A tick is not complete until the user has something they can act on — a file written, a response delivered, or a structured proposal (synthesize tool). If you have been reading without producing, ask: what is the smallest output that moves from current state to desired state? Produce that now.

ANTI-REPETITION: Your perception includes your own past memories and responses. Do NOT reproduce or rephrase previous outputs. Each message deserves a FRESH response to the CURRENT question. If the current message asks something you previously answered, provide NEW analysis or explicitly build on prior findings — never copy.`
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
