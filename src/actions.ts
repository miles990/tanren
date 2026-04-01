/**
 * Tanren — Action System
 *
 * Parses actions from LLM output and routes them to handlers.
 * Actions are tags in the LLM response: <action:type>content</action:type>
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Action, ActionHandler, ActionContext, ToolDefinition, RiskTier } from './types.js'

/** Write to absolute path directly, or delegate to memory system for relative paths */
async function writeToPath(rawPath: string, content: string, context: ActionContext, append = false): Promise<string> {
  if (rawPath.startsWith('/')) {
    const dir = dirname(rawPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (append) {
      appendFileSync(rawPath, content.endsWith('\n') ? content : content + '\n')
    } else {
      writeFileSync(rawPath, content, 'utf-8')
    }
    return rawPath
  }
  if (append) {
    await context.memory.append(rawPath, content)
  } else {
    await context.memory.write(rawPath, content)
  }
  return rawPath
}

// Risk tier classification for graduated feedback
const ACTION_RISK_TIERS: Record<string, RiskTier> = {
  // Tier 1: Safe/read-only — skip feedback entirely
  respond: 1, remember: 1, search: 1, read: 1, explore: 1, 'clear-inbox': 1,
  // Tier 2: Moderate/additive — execute + log, no verification
  write: 2, append: 2, web_fetch: 2,
  // Tier 3: High-risk/destructive — full feedback loop
  shell: 3, edit: 3, git: 3,
}

/** Get risk tier for an action type. Unknown actions default to Tier 3 (safe default). */
export function getRiskTier(actionType: string): RiskTier {
  return ACTION_RISK_TIERS[actionType] ?? 3
}

/** Get the highest risk tier in a set of actions. Mixed rounds use highest tier. */
export function getRoundRiskTier(actions: Action[]): RiskTier {
  if (actions.length === 0) return 1
  return Math.max(...actions.map(a => getRiskTier(a.type))) as RiskTier
}

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
    description: 'Store a memory. Optionally specify a topic for categorization.',
    toolSchema: {
      properties: {
        content: { type: 'string', description: 'What to remember' },
        topic: { type: 'string', description: 'Optional topic category (e.g. "design", "debugging")' },
      },
      required: ['content'],
    },
    async execute(action, context) {
      const tick = context.tickCount
      // Structured input path (from tool_use)
      if (action.input) {
        const topic = action.input.topic as string | undefined
        const content = action.input.content as string
        await context.memory.remember(content, { topic, tickCount: tick })
        return topic ? `Remembered to topic: ${topic}` : 'Remembered.'
      }
      // Legacy text path (from regex parsing)
      const topicMatch = action.content.match(/^#([a-zA-Z][\w-]*)\s+/)
      if (topicMatch) {
        await context.memory.remember(
          action.content.slice(topicMatch[0].length),
          { topic: topicMatch[1], tickCount: tick },
        )
        return `Remembered to topic: ${topicMatch[1]}`
      }
      await context.memory.remember(action.content, { tickCount: tick })
      return 'Remembered.'
    },
  },
  {
    type: 'write',
    description: 'Write content to a file. Absolute paths write directly; relative paths write to memory directory.',
    toolSchema: {
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to memory directory)' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(action, context) {
      // Structured input path
      if (action.input?.path) {
        const path = await writeToPath(action.input.path as string, action.input.content as string, context)
        return `Written: ${path}`
      }
      // Legacy: attrs path
      if (action.attrs?.path) {
        await context.memory.write(action.attrs.path, action.content)
        return `Written: ${action.attrs.path}`
      }
      // Legacy: first line is path
      const newlineIdx = action.content.indexOf('\n')
      if (newlineIdx === -1) {
        return '[write action: missing content (expected path on first line, content after)]'
      }
      let path = action.content.slice(0, newlineIdx).trim()
      if (path.startsWith('path:')) path = path.slice(5).trim()
      const content = action.content.slice(newlineIdx + 1)
      await context.memory.write(path, content)
      return `Written: ${path}`
    },
  },
  {
    type: 'append',
    description: 'Append a line to a file. Absolute paths write directly; relative paths write to memory directory.',
    toolSchema: {
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to memory directory)' },
        content: { type: 'string', description: 'Line to append' },
      },
      required: ['path', 'content'],
    },
    async execute(action, context) {
      // Structured input path
      if (action.input?.path) {
        const path = await writeToPath(action.input.path as string, action.input.content as string, context, true)
        return `Appended to: ${path}`
      }
      // Legacy text path
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
    description: 'Search memory files for a query string.',
    toolSchema: {
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    async execute(action, context) {
      const query = (action.input?.query as string) ?? action.content
      const results = await context.memory.search(query)
      if (results.length === 0) return 'No results found.'
      return results
        .slice(0, 10)
        .map(r => `${r.file}:${r.line}: ${r.content}`)
        .join('\n')
    },
  },
  {
    type: 'shell',
    description: 'Execute a shell command and return its output.',
    toolSchema: {
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
      },
      required: ['command'],
    },
    async execute(action, context) {
      const command = (action.input?.command as string) ?? action.content
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
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
  {
    type: 'web_fetch',
    description: 'Fetch a URL and return its text content. Useful for reading web pages, APIs, or documentation.',
    toolSchema: {
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        max_length: { type: 'number', description: 'Maximum characters to return (default: 8000)' },
      },
      required: ['url'],
    },
    async execute(action) {
      const url = (action.input?.url as string) ?? action.content.trim()
      const maxLength = (action.input?.max_length as number) ?? 8000

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Tanren/1.0' },
        })
        clearTimeout(timer)

        if (!response.ok) {
          return `[web_fetch error: HTTP ${response.status} ${response.statusText}]`
        }

        const contentType = response.headers.get('content-type') ?? ''
        let text = await response.text()

        // Strip HTML tags for readability if it's an HTML page
        if (contentType.includes('html')) {
          // Remove script/style blocks first
          text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
          text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
          // Strip remaining tags
          text = text.replace(/<[^>]+>/g, ' ')
          // Collapse whitespace
          text = text.replace(/\s+/g, ' ').trim()
        }

        return text.slice(0, maxLength)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[web_fetch error: ${msg.slice(0, 300)}]`
      }
    },
  },
  {
    type: 'read',
    description: 'Read a file and return its content with line numbers. Can read specific line ranges.',
    toolSchema: {
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to working directory)' },
        start_line: { type: 'number', description: 'Start line number (1-based, default: 1)' },
        end_line: { type: 'number', description: 'End line number (inclusive, default: end of file)' },
      },
      required: ['path'],
    },
    async execute(action, context) {
      const { readFileSync, existsSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const rawPath = (action.input?.path as string) ?? action.content.trim()
      const filePath = rawPath.startsWith('/') ? rawPath : resolve(context.workDir, rawPath)

      if (!existsSync(filePath)) {
        return `[read error: file not found: ${rawPath}]`
      }

      try {
        const content = readFileSync(filePath, 'utf-8')
        const allLines = content.split('\n')
        const startLine = Math.max(1, (action.input?.start_line as number) ?? 1)
        const endLine = Math.min(allLines.length, (action.input?.end_line as number) ?? allLines.length)
        const lines = allLines.slice(startLine - 1, endLine)

        const numbered = lines.map((line, i) => `${startLine + i}\t${line}`).join('\n')
        const header = `${rawPath} (lines ${startLine}-${endLine} of ${allLines.length})`

        const result = `${header}\n${numbered}`
        return result.slice(0, 10000) // cap output
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[read error: ${msg.slice(0, 300)}]`
      }
    },
  },
  {
    type: 'explore',
    description: 'Search for files matching a glob pattern. Returns matching file paths.',
    toolSchema: {
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.md")' },
        directory: { type: 'string', description: 'Directory to search in (default: working directory)' },
      },
      required: ['pattern'],
    },
    async execute(action, context) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { resolve } = await import('node:path')
      const execFileAsync = promisify(execFile)

      const pattern = (action.input?.pattern as string) ?? action.content.trim()
      const rawDir = action.input?.directory as string | undefined
      const dir = rawDir ? resolve(context.workDir, rawDir) : context.workDir

      try {
        // Use find + bash glob as portable approach
        const { stdout } = await execFileAsync('bash', [
          '-c',
          `shopt -s globstar nullglob 2>/dev/null; cd "${dir}" && ls -d ${pattern} 2>/dev/null | head -100`,
        ], {
          cwd: dir,
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        })

        const files = stdout.trim()
        if (!files) return `No files matching '${pattern}' in ${dir}`

        const count = files.split('\n').length
        return `Found ${count} file(s) matching '${pattern}':\n${files}`
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[explore error: ${msg.slice(0, 300)}]`
      }
    },
  },
  {
    type: 'edit',
    description: 'Make a precise edit to an existing file. Replaces old_string with new_string. The old_string must match exactly (including whitespace).',
    toolSchema: {
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to working directory)' },
        old_string: { type: 'string', description: 'Exact string to find and replace' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(action, context) {
      const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const rawPath = (action.input?.path as string) ?? ''
      const oldStr = (action.input?.old_string as string) ?? ''
      const newStr = (action.input?.new_string as string) ?? ''

      if (!rawPath || !oldStr) return '[edit error: path and old_string required]'

      const filePath = rawPath.startsWith('/') ? rawPath : resolve(context.workDir, rawPath)
      if (!existsSync(filePath)) return `[edit error: file not found: ${rawPath}]`

      try {
        const content = readFileSync(filePath, 'utf-8')
        const idx = content.indexOf(oldStr)
        if (idx === -1) return `[edit error: old_string not found in ${rawPath}]`
        // Ensure unique match
        if (content.indexOf(oldStr, idx + 1) !== -1) return `[edit error: old_string matches multiple locations in ${rawPath} — provide more context]`

        const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
        writeFileSync(filePath, updated, 'utf-8')
        return `Edited ${rawPath}: replaced ${oldStr.length} chars with ${newStr.length} chars`
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[edit error: ${msg.slice(0, 300)}]`
      }
    },
  },
  {
    type: 'git',
    description: 'Run a git command in the working directory. Supports: status, diff, add, commit, log, revert.',
    toolSchema: {
      properties: {
        command: { type: 'string', description: 'Git subcommand and arguments (e.g. "status", "diff src/loop.ts", "add -A", "commit -m message", "log --oneline -5")' },
      },
      required: ['command'],
    },
    async execute(action, context) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      const command = (action.input?.command as string) ?? action.content.trim()

      // Safety: block destructive commands
      const dangerous = ['push', 'reset --hard', 'clean -f', 'branch -D', 'checkout .', 'restore .']
      if (dangerous.some(d => command.startsWith(d))) {
        return `[git error: "${command}" is blocked for safety. Use shell action if you really need this.]`
      }

      try {
        const { stdout, stderr } = await execFileAsync('git', command.split(/\s+/), {
          cwd: context.workDir,
          timeout: 15_000,
          maxBuffer: 256 * 1024,
        })
        const output = (stdout + stderr).trim()
        return output.slice(0, 3000) || '(no output)'
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[git error: ${msg.slice(0, 500)}]`
      }
    },
  },
  {
    type: 'focus',
    description: 'Update working memory: set current focus, add insight, or update thread. This persists across ticks.',
    toolSchema: {
      properties: {
        set_focus: { type: 'string', description: 'Set current research focus (or "clear" to remove)' },
        add_insight: { type: 'string', description: 'Add a key insight to working memory' },
        thread_id: { type: 'string', description: 'Thread ID to create/update' },
        thread_title: { type: 'string', description: 'Thread title' },
        thread_context: { type: 'string', description: 'Thread context points (comma-separated)' },
      },
    },
    async execute(action, context) {
      if (!context.workingMemory) return '[focus: working memory not available]'
      const tick = context.tickCount ?? 0
      const focus = (action.input?.set_focus as string) ?? undefined
      const insight = (action.input?.add_insight as string) ?? undefined
      const threadId = action.input?.thread_id as string | undefined
      const threadTitle = action.input?.thread_title as string | undefined
      const threadCtx = action.input?.thread_context as string | undefined

      const updates: Parameters<typeof context.workingMemory.update>[1] = {}
      if (focus) updates.focus = focus === 'clear' ? null : focus
      if (insight) updates.insight = insight
      if (threadId && threadTitle) {
        updates.thread = {
          id: threadId,
          title: threadTitle,
          context: threadCtx?.split(',').map(s => s.trim()) ?? [],
        }
      }
      context.workingMemory.update(tick, updates)
      context.workingMemory.save()

      const parts: string[] = []
      if (focus) parts.push(`focus: ${focus}`)
      if (insight) parts.push(`insight saved`)
      if (threadId) parts.push(`thread ${threadId} updated`)
      return `Working memory updated: ${parts.join(', ')}`
    },
  },
  {
    type: 'synthesize',
    description: 'Forced cognitive checkpoint: synthesize accumulated research into a structured proposal. MUST output: (1) gap identified, (2) specific proposal, (3) implementation approach. Use this to transition from research mode to action mode.',
    toolSchema: {
      properties: {
        gap: { type: 'string', description: 'What specific gap or need did you identify from your research?' },
        proposal: { type: 'string', description: 'What exactly do you propose to build? Be specific: filename, purpose, key functions.' },
        approach: { type: 'string', description: 'Implementation approach: what files to read first, what to write, how to verify.' },
      },
      required: ['gap', 'proposal', 'approach'],
    },
    async execute(action, context) {
      const gap = action.input?.gap as string
      const proposal = action.input?.proposal as string
      const approach = action.input?.approach as string

      // Save synthesis to working memory as an active thread
      if (context.workingMemory) {
        const tick = context.tickCount ?? 0
        context.workingMemory.update(tick, {
          focus: proposal,
          insight: `Gap: ${gap}`,
          thread: { id: 'synthesis', title: proposal, context: [gap, approach] },
        })
        context.workingMemory.save()
      }

      return `SYNTHESIS COMPLETE. You now have a plan:\n- Gap: ${gap}\n- Proposal: ${proposal}\n- Approach: ${approach}\n\nNow EXECUTE the approach. Read types if needed, then write the code.`
    },
  },
]
