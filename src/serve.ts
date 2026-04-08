/**
 * Tanren — Built-in HTTP Server
 *
 * Standard API that all Tanren agents get for free.
 * Agents define identity + plugins + skills. Framework provides the server.
 *
 * Endpoints:
 *   POST /chat  { from, text } → { response, actions, duration, quality, meta }
 *   GET  /health → { status, service, ticking, tickCount }
 *   GET  /status → live-status.json
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatResult } from './types.js'
import { CONTEXT_MODES } from './context-modes.js'

export interface TanrenAgent {
  chat(message: string, options?: { from?: string }): Promise<ChatResult>
  isRunning(): boolean
}

export interface ServeOptions {
  port?: number
  serviceName?: string
  memoryDir?: string
  /** Identity file path (soul.md) — used as system prompt for SDK chat */
  identityPath?: string
  /** Called before each tick — agent-specific setup (e.g., clear inbox files) */
  onBeforeChat?: (from: string, text: string) => void | Promise<void>
  /** Called after each tick — agent-specific cleanup */
  onAfterChat?: (result: ChatResult) => void | Promise<void>
  /** AEP §3.1 Unit declaration — exposed under /health.unit namespace when provided.
   *  current_mode is derived from recentTicks[-1].mode at request time; the invariant
   *  current_mode ∈ available_modes is maintained by construction when available_modes
   *  matches the actual mode vocabulary driving recentTicks (e.g., CONTEXT_MODES). */
  unit?: {
    unit_id: string
    available_modes: readonly string[]
  }
  /**
   * MCP servers to expose to the /chat Agent SDK subprocess. Format matches
   * Claude Agent SDK's `options.mcpServers` field — an object mapping server
   * name to McpStdioServerConfig / McpSSEServerConfig / McpHttpServerConfig.
   * Use this to give the agent cross-agent communication tools (e.g. pointing
   * at mini-agent's `mcp-agent.json` lets the agent call `agent_chat` /
   * `agent_ask` / `agent_discuss` to talk to Kuro).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers?: Record<string, any>
  /**
   * Additional allowed tool names beyond the default set. Useful for adding
   * MCP tool permissions like `mcp__agent__agent_chat` alongside the default
   * Read/Write/Edit/Bash/Grep/Glob/Agent tools.
   */
  additionalAllowedTools?: string[]
}

