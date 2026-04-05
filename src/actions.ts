/**
 * Tanren — Action System
 *
 * Parses actions from LLM output and routes them to handlers.
 * Actions are tags in the LLM response: <action:type>content</action:type>
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Action, ActionHandler, ActionContext, ToolDefinition, RiskTier } from './types.js'

/**
 * Extract path from structured input — handles model merging path+content into one field.
 * Constraint Texture: field separation is deterministic → code recovers, not model.
 */
function extractPathAndContent(input: Record<string, unknown>): { path: string; content: string } | null {
  // Ideal: model filled both fields
  if (input.path && input.content) {
    return { path: String(input.path), content: String(input.content) }
  }
  // Fallback: model put everything in content (path on first line)
  const raw = String(input.content ?? input.path ?? '')
  const newlineIdx = raw.indexOf('\n')
  if (newlineIdx === -1) return null
  let path = raw.slice(0, newlineIdx).trim()
  if (path.startsWith('path:')) path = path.slice(5).trim()
  // Validate: first line looks like a path (has / or . or ends with extension)
  if (path.includes('/') || path.includes('.')) {
    return { path, content: raw.slice(newlineIdx + 1) }
  }
  return null
}

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
  respond: 1, remember: 1, search: 1, read: 1, explore: 1, grep: 1, 'clear-inbox': 1, web_search: 1, read_document: 1, worktree: 2,
  // Tier 2: Moderate/additive — execute + log, no verification
  write: 2, append: 2, web_fetch: 2, plan: 2,
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

// === Built-in Action Handlers ===

