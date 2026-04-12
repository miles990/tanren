/**
 * Tanren — Feedback Loop Module
 *
 * Multi-round feedback logic extracted from tick() in loop.ts.
 * Two exported functions: one for native tool_use LLMs, one for text-based LLMs.
 *
 * Convergence Condition: model has produced visible output OR exhausted budget.
 * The loop exits early on idle, repetition, context budget, or synthesize threshold.
 */

import type {
  Action,
  ConversationMessage,
  ContentBlock,
  ToolUseLLMProvider,
  LLMProvider,
  ActionContext,
} from './types.js'
import type { ActionRegistry } from './actions.js'
import type { ContextModeConfig } from './context-modes.js'
import { executeBatch } from './action-batch.js'
import { parseToolUseResponse, buildAssistantContent, buildToolUseSystemPrompt } from './prompt-builder.js'
import { formatErrorForAgent } from './error-classification.js'
import type { HookPhase, HookContext } from './hooks.js'

// ── Shared types ──────────────────────────────────────────────────────────────

export interface FeedbackLoopConfig {
  maxRounds: number
  contextBudget: number
  degradeTools: boolean
  hasIncomingMessage: boolean
  preMode: ContextModeConfig | null
}

export interface FeedbackLoopResult {
  thought: string
  actions: Action[]
  results: string[]
  actionsExecuted: number
  actionsFailed: number
}

type ProgressEvent = { phase: 'start' | 'done' | 'error'; action: Action; result?: string; error?: string }

// ── Tool-use feedback loop ────────────────────────────────────────────────────

/**
 * Run the native tool_use multi-turn feedback loop.
 *
 * Receives the initial round's actions and results, then continues calling the
 * LLM with tool_results until one of the exit conditions is met:
 *   - Context budget exceeded
 *   - Idle threshold (model stops calling tools)
 *   - Synthesize threshold (N unproductive rounds)
 *   - Substantial respond action produced
 *   - maxRounds exhausted
 */
