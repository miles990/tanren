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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatResult, TickResult, Action } from './types.js'
import type { TanrenAgent } from './index.js'
import { CONTEXT_MODES } from './context-modes.js'

// Constraint Texture: /chat is a convergence condition, not a prescription.
// Runs runChain() until agent declares converged OR bound hits.
// Wall-clock bound prevents sync HTTP clients from hanging forever.
const CHAT_WALL_CLOCK_MS = 20 * 60 * 1000  // 20 min total chain (sync /chat)
const STREAM_WALL_CLOCK_MS = 30 * 60 * 1000 // 30 min total chain (SSE /chat/stream)

// Aggregate multi-tick results into a single ChatResult envelope.
// Final response = last tick with respond action (or last tick's thought).
function aggregateChain(results: TickResult[], mode: string): ChatResult & { chainTicks: number } {
  const last = results[results.length - 1]
  const allActionTypes: string[] = []
  const filesRead = new Set<string>()
  const filesWritten = new Set<string>()
  let totalDuration = 0
  let totalContextChars = 0
  let respondContent = ''
  // Walk ticks in order — latest respond wins
  for (const r of results) {
    totalDuration += r.observation.duration
    totalContextChars += r.perception.length
    for (const a of r.actions) {
      allActionTypes.push(a.type)
      if (a.type === 'read' || a.type === 'grep') {
        const p = (a as Action).input?.path as string | undefined
        if (p) filesRead.add(p)
      }
      if (a.type === 'write' || a.type === 'edit') {
        const p = (a as Action).input?.path as string | undefined
        if (p) filesWritten.add(p)
      }
      if (a.type === 'respond') {
        const c = (a as Action & { content?: string }).content
        if (c) respondContent = c
      }
    }
  }
  return {
    response: respondContent,
    thought: last.thought,
    actions: allActionTypes,
    duration: totalDuration,
    quality: last.observation.outputQuality,
    meta: {
      mode,
      filesRead: [...filesRead],
      filesWritten: [...filesWritten],
      toolsUsed: [...new Set(allActionTypes)],
      hypotheses: 0,
      contextChars: totalContextChars,
    },
    chainTicks: results.length,
  }
}

export interface ServeOptions {
  port?: number
  serviceName?: string
  memoryDir?: string
  /** @deprecated No longer used — all chat goes through tick pipeline */
  identityPath?: string
  /** Called before each tick — agent-specific setup (e.g., clear inbox files) */
  onBeforeChat?: (from: string, text: string) => void | Promise<void>
  /** Called after each tick — agent-specific cleanup */
  onAfterChat?: (result: ChatResult) => void | Promise<void>
  /** AEP §3.1 Unit declaration — exposed under /health.unit namespace when provided. */
  unit?: {
    unit_id: string
    available_modes: readonly string[]
  }
  /** @deprecated No longer used — all chat goes through tick pipeline */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers?: Record<string, any>
  /** @deprecated No longer used — all chat goes through tick pipeline */
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

  // All paths (/chat, /chat/stream, autonomous) go through agent.chat() → tick pipeline.
  // Streaming is handled via onStream callback, not a separate SDK path.

  async function handleChat(from: string, text: string): Promise<ChatResult & { tick: number; chainTicks: number }> {
    if (options.onBeforeChat) await options.onBeforeChat(from, text)

    // Constraint Texture: convergence condition, not prescription.
    // Agent declares `converged: yes/no` in reflection. Framework honors.
    // Wall-clock cap prevents sync HTTP hang (agent may still be working when cap hits).
    const results = await (agent as TanrenAgent & {
      runChain(message?: string, options?: { from?: string; wallClockMs?: number }): Promise<TickResult[]>
    }).runChain(text, { from, wallClockMs: CHAT_WALL_CLOCK_MS })

    if (!results.length) {
      throw new Error('runChain returned no ticks')
    }

    tickCount += results.length
    // getCurrentMode is optional — use last known mode from memory
    const loopWithMode = agent as TanrenAgent & { getCurrentMode?: () => string }
    const mode = loopWithMode.getCurrentMode?.() ?? 'unknown'
    const chatResult = aggregateChain(results, mode)

    if (options.onAfterChat) await options.onAfterChat(chatResult)

    return { ...chatResult, tick: tickCount, chainTicks: results.length }
  }

  /**
   * Streaming chat via SSE — same tick pipeline as /chat, with real-time text chunks.
   * Events: text (LLM streaming chunk), result (final response), done (stream end).
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

    try {
      // Multi-tick chain with per-tick SSE events.
      // Each tick: emit `tick-start`, stream text via setStreamCallback, emit `tick-end`.
      // Final: emit `result` + `done`.
      const results = await (agent as TanrenAgent & {
        runChain(message?: string, options?: { from?: string; wallClockMs?: number; onTick?: (result: TickResult, tickNum: number) => void | Promise<void> }): Promise<TickResult[]>
      }).runChain(text, {
        from,
        wallClockMs: STREAM_WALL_CLOCK_MS,
        onTick: (tickResult, tickNum) => {
          sse('tick-end', {
            tickNum,
            actions: tickResult.actions.map(a => a.type),
            duration: tickResult.observation.duration,
            quality: tickResult.observation.outputQuality,
          })
        },
      })

      tickCount += results.length
      const loopWithMode = agent as TanrenAgent & { getCurrentMode?: () => string }
      const mode = loopWithMode.getCurrentMode?.() ?? 'unknown'
      const chatResult = aggregateChain(results, mode)
      if (options.onAfterChat) await options.onAfterChat(chatResult)
      recordTick(tickCount, Date.now() - start, chatResult.actions ?? [], chatResult.meta?.mode ?? 'unknown')
      sse('result', { response: chatResult.response, chainTicks: chatResult.chainTicks })
      sse('done', { tick: tickCount, chainTicks: results.length, duration: Date.now() - start, actions: chatResult.actions })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      recordTick(tickCount, Date.now() - start, [], 'error', msg)
      sse('error', { error: msg })
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