export function serve(agent: TanrenAgent, options: ServeOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10)
  const serviceName = options.serviceName ?? 'tanren-agent'
  const memoryDir = options.memoryDir ?? './memory'
  let ticking = false
  let tickCount = 0
  let errorCount = 0
  const startTime = Date.now()

  // Production-grade: structured tick telemetry
  const recentTicks: Array<{
    tick: number
    timestamp: string
    duration: number
    actions: string[]
    mode: string
    error?: string
  }> = []
  const MAX_RECENT = 50

  function recordTick(tick: number, duration: number, actions: string[], mode: string, error?: string) {
    recentTicks.push({ tick, timestamp: new Date().toISOString(), duration, actions, mode, error })
    if (recentTicks.length > MAX_RECENT) recentTicks.shift()
    if (error) errorCount++
  }

  // Production-grade: process-level resilience
  process.on('uncaughtException', (err) => {
    console.error(`[${serviceName}] UNCAUGHT: ${err.message}`)
    errorCount++
    // Don't exit — keep serving
  })
  process.on('unhandledRejection', (reason) => {
    console.error(`[${serviceName}] UNHANDLED: ${reason}`)
    errorCount++
  })

  // Try to load Agent SDK for direct chat (same path as tanren chat CLI)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkQuery: any = null
  let sdkSessionId: string | undefined
  let identity = ''
  void (async () => {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      sdkQuery = sdk.query
      if (options.identityPath && existsSync(options.identityPath)) {
        identity = readFileSync(options.identityPath, 'utf-8')
      }
      console.log(`[${serviceName}] Agent SDK available — /chat uses direct SDK query`)
    } catch {
      console.log(`[${serviceName}] Agent SDK not available — /chat uses Tanren loop`)
    }
  })()

  function buildSdkOptions() {
    const baseAllowedTools = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent']
    const allowedTools = options.additionalAllowedTools
      ? [...baseAllowedTools, ...options.additionalAllowedTools]
      : baseAllowedTools
    return {
      cwd: options.memoryDir ? join(options.memoryDir, '..') : process.cwd(),
      additionalDirectories: ['/Users'],
      allowedTools,
      maxBudgetUsd: 30,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    }
  }

  function buildPrompt(from: string, text: string): string {
    return identity
      ? `${identity}\n\n---\nMessage from ${from}:\n${text}`
      : `Message from ${from}:\n${text}`
  }

  async function handleChat(from: string, text: string): Promise<ChatResult & { tick: number }> {
    if (options.onBeforeChat) await options.onBeforeChat(from, text)

    let chatResult: ChatResult

    if (sdkQuery) {
      // Direct SDK path — same as tanren chat CLI
      const prompt = buildPrompt(from, text)
      let result = ''
      const actions: string[] = []
      const start = Date.now()

      for await (const message of sdkQuery({ prompt, options: buildSdkOptions() })) {
        if (!sdkSessionId && 'session_id' in message) {
          sdkSessionId = message.session_id as string
        }
        if (message.type === 'assistant') {
          const m = message as { message: { content: Array<{ type: string; name?: string }> } }
          for (const block of m.message.content) {
            if (block.type === 'tool_use' && block.name) actions.push(block.name)
          }
        }
        if ('result' in message) {
          result = (message as { result: string }).result
        }
      }

      chatResult = {
        response: result,
        thought: '',
        actions,
        duration: Date.now() - start,
        quality: 4,
        meta: { mode: 'interaction', filesRead: [], filesWritten: [], toolsUsed: actions, hypotheses: 0, contextChars: 0 },
      } as ChatResult
    } else {
      // Fallback: Tanren loop path
      chatResult = await agent.chat(text, { from })
    }

    tickCount++
    if (options.onAfterChat) await options.onAfterChat(chatResult)

    return { ...chatResult, tick: tickCount } as ChatResult & { tick: number }
  }

  /**
   * Streaming chat via SSE — sends events as the SDK processes.
   * Events: action (tool use), text (partial response), result (final), done (stream end).
   * Fallback: if SDK unavailable, sends single result event from Tanren loop.
   */
  async function handleChatStream(from: string, text: string, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    if (options.onBeforeChat) await options.onBeforeChat(from, text)

    const start = Date.now()

    if (sdkQuery) {
      const prompt = buildPrompt(from, text)
      let result = ''
      const actions: string[] = []

      try {
        for await (const message of sdkQuery({ prompt, options: buildSdkOptions() })) {
          if (!sdkSessionId && 'session_id' in message) {
            sdkSessionId = message.session_id as string
          }
          if (message.type === 'assistant') {
            const m = message as { message: { content: Array<{ type: string; name?: string; text?: string }> } }
            for (const block of m.message.content) {
              if (block.type === 'tool_use' && block.name) {
                actions.push(block.name)
                sse('action', { tool: block.name })
              }
              if (block.type === 'text' && block.text) {
                sse('text', { text: block.text })
              }
            }
          }
          if ('result' in message) {
            result = (message as { result: string }).result
            sse('result', { response: result })
          }
        }

        const duration = Date.now() - start
        tickCount++
        const chatResult: ChatResult = {
          response: result, thought: '', actions, duration, quality: 4,
          meta: { mode: 'interaction', filesRead: [], filesWritten: [], toolsUsed: actions, hypotheses: 0, contextChars: 0 },
        }
        if (options.onAfterChat) await options.onAfterChat(chatResult)
        recordTick(tickCount, duration, actions, 'interaction')
        sse('done', { tick: tickCount, duration, actions })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordTick(tickCount, Date.now() - start, actions, 'error', msg)
        sse('error', { error: msg })
      }
    } else {
      // Fallback: Tanren loop — not streamable, send single result
      try {
        const chatResult = await agent.chat(text, { from })
        tickCount++
        if (options.onAfterChat) await options.onAfterChat(chatResult)
        recordTick(tickCount, Date.now() - start, chatResult.actions ?? [], chatResult.meta?.mode ?? 'unknown')
        sse('result', { response: chatResult.response })
        sse('done', { tick: tickCount, duration: Date.now() - start, actions: chatResult.actions })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordTick(tickCount, Date.now() - start, [], 'error', msg)
        sse('error', { error: msg })
      }
    }

    res.end()
  }

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (url.pathname === '/health' && req.method === 'GET') {
      const uptime = Math.round((Date.now() - startTime) / 1000)
      const avgDuration = recentTicks.length > 0
        ? Math.round(recentTicks.reduce((s, t) => s + t.duration, 0) / recentTicks.length)
        : 0
      const errorRate = tickCount > 0 ? Math.round((errorCount / tickCount) * 100) : 0
      // AEP §3.1 Unit state — every tanren agent is AEP-Unit-compliant by default.
      // Default: unit_id from serviceName, available_modes from CONTEXT_MODES (real
      // context-modes vocabulary). Agents can override via opts.unit.
      // current_mode derived from recentTicks[-1].mode at request time.
      // Invariant `current_mode ∈ available_modes` holds by construction because
      // both trace to the same source (context-modes.ts) when defaults are used.
      const lastTick = recentTicks[recentTicks.length - 1]
      const unit = options.unit ?? { unit_id: serviceName, available_modes: CONTEXT_MODES }
      const unitNamespace = {
        unit: {
          unit_id: unit.unit_id,
          available_modes: unit.available_modes,
          current_mode: lastTick?.mode ?? null,
        },
      }
      json(res, 200, {
        status: errorRate > 50 ? 'degraded' : 'ok',
        service: serviceName,
        ticking,
        tickCount,
        uptime,
        errors: errorCount,
        errorRate: `${errorRate}%`,
        avgTickDuration: `${avgDuration}ms`,
        recentTicks: recentTicks.slice(-5),
        ...unitNamespace,
      })

    } else if (url.pathname === '/status' && req.method === 'GET') {
      try {
        const statusPath = join(memoryDir, 'state', 'live-status.json')
        const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
        json(res, 200, status)
      } catch { json(res, 200, { phase: 'unknown' }) }

    } else if (url.pathname === '/chat' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: { from?: string; text?: string }
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      if (!text.trim()) { json(res, 400, { error: 'Empty text' }); return }
      if (ticking) { json(res, 429, { error: `${serviceName} is thinking, try again later` }); return }

      ticking = true
      const tickStart = Date.now()
      try {
        const result = await handleChat(from, text)
        recordTick(tickCount, Date.now() - tickStart, result.actions ?? [], result.meta?.mode ?? 'unknown')
        json(res, 200, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordTick(tickCount, Date.now() - tickStart, [], 'error', msg)
        json(res, 500, { error: msg })
      } finally {
        ticking = false
      }

    } else if (url.pathname === '/chat/stream' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: { from?: string; text?: string }
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      if (!text.trim()) { json(res, 400, { error: 'Empty text' }); return }
      if (ticking) { json(res, 429, { error: `${serviceName} is thinking, try again later` }); return }

      ticking = true
      try {
        await handleChatStream(from, text, res)
      } finally {
        ticking = false
      }

    } else if (url.pathname === '/' && req.method === 'GET') {
      // Self-documenting root — any visitor immediately knows what this agent does
      // Convergence condition: no documentation needed, the interface IS the documentation
      json(res, 200, {
        agent: serviceName,
        protocol: 'tanren/1.0',
        description: 'Tanren AI agent — perception-driven, learning-aware',
        endpoints: {
          'POST /chat': {
            description: 'Send a message, get a response (blocks until complete)',
            body: { from: 'string', text: 'string (required)' },
            returns: {
              response: 'string — agent response (human-readable)',
              actions: 'string[] — tools used this tick',
              duration: 'number — ms',
              quality: 'number — 1-5',
              meta: {
                mode: 'research | interaction | execution | verification',
                filesRead: 'string[] — files examined',
                filesWritten: 'string[] — files modified',
                toolsUsed: 'string[] — unique tools called',
                contextChars: 'number — perception context size',
              },
            },
            errors: { 400: 'Invalid JSON or empty text', 429: 'Agent is thinking', 500: 'Internal error' },
          },
          'POST /chat/stream': {
            description: 'Send a message, get SSE stream (real-time events as agent works)',
            body: { from: 'string', text: 'string (required)' },
            stream_events: {
              action: '{ tool: string } — tool invocation',
              text: '{ text: string } — partial response text',
              result: '{ response: string } — final response',
              done: '{ tick, duration, actions } — stream complete',
              error: '{ error: string } — on failure',
            },
            errors: { 400: 'Invalid JSON or empty text', 429: 'Agent is thinking' },
          },
          'GET /health': { description: 'Health check', returns: { status: 'ok', ticking: 'boolean', tickCount: 'number' } },
          'GET /status': { description: 'Live agent status from working memory' },
        },
        capabilities: {
          tools: ['read', 'write', 'edit', 'grep', 'explore', 'shell', 'search', 'web_search', 'web_fetch',
                  'delegate', 'plan', 'hypothesize', 'handoff', 'remember', 'respond', 'worktree', 'read_document'],
          modes: ['research', 'interaction', 'execution', 'verification'],
          features: ['context-mode-filtering', 'auto-verify-ts', 'read-before-edit', 'response-quality-gate',
                     'behavioral-floor-synthesis', 'memory-anchoring', 'semantic-compression', 'hypothesis-tracking'],
        },
      })
    } else {
      json(res, 404, { error: `Not found. Visit / for API documentation.` })
    }
  })

  server.listen(port, () => {
    console.log(`[${serviceName}] Server on port ${port}`)
    console.log(`[${serviceName}] POST /chat — { "from": "user", "text": "message" }`)
    console.log(`[${serviceName}] GET  /health | GET /status`)
  })

  const shutdown = () => { console.log(`\n[${serviceName}] Stopping...`); server.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return {
    server,
    /** Is a tick/chat currently in progress? */
    isTicking: () => ticking,
    /**
     * Run a function with exclusive access to the ticking mutex.
     * Returns null if already ticking (non-blocking). Use this for
     * autonomous loops that share the mutex with /chat endpoints.
     */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
      if (ticking) return null
      ticking = true
      try { return await fn() } finally { ticking = false }
    },
  }
}

export type ServeHandle = ReturnType<typeof serve>