export async function runToolUseFeedbackLoop(
  config: FeedbackLoopConfig,
  initialActions: Action[],
  initialResults: string[],
  initialThought: string,
  context: string,
  llm: ToolUseLLMProvider,
  actionRegistry: ActionRegistry,
  actionContext: ActionContext,
  identity: string,
  onProgress?: (event: ProgressEvent) => void,
  onActionHealth?: (type: string, success: boolean, tick: number, error?: string) => void,
  hookSystem?: { run: (phase: HookPhase, context: HookContext, actionType?: string) => Action[] },
): Promise<FeedbackLoopResult> {
  const { maxRounds, contextBudget, degradeTools, hasIncomingMessage, preMode } = config

  const allToolDefs = actionRegistry.toToolDefinitions()
  const READ_ONLY_TOOLS = new Set(['read', 'explore', 'search', 'shell', 'web_fetch'])
  const actionOnlyToolDefs = allToolDefs.filter(t => !READ_ONLY_TOOLS.has(t.name))
  const toolSystemPrompt = buildToolUseSystemPrompt(identity)

  const messages: ConversationMessage[] = [
    { role: 'user', content: context },
    {
      role: 'assistant',
      content: initialActions.length > 0
        ? buildAssistantContent(initialThought, initialActions)
        : [{ type: 'text' as const, text: initialThought }],
    },
  ]

  // Track used tool+target combos to prevent repetitive actions
  const usedToolTargets = new Set<string>()
  for (const a of initialActions) {
    const target = a.input?.path ?? a.input?.url ?? a.input?.query ?? a.input?.pattern ?? ''
    usedToolTargets.add(`${a.type}:${target}`)
  }

  // Loop state
  const IDLE_THRESHOLD = degradeTools ? 0 : 2
  let roundsSinceLastToolUse = 0

  const PRODUCTIVE_ACTIONS = new Set(['write', 'edit', 'append', 'respond', 'synthesize', 'shell'])
  let roundsWithoutProduction = initialActions.every(a => !PRODUCTIVE_ACTIONS.has(a.type)) ? 1 : 0
  const SYNTHESIZE_THRESHOLD = 2

  const COMPRESS_THRESHOLD = 60_000

  // Respond threshold by mode
  const RESPOND_THRESHOLD: Record<string, number> = {
    research: 500,
    verification: 400,
    execution: 100,
    interaction: 50,
  }
  const minRespond = RESPOND_THRESHOLD[preMode?.mode ?? 'research'] ?? 300

  // Accumulate across rounds
  let thought = initialThought
  const allActions = [...initialActions]
  const actionResults = [...initialResults]
  let actionsExecuted = 0
  let actionsFailed = 0

  for (let round = 0; round < maxRounds; round++) {
    // Context budget check — before compression. If over budget, force synthesis exit.
    const currentContextSize = messages.reduce(
      (s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
      0,
    )
    if (currentContextSize > contextBudget) {
      console.error(`[tanren] BUDGET: ${currentContextSize} > ${contextBudget} at round ${round} — forcing synthesis`)
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `Context budget reached (${Math.round(currentContextSize / 1000)}K chars). You have enough information. Synthesize your findings NOW using the respond tool. Do NOT read more files.`,
        }],
      })
      if (round > 0) {
        let budgetResponse
        try {
          budgetResponse = await llm.thinkWithTools(messages, toolSystemPrompt, actionOnlyToolDefs)
        } catch {
          break
        }
        const budgetParsed = parseToolUseResponse(budgetResponse, actionRegistry)
        thought += `\n\n--- Budget Synthesis ---\n\n${budgetParsed.thought}`
        if (budgetParsed.actions.length > 0) {
          const batchResult = await executeBatch(
            budgetParsed.actions,
            { execute: (action, ctx) => actionRegistry.execute(action, ctx) },
            actionContext,
            onProgress,
          )
          actionsExecuted += batchResult.executed
          actionsFailed += batchResult.failed
          allActions.push(...budgetParsed.actions)
          actionResults.push(...batchResult.results)
        }
        break
      }
    }

    // Conversation compression: compress older tool_results when context grows large.
    const totalMsgSize = messages.reduce(
      (s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
      0,
    )
    if (totalMsgSize > COMPRESS_THRESHOLD && messages.length > 3) {
      const keepVerbatim = 4
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
      const newSize = messages.reduce(
        (s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
        0,
      )
      console.error(`[tanren] COMPRESS: ${totalMsgSize} → ${newSize} chars (round ${round})`)
    }

    // Build tool_result messages for all actions in this round
    const toolResults: ContentBlock[] = []
    const roundStartIdx = allActions.length - actionResults.slice(-initialActions.length).length
    for (let i = 0; i < allActions.length; i++) {
      const action = allActions[i]
      if (!action.toolUseId) continue
      if (i < allActions.length - actionResults.length + roundStartIdx) continue
      toolResults.push({
        type: 'tool_result',
        tool_use_id: action.toolUseId,
        content: actionResults[i] ?? '',
      })
    }

    // Memory injection: if the agent already wrote a respond in an earlier round,
    // show it back so the LLM knows and can choose to rewrite instead of append.
    // This is the "memory gap" fix — without this, the LLM is blind to its own
    // prior respond and can only narrate new intentions on top.
    const priorResponds = allActions.filter(a => a.type === 'respond')
    const priorRespondHint: string = priorResponds.length > 0
      ? `\n\n⚠ PRIOR respond() already written this tick (${priorResponds.length} total). Latest content preview:\n"""${(priorResponds[priorResponds.length - 1].content ?? '').slice(0, 300)}${((priorResponds[priorResponds.length - 1].content ?? '').length > 300) ? '...' : ''}"""\nIf that's still your FINAL answer, DO NOT call respond again — let the loop end. If you have NEW results after the tool output, call respond with the COMPLETE final answer — your new call REPLACES the prior one, not appends to it. Do NOT write "Let me..." or "Now I will..." — respond is for RESULTS, not intentions.`
      : ''

    if (toolResults.length === 0) {
      const neverCalledTools = allActions.length === 0
      if (neverCalledTools && round === 0) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'You MUST call a tool now — respond, write, edit, read, or search. Text-only responses are not allowed. Use the respond tool to deliver your answer.' + priorRespondHint }],
        })
      } else if (!degradeTools && roundsSinceLastToolUse <= IDLE_THRESHOLD) {
        const needsRespond = hasIncomingMessage && !allActions.some(a => a.type === 'respond')
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: (needsRespond
            ? 'You MUST call the respond tool NOW to answer the pending message. Include your complete analysis in the respond content.'
            : 'You MUST call a tool now — respond, write, edit, read, or search. Text-only responses are not allowed in feedback rounds.'
          ) + priorRespondHint }],
        })
      } else {
        break
      }
    } else {
      const needsRespond = hasIncomingMessage && !allActions.some(a => a.type === 'respond')
      const actionHint: ContentBlock = {
        type: 'text',
        text: (needsRespond
          ? 'Tool results above. You have an unanswered message. Call the respond tool NOW with your complete analysis. Do NOT return text without calling respond.'
          : 'Tool results above. Now: call write/edit to create files, or call respond when done. Do NOT return text without a tool call.'
        ) + priorRespondHint,
      }
      messages.push({ role: 'user', content: [...toolResults, actionHint] })
    }

    // Tool degradation: round 2+ only gets action tools
    const roundToolDefs = (round === 0 || !degradeTools) ? allToolDefs : actionOnlyToolDefs

    let response
    try {
      response = await llm.thinkWithTools(messages, toolSystemPrompt, roundToolDefs)
    } catch {
      break
    }

    const parsed = parseToolUseResponse(response, actionRegistry)

    // Filter repetitive actions
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

      if (!degradeTools && roundsWithoutProduction >= SYNTHESIZE_THRESHOLD) {
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: `Convergence check: The user asked you to BUILD something. After ${roundsWithoutProduction} rounds, you have not produced any output (no write, no respond, no synthesize). Your current state: research accumulated. Desired state: a file exists that didn't before, or a response delivered. What is the smallest step that moves you from current to desired? Take that step now.`,
          }],
        })
        roundsWithoutProduction = 0
        continue
      }

      if (roundsSinceLastToolUse > IDLE_THRESHOLD) break

      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    roundsSinceLastToolUse = 0
    const hasProduction = novelActions.some(a => PRODUCTIVE_ACTIONS.has(a.type))
    if (hasProduction) {
      roundsWithoutProduction = 0
    } else {
      roundsWithoutProduction++
    }
    messages.push({ role: 'assistant', content: response.content })

    const batchResult = await executeBatch(
      novelActions,
      { execute: (action, ctx) => actionRegistry.execute(action, ctx) },
      actionContext,
      (event) => {
        onProgress?.(event)
        if (event.phase === 'done') {
          onActionHealth?.(event.action.type, true, actionContext.tickCount ?? 0)
        } else if (event.phase === 'error') {
          onActionHealth?.(event.action.type, false, actionContext.tickCount ?? 0, event.error)
        }
      },
    )
    actionsExecuted += batchResult.executed
    actionsFailed += batchResult.failed

    allActions.push(...novelActions)
    actionResults.push(...batchResult.results)

    // Fire postAction hooks for feedback round actions
    if (hookSystem) {
      for (let hi = 0; hi < novelActions.length; hi++) {
        const hookActions = hookSystem.run('postAction', {
          tickCount: actionContext.tickCount ?? 0, action: novelActions[hi], result: batchResult.results[hi], allActions,
        }, novelActions[hi].type)
        for (const ha of hookActions) {
          if (actionRegistry.has(ha.type)) {
            try {
              await actionRegistry.execute(ha, actionContext)
              allActions.push(ha)
              actionsExecuted++
            } catch { /* hook actions best-effort */ }
          }
        }
      }
    }

    // Exit on substantial respond — threshold varies by mode
    const feedbackRespond = novelActions.find(a => a.type === 'respond')
    if (feedbackRespond && feedbackRespond.content.length > minRespond) break
  }

  // Collapse respond actions to the last one — enforces "final answer only"
  // as a structural invariant. Any caller that extracts respond (via .find,
  // .filter, etc.) sees a single canonical respond, eliminating the
  // "first-respond-wins-but-first-is-stale-intention" bug.
  const dedupedActions = collapseRespondActions(allActions)

  return { thought, actions: dedupedActions, results: actionResults, actionsExecuted, actionsFailed }
}