export const builtinActions: ActionHandler[] = [
  {
    type: 'remember',
    description: 'Store a memory with optional reasoning chain. Use anchor=true for important insights that should persist longer. Include reasoning (WHY) and evidence (WHAT supports it) for deep research chains.',
    toolSchema: {
      properties: {
        content: { type: 'string', description: 'What to remember (the conclusion/insight)' },
        topic: { type: 'string', description: 'Optional topic category (e.g. "design", "debugging")' },
        anchor: { type: 'boolean', description: 'Mark as important — decays 3x slower (0.95 vs 0.85)' },
        reasoning: { type: 'string', description: 'WHY you reached this conclusion — preserves causal chain' },
        evidence: { type: 'string', description: 'Key evidence supporting this insight' },
      },
      required: ['content'],
    },
    async execute(action, context) {
      const tick = context.tickCount
      // Structured input path (from tool_use)
      if (action.input) {
        const topic = action.input.topic as string | undefined
        const content = action.input.content as string
        const anchor = action.input.anchor as boolean | undefined
        const reasoning = action.input.reasoning as string | undefined
        const evidence = action.input.evidence as string | undefined
        await context.memory.remember(content, { topic, tickCount: tick })
        // Write anchored insight to working memory if anchor/reasoning/evidence provided
        if ((anchor || reasoning || evidence) && context.workingMemory) {
          const state = context.workingMemory.getState()
          state.recentInsights.unshift({
            content,
            tick: tick ?? 0,
            relevance: 1.0,
            anchor: anchor ?? false,
            reasoning,
            evidence,
          })
          context.workingMemory.save()
        }
        const extras = [anchor && '⚓anchored', reasoning && 'with reasoning', evidence && 'with evidence'].filter(Boolean)
        return topic
          ? `Remembered to topic: ${topic}${extras.length ? ` (${extras.join(', ')})` : ''}`
          : `Remembered.${extras.length ? ` (${extras.join(', ')})` : ''}`
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
      // Structured input — with fallback for merged path+content
      if (action.input) {
        const extracted = extractPathAndContent(action.input)
        if (extracted) {
          const path = await writeToPath(extracted.path, extracted.content, context)
          return `Written: ${path}`
        }
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
      // Structured input — with fallback for merged path+content
      if (action.input) {
        const extracted = extractPathAndContent(action.input)
        if (extracted) {
          const path = await writeToPath(extracted.path, extracted.content, context, true)
          return `Appended to: ${path}`
        }
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
        return output.slice(0, 8000) // cap output (increased from 2K — code analysis needs room)
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
    type: 'web_search',
    description: 'Search the web and return results. Use for finding documentation, current information, or answers to questions.',
    toolSchema: {
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Max results to return (default: 5)' },
      },
      required: ['query'],
    },
    async execute(action) {
      const query = (action.input?.query as string) ?? action.content.trim()
      const maxResults = (action.input?.max_results as number) ?? 5

      try {
        // Use DuckDuckGo HTML search (no API key needed)
        const encoded = encodeURIComponent(query)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)

        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Tanren/1.0' },
        })
        clearTimeout(timer)

        if (!response.ok) return `[web_search error: HTTP ${response.status}]`

        const html = await response.text()
        // Extract result snippets from DuckDuckGo HTML
        const results: string[] = []
        const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
        let match
        while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
          const url = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0]
          const title = match[2].replace(/<[^>]+>/g, '').trim()
          const snippet = match[3].replace(/<[^>]+>/g, '').trim()
          if (title && snippet) {
            results.push(`${decodeURIComponent(url)}\n  ${title}\n  ${snippet}`)
          }
        }

        if (results.length === 0) return `No results found for "${query}".`
        return `Search results for "${query}":\n\n${results.join('\n\n')}`
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[web_search error: ${msg.slice(0, 300)}]`
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

      let rawPath = (action.input?.path as string) ?? action.content.trim()
      let startLineOverride: number | undefined
      let endLineOverride: number | undefined

      // Recover line range from path — model often writes "file.ts:1-20" instead of separate fields
      const lineRangeMatch = rawPath.match(/^(.+?):(\d+)(?:-(\d+))?$/)
      if (lineRangeMatch && !existsSync(rawPath)) {
        rawPath = lineRangeMatch[1]
        startLineOverride = parseInt(lineRangeMatch[2], 10)
        if (lineRangeMatch[3]) endLineOverride = parseInt(lineRangeMatch[3], 10)
      }

      const filePath = rawPath.startsWith('/') ? rawPath : resolve(context.workDir, rawPath)

      if (!existsSync(filePath)) {
        return `[read error: file not found: ${rawPath}]`
      }

      try {
        const content = readFileSync(filePath, 'utf-8')
        const allLines = content.split('\n')
        const startLine = Math.max(1, startLineOverride ?? (action.input?.start_line as number) ?? 1)
        const endLine = Math.min(allLines.length, endLineOverride ?? (action.input?.end_line as number) ?? allLines.length)
        const lines = allLines.slice(startLine - 1, endLine)

        const numbered = lines.map((line, i) => `${startLine + i}\t${line}`).join('\n')
        const header = `${rawPath} (lines ${startLine}-${endLine} of ${allLines.length})`

        const result = `${header}\n${numbered}`
        // Claude Code pattern: guide progressive narrowing for large files
        const hint = (allLines.length > 200 && endLine - startLine + 1 === allLines.length)
          ? `\n\n[Hint: large file (${allLines.length} lines). Use grep to find specific functions/patterns, then read with start_line/end_line.]`
          : ''
        return result.slice(0, 10000) + hint
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

      let pattern = (action.input?.pattern as string) ?? action.content.trim()
      let rawDir = action.input?.directory as string | undefined

      // Recover: model may write "directory pattern" as one string in content
      if (!rawDir && pattern.includes(' ')) {
        const spaceIdx = pattern.indexOf(' ')
        const possibleDir = pattern.slice(0, spaceIdx)
        // If the first part looks like a directory (has / or is a known dir)
        if (possibleDir.includes('/') || possibleDir === '.') {
          rawDir = possibleDir
          pattern = pattern.slice(spaceIdx + 1).trim()
        }
      }

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
    // Claude Code pattern: Plan mode — design before implementing.
    // Write a structured plan to a file, then execute step by step.
    // Claude Code pattern: worktree isolation for safe experimentation
    // Read PDF/image files — extract text from PDFs, metadata from images
    type: 'read_document',
    description: 'Read a PDF or image file. PDFs: extracts text content. Images: returns dimensions and metadata. Use for analyzing documents and screenshots.',
    toolSchema: {
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
    async execute(action, context) {
      const { resolve } = await import('node:path')
      const { existsSync, readFileSync, statSync } = await import('node:fs')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      const rawPath = (action.input?.path as string) ?? action.content.trim()
      const filePath = rawPath.startsWith('/') ? rawPath : resolve(context.workDir, rawPath)

      if (!existsSync(filePath)) return `[read_document error: file not found: ${rawPath}]`

      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
      const stats = statSync(filePath)

      if (ext === 'pdf') {
        // Extract text from PDF using pdftotext (poppler-utils)
        try {
          const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], {
            timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
          })
          const text = stdout.trim()
          if (!text) return `[PDF: ${rawPath} (${(stats.size / 1024).toFixed(0)}KB) — no extractable text (possibly scanned/image PDF)]`
          return `PDF: ${rawPath} (${(stats.size / 1024).toFixed(0)}KB)\n\n${text.slice(0, 10000)}`
        } catch {
          return `[PDF: pdftotext not available. Install: brew install poppler]`
        }
      }

      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
        // Image: return metadata (vision requires provider support — noted in output)
        try {
          const { stdout } = await execFileAsync('file', ['--brief', filePath], { timeout: 5000 })
          return `Image: ${rawPath} (${(stats.size / 1024).toFixed(0)}KB)\nType: ${stdout.trim()}\n[Note: image content analysis requires vision-capable LLM provider]`
        } catch {
          return `Image: ${rawPath} (${(stats.size / 1024).toFixed(0)}KB, ${ext})`
        }
      }

      return `[read_document: unsupported format '${ext}'. Supported: pdf, png, jpg, gif, webp, svg]`
    },
  },
  {
    type: 'worktree',
    description: 'Create an isolated git worktree for experimental changes. Changes in the worktree do not affect the main working directory. Use for risky modifications you want to test before committing.',
    toolSchema: {
      properties: {
        name: { type: 'string', description: 'Worktree name (creates branch worktree-{name})' },
        action: { type: 'string', description: '"create" to create, "list" to list, "remove" to remove a worktree' },
      },
      required: ['name'],
    },
    async execute(action, context) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { resolve } = await import('node:path')
      const execFileAsync = promisify(execFile)

      const name = (action.input?.name as string) ?? 'experiment'
      const op = (action.input?.action as string) ?? 'create'
      const worktreePath = resolve(context.workDir, '..', `.worktree-${name}`)
      const branch = `worktree-${name}`

      try {
        if (op === 'list') {
          const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd: context.workDir, timeout: 5000 })
          return stdout.trim() || 'No worktrees.'
        }
        if (op === 'remove') {
          await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: context.workDir, timeout: 10000 })
          return `Worktree ${name} removed.`
        }
        // Create
        await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath], { cwd: context.workDir, timeout: 10000 })
        return `Worktree created: ${worktreePath} (branch: ${branch})`
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `[worktree error: ${msg.slice(0, 300)}]`
      }
    },
  },
  {
    type: 'plan',
    description: 'Create or update a structured plan. Write before you build — design the approach, list steps, identify risks. Plans are saved to memory/plans/ for reference across ticks.',
    toolSchema: {
      properties: {
        name: { type: 'string', description: 'Plan name (used as filename)' },
        content: { type: 'string', description: 'Plan content in markdown (goals, steps, risks, acceptance criteria)' },
      },
      required: ['name', 'content'],
    },
    async execute(action, context) {
      const { resolve } = await import('node:path')
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')

      const name = (action.input?.name as string) ?? 'plan'
      const content = (action.input?.content as string) ?? action.content
      const plansDir = resolve(context.workDir, 'memory', 'plans')
      if (!existsSync(plansDir)) mkdirSync(plansDir, { recursive: true })

      const filename = `${name.replace(/[^a-zA-Z0-9-_]/g, '-')}.md`
      const filePath = resolve(plansDir, filename)
      writeFileSync(filePath, content)
      return `Plan saved: ${filename}`
    },
  },
  {
    // Claude Code pattern: Grep enables progressive narrowing (search → locate → read).
    // This is the bridge between explore (find files) and read (read content).
    // Without grep, agents resort to shell grep with 2K output cap — crippling for code analysis.
    type: 'grep',
    description: 'Search file contents for a pattern. Returns matching lines with file paths and line numbers. Use this to locate specific code, functions, or patterns before reading.',
    toolSchema: {
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: { type: 'string', description: 'File or directory to search in (default: working directory)' },
        glob: { type: 'string', description: 'File pattern filter (e.g. "*.ts", "*.py")' },
        context: { type: 'number', description: 'Lines of context around each match (default: 0)' },
      },
      required: ['pattern'],
    },
    async execute(action, context) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { resolve } = await import('node:path')
      const execFileAsync = promisify(execFile)

      const pattern = (action.input?.pattern as string) ?? action.content.trim()
      const rawPath = (action.input?.path as string) ?? '.'
      const searchPath = rawPath.startsWith('/') ? rawPath : resolve(context.workDir, rawPath)
      const glob = action.input?.glob as string | undefined
      const ctxLines = (action.input?.context as number) ?? 0

      const args = ['-rn', '--color=never']
      if (ctxLines > 0) args.push(`-C${ctxLines}`)
      if (glob) args.push(`--include=${glob}`)
      args.push(pattern, searchPath)

      try {
        const { stdout } = await execFileAsync('grep', args, {
          cwd: context.workDir,
          timeout: 10_000,
          maxBuffer: 512 * 1024,
        })
        const lines = stdout.trim().split('\n')
        const capped = lines.slice(0, 50) // max 50 matches
        const result = capped.join('\n')
        if (lines.length > 50) {
          return `${result}\n\n[... ${lines.length - 50} more matches — narrow your pattern]`
        }
        return result || 'No matches found.'
      } catch (err: unknown) {
        const exitCode = (err as { code?: number })?.code
        if (exitCode === 1) return 'No matches found.'
        const msg = err instanceof Error ? err.message : String(err)
        return `[grep error: ${msg.slice(0, 300)}]`
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

      let rawPath = (action.input?.path as string) ?? ''
      let oldStr = (action.input?.old_string as string) ?? ''
      let newStr = (action.input?.new_string as string) ?? ''

      // Recover from text mode: model may use various delimiter formats
      // <<<old_string>>>, ---OLD---, ---old_string---, etc.
      if (!rawPath && action.content) {
        // Generic pattern: path on first line, then any old/new delimiter pair
        const oldDelimiters = /\n(?:<<<\s*old_string\s*>>>|---\s*(?:OLD|old|OLD_STRING|old_string)\s*---)\n/
        const newDelimiters = /\n(?:<<<\s*new_string\s*>>>|---\s*(?:NEW|new|NEW_STRING|new_string)\s*---)\n/

        const oldSplit = action.content.split(oldDelimiters)
        if (oldSplit.length >= 2) {
          rawPath = oldSplit[0].trim()
          const rest = oldSplit.slice(1).join('')
          const newSplit = rest.split(newDelimiters)
          if (newSplit.length >= 2) {
            oldStr = newSplit[0]
            newStr = newSplit.slice(1).join('')
          }
        }
      }

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
  {
    type: 'query-history',
    description: 'Query your own behavioral history. Search past ticks by action type, quality, or duration. Helps you understand your own patterns.',
    toolSchema: {
      properties: {
        action_type: { type: 'string', description: 'Filter by action type (e.g. "write", "respond", "remember")' },
        min_quality: { type: 'number', description: 'Minimum quality score (1-5)' },
        max_duration: { type: 'number', description: 'Maximum duration in seconds' },
      },
    },
    async execute(action, context) {
      const { queryTickHistory } = await import('./memory.js')
      const filter = {
        actionType: action.input?.action_type as string | undefined,
        minQuality: action.input?.min_quality as number | undefined,
        maxDuration: action.input?.max_duration
          ? (action.input.max_duration as number) * 1000  // convert to ms
          : undefined,
      }
      // ticks.jsonl is in memoryDir/journal/ — workDir + memory/ is the convention
      const memoryDir = (await import('node:path')).join(context.workDir, 'memory')
      const results = await queryTickHistory(memoryDir, filter)
      if (results.length === 0) return 'No matching ticks found.'
      return results.map(r =>
        `tick ${r.tick}: ${r.actions.join('→')} (${r.duration}s, q=${r.quality})`
      ).join('\n')
    },
  },
]
