/**
 * Tanren — Action System
 *
 * Parses actions from LLM output and routes them to handlers.
 * Actions are tags in the LLM response: <action:type>content</action:type>
 *
 * Built-in action handler implementations live in builtin-actions.ts.
 */

import type { Action, ActionHandler, ActionContext, ToolDefinition } from './types.js'

// Convergence condition: file tracking for read-before-edit enforcement.
// Previously module-level singletons — now per-tick via ActionContext.filesRead.
// These exports are kept for backward compatibility but are no-ops.
// All internal usage goes through context.filesRead.
/** @deprecated Use context.filesRead.add(path) instead */
export function markFileRead(_path: string): void { /* no-op — use context.filesRead */ }
/** @deprecated No longer needed — filesRead is created fresh per tick */
export function resetFilesRead(): void { /* no-op */ }
/** @deprecated Use context.filesRead.has(path) instead */
export function hasFileBeenRead(_path: string): boolean { return false }

export { builtinActions, getRiskTier, getRoundRiskTier } from './builtin-actions.js'

export interface ActionRegistry {
  register(handler: ActionHandler): void
  parse(response: string): Action[]
  execute(action: Action, context: ActionContext): Promise<string>
  has(type: string): boolean
  types(): string[]
  getDescription(type: string): string | undefined
  /** Convert registered actions to Anthropic tool definitions */
  toToolDefinitions(): ToolDefinition[]
  /** Convert a tool_use block back to an Action */
  fromToolUse(name: string, id: string, input: Record<string, unknown>): Action
}

export function createActionRegistry(): ActionRegistry {
  const handlers = new Map<string, ActionHandler>()

  return {
    register(handler: ActionHandler): void {
      handlers.set(handler.type, handler)
    },

    parse(response: string): Action[] {
      return parseActions(response)
    },

    execute(action: Action, context: ActionContext): Promise<string> {
      const handler = handlers.get(action.type)
      if (!handler) {
        return Promise.resolve(`[unknown action type: ${action.type}]`)
      }
      return handler.execute(action, context)
    },

    has(type: string): boolean {
      return handlers.has(type)
    },

    types(): string[] {
      return [...handlers.keys()]
    },

    getDescription(type: string): string | undefined {
      return handlers.get(type)?.description
    },

    toToolDefinitions(): ToolDefinition[] {
      const defs: ToolDefinition[] = []
      for (const [name, handler] of handlers) {
        const schema = handler.toolSchema ?? {
          properties: { content: { type: 'string', description: 'Action content' } },
          required: ['content'],
        }
        defs.push({
          name,
          description: handler.description ?? `Execute ${name} action`,
          input_schema: { type: 'object', ...schema },
        })
      }
      return defs
    },

    fromToolUse(name: string, id: string, input: Record<string, unknown>): Action {
      // Build content string from structured input for backward compatibility
      const content = typeof input.content === 'string'
        ? input.content
        : Object.entries(input).map(([k, v]) => `${k}: ${String(v)}`).join('\n')

      return {
        type: name,
        content,
        raw: JSON.stringify({ tool_use: name, id, input }),
        input,
        toolUseId: id,
      }
    },
  }
}

/**
 * Parse <action:type>content</action:type> tags from LLM response.
 *
 * Constraint Texture: tag pairing is deterministic → handled by code, not LLM.
 * 1. Try exact matching (well-formed open+close pairs)
 * 2. Fallback: unclosed tags → content runs to next <action: or end of string
 */
function parseActions(response: string): Action[] {
  // Pass 1: exact matches (well-formed tags)
  const actions: Action[] = []
  const regex = /<action:(\w[\w-]*)((?:\s+\w+="[^"]*")*)>([\s\S]*?)<\/action:\1>/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    actions.push(buildAction(match[1], match[2], match[3], match[0]))
  }

  if (actions.length > 0) return actions

  // Pass 2: unclosed tags — content extends to next <action: or end of string
  const unclosedRegex = /<action:(\w[\w-]*)((?:\s+\w+="[^"]*")*)>([\s\S]*?)(?=<action:|\s*$)/g

  while ((match = unclosedRegex.exec(response)) !== null) {
    actions.push(buildAction(match[1], match[2], match[3], match[0]))
  }

  return actions
}

function buildAction(type: string, rawAttrs: string, content: string, raw: string): Action {
  const attrs: Record<string, string> = {}
  if (rawAttrs) {
    const attrRegex = /(\w+)="([^"]*)"/g
    let attrMatch: RegExpExecArray | null
    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2]
    }
  }
  return { type, content: content.trim(), raw, attrs }
}