/**
 * Remove all but the last respond action from the action list.
 * Preserves order for non-respond actions. This is the structural
 * enforcement of "respond is a final answer, not a progress log".
 */
function collapseRespondActions(actions: Action[]): Action[] {
  const respondIndices: number[] = []
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].type === 'respond') respondIndices.push(i)
  }
  if (respondIndices.length <= 1) return actions
  const lastRespondIdx = respondIndices[respondIndices.length - 1]
  return actions.filter((a, i) => a.type !== 'respond' || i === lastRespondIdx)
}

// ── Text-based feedback mini-loop ─────────────────────────────────────────────

/**
 * Run the legacy text-based (non-tool-use) feedback mini-loop.
 *
 * Sends action results back to the LLM as a <action-feedback> block and
 * parses follow-up actions until the model produces none or maxRounds is hit.
 */
export async function runTextFeedbackLoop(
  maxRounds: number,
  initialActions: Action[],
  initialResults: string[],
  initialThought: string,
  context: string,
  systemPrompt: string,
  llm: LLMProvider,
  actionRegistry: ActionRegistry,
  actionContext: ActionContext,
  onActionHealth?: (type: string, success: boolean, tick: number, error?: string) => void,
): Promise<FeedbackLoopResult> {
  let thought = initialThought
  const allActions = [...initialActions]
  const actionResults = [...initialResults]
  let actionsExecuted = 0
  let actionsFailed = 0
  let lastRoundResults = [...initialResults]

  for (let round = 0; round < maxRounds && lastRoundResults.length > 0; round++) {
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
        const result = await actionRegistry.execute(action, actionContext)
        roundResults.push(result)
        actionsExecuted++
        onActionHealth?.(action.type, true, actionContext.tickCount ?? 0)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        roundResults.push(formatErrorForAgent(err, action.type))
        actionsFailed++
        onActionHealth?.(action.type, false, actionContext.tickCount ?? 0, msg)
      }
    }

    allActions.push(...followUpActions)
    actionResults.push(...roundResults)
    lastRoundResults = roundResults
  }

  return { thought, actions: allActions, results: actionResults, actionsExecuted, actionsFailed }
}
