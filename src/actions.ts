/**
 * Tanren — Action System
 *
 * Parses actions from LLM output and routes them to handlers.
 * Actions are tags in the LLM response: <action:type>content</action:type>
 */

import type { Action, ActionHandler, ActionContext } from './types.js'

export interface ActionRegistry {
  register(handler: ActionHandler): void
  parse(response: string): Action[]
  execute(action: Action, context: ActionContext): Promise<string>
  has(type: string): boolean
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
  }
}

/**
 * Parse <action:type>content</action:type> tags from LLM response.
 * Supports nested content (but not nested action tags).
 */
function parseActions(response: string): Action[] {
  const actions: Action[] = []
  const regex = /<action:(\w[\w-]*)((?:\s+\w+="[^"]*")*)>([\s\S]*?)<\/action:\1>/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(response)) !== null) {
    const attrs: Record<string, string> = {}
    if (match[2]) {
      const attrRegex = /(\w+)="([^"]*)"/g
      let attrMatch: RegExpExecArray | null
      while ((attrMatch = attrRegex.exec(match[2])) !== null) {
        attrs[attrMatch[1]] = attrMatch[2]
      }
    }
    actions.push({
      type: match[1],
      content: match[3].trim(),
      raw: match[0],
      attrs,
    })
  }

  return actions
}

// === Built-in Action Handlers ===

export const builtinActions: ActionHandler[] = [
  {
    type: 'remember',
    async execute(action, context) {
      const topicMatch = action.content.match(/^#([a-zA-Z][\w-]*)\s+/)
      if (topicMatch) {
        await context.memory.remember(
          action.content.slice(topicMatch[0].length),
          { topic: topicMatch[1] },
        )
        return `Remembered to topic: ${topicMatch[1]}`
      }
      await context.memory.remember(action.content)
      return 'Remembered.'
    },
  },
  {
    type: 'write',
    async execute(action, context) {
      // Support attrs: <action:write path="file.md">content</action:write>
      if (action.attrs?.path) {
        await context.memory.write(action.attrs.path, action.content)
        return `Written: ${action.attrs.path}`
      }
      // Fallback: first line is path, rest is content
      const newlineIdx = action.content.indexOf('\n')
      if (newlineIdx === -1) {
        return '[write action: missing content (expected path on first line, content after)]'
      }
      let path = action.content.slice(0, newlineIdx).trim()
      // Strip "path: " prefix if LLM uses YAML-style format
      if (path.startsWith('path:')) path = path.slice(5).trim()
      const content = action.content.slice(newlineIdx + 1)
      await context.memory.write(path, content)
      return `Written: ${path}`
    },
  },
  {
    type: 'append',
    async execute(action, context) {
      const newlineIdx = action.content.indexOf('\n')
      if (newlineIdx === -1) {
        return '[append action: missing content]'
      }
      const path = action.content.slice(0, newlineIdx).trim()
      const line = action.content.slice(newlineIdx + 1)
      await context.memory.append(path, line)
      return `Appended to: ${path}`
    },
  },
  {
    type: 'search',
    async execute(action, context) {
      const results = await context.memory.search(action.content)
      if (results.length === 0) return 'No results found.'
      return results
        .slice(0, 10)
        .map(r => `${r.file}:${r.line}: ${r.content}`)
        .join('\n')
    },
  },
  {
    type: 'shell',
    async execute(action, context) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', action.content], {
          cwd: context.workDir,
          timeout: 30_000,
          maxBuffer: 512 * 1024,
        })
        const output = (stdout + stderr).trim()
        return output.slice(0, 2000) // cap output
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[shell error: ${msg.slice(0, 500)}]`
      }
    },
  },
]
