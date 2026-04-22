/**
 * Tanren — Prompt Builder Module
 *
 * Pure helper functions for building prompts and parsing LLM responses.
 * Extracted from loop.ts to reduce its size and clarify separation of concerns.
 *
 * All functions here are pure or near-pure (no closure over loop state).
 * They receive everything they need as arguments.
 */

import type {
  Action,
  Observation,
  MemorySystem,
  ContentBlock,
  ToolUseResponse,
} from './types.js'
import type { ActionRegistry } from './actions.js'

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Load identity string. If it looks like a file path, read it via memory system
 * or directly from disk. Otherwise treat as an inline string.
 */
export async function loadIdentity(identity: string, memory: MemorySystem): Promise<string> {
  if (identity.endsWith('.md') || identity.includes('/')) {
    const content = await memory.read(identity)
    if (content) return content
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile(identity, 'utf-8')
    } catch {
      return identity
    }
  }
  return identity
}

// ── Context assembly ──────────────────────────────────────────────────────────

/**
 * Assemble the user-facing context string from its components.
 */
export function buildContext(
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

// ── System prompts ────────────────────────────────────────────────────────────

/**
 * Build the text-mode system prompt (used by CLI / non-tool-use LLM providers).
 */
export function buildSystemPrompt(identity: string, actions: ActionRegistry): string {
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

IMPORTANT: Action tags are executed by the Tanren framework on your behalf. You do NOT need file access, write permissions, or any external tools. Simply include the action tag in your response and the framework handles all I/O. For example, <action:respond>your message</action:respond> will be delivered to the sender automatically — you don't write to any file yourself. The sender is identified by the "from" attribute in the <message> tag.`
}

/**
 * Build the tool-use system prompt (used by Anthropic API / tool-use providers).
 */
export function buildToolUseSystemPrompt(identity: string): string {
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

// ── Message extraction ────────────────────────────────────────────────────────

/**
 * Extract message content from perception output.
 * Tries multiple XML tag patterns; returns empty string if none found.
 */
export function extractMessageContent(perception: string): string {
  const patterns = [
    /<kuro-message>([\s\S]*?)<\/kuro-message>/i,
    /<inbox>([\s\S]*?)<\/inbox>/i,
    /<message[^>]*>([\s\S]*?)<\/message>/i,
    /<from-[\w-]+>([\s\S]*?)<\/from-[\w-]+>/i,
  ]

  for (const pattern of patterns) {
    const match = perception.match(pattern)
    if (match) return match[1].trim()
  }

  const unclosed = perception.match(/<(?:kuro-message|inbox|message|from-[\w-]+)>([\s\S]*?)(?=<\w|$)/i)
  if (unclosed) return unclosed[1].trim()

  return ''
}

// ── Observation ───────────────────────────────────────────────────────────────

/**
 * Create a zeroed-out Observation for the start of a tick.
 */
export function createEmptyObservation(tickStart: number): Observation {
  return {
    outputExists: false,
    outputQuality: 0,
    confidenceCalibration: 0,
    actionsExecuted: 0,
    actionsFailed: 0,
    duration: Date.now() - tickStart,
  }
}

// ── Tool-use response helpers ─────────────────────────────────────────────────

/**
 * Parse a ToolUseResponse into thought text and structured Actions.
 */
export function parseToolUseResponse(
  response: ToolUseResponse,
  registry: ActionRegistry,
): { thought: string; actions: Action[] } {
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

/**
 * Build the assistant ContentBlock array for a multi-turn tool-use conversation.
 */
export function buildAssistantContent(thought: string, actions: Action[]): ContentBlock[] {
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
