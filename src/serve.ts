/**
 * Tanren — Built-in HTTP Server
 *
 * Standard API that all Tanren agents get for free.
 * Agents define identity + plugins + skills. Framework provides the server.
 *
 * Endpoints:
 *   POST /chat  { from, text, discussionId? } → { response, actions, duration, quality, meta }
 *   GET  /health → { status, service, ticking, tickCount, pool }
 *   GET  /status → live-status.json
 *
 * Agent Pool: supports concurrent /chat requests with different discussionIds.
 * Each discussionId gets its own agent instance from the pool.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatResult, TickResult, Action, TanrenConfig } from './types.js'
import type { TanrenAgent } from './index.js'
import { createAgent } from './index.js'
import { CONTEXT_MODES } from './context-modes.js'

const CHAT_WALL_CLOCK_MS = 20 * 60 * 1000
const STREAM_WALL_CLOCK_MS = 30 * 60 * 1000

// === Agent Pool ===

const DEFAULT_MAX_POOL_SIZE = 3
const IDLE_CLEANUP_MS = 30 * 60 * 1000 // 30 min

interface PoolEntry {
  agent: TanrenAgent
  busy: boolean
  discussionId: string | null
  lastUsed: number
  index: number
}

interface AgentPool {
  acquire(discussionId?: string): PoolEntry | null
  release(entry: PoolEntry): void
  status(): { active: number; idle: number; total: number; max: number; entries: Array<{ index: number; busy: boolean; discussionId: string | null }> }
  destroy(): void
}

function createAgentPool(primaryAgent: TanrenAgent, config: TanrenConfig | undefined, maxSize: number): AgentPool {
  let nextIndex = 1 // monotonic counter — never reuse indices after splice
  const entries: PoolEntry[] = [
    { agent: primaryAgent, busy: false, discussionId: null, lastUsed: Date.now(), index: 0 },
  ]
  const affinityMap = new Map<string, number>() // discussionId → pool index (survives cleanup)

  function acquire(discussionId?: string): PoolEntry | null {
    // 1. Affinity match — same discussionId, idle
    if (discussionId) {
      const affinityIdx = affinityMap.get(discussionId)
      if (affinityIdx !== undefined) {
        const entry = entries.find(e => e.index === affinityIdx && !e.busy)
        if (entry) {
          entry.busy = true
          entry.discussionId = discussionId
          entry.lastUsed = Date.now()
          return entry
        }
      }
    }

    // 2. Any idle agent
    const idle = entries.find(e => !e.busy)
    if (idle) {
      idle.busy = true
      idle.discussionId = discussionId ?? null
      idle.lastUsed = Date.now()
      if (discussionId) affinityMap.set(discussionId, idle.index)
      return idle
    }

    // 3. Pool not full — create new agent
    if (entries.length < maxSize && config) {
      const newAgent = createAgent(config)
      const idx = nextIndex++
      const entry: PoolEntry = { agent: newAgent, busy: true, discussionId: discussionId ?? null, lastUsed: Date.now(), index: idx }
      entries.push(entry)
      if (discussionId) affinityMap.set(discussionId, idx)
      return entry
    }

    // 4. Pool full + all busy
    return null
  }

  function release(entry: PoolEntry): void {
    entry.busy = false
    entry.lastUsed = Date.now()
  }

  // Idle cleanup — remove agents idle > IDLE_CLEANUP_MS (keep at least one)
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (let i = entries.length - 1; i > 0; i--) {
      const e = entries[i]
      if (!e.busy && (now - e.lastUsed) > IDLE_CLEANUP_MS) {
        entries.splice(i, 1)
      }
    }
  }, 60_000)

  return {
    acquire,
    release,
    destroy() { clearInterval(cleanupTimer) },
    status() {
      const active = entries.filter(e => e.busy).length
      return {
        active,
        idle: entries.length - active,
        total: entries.length,
        max: maxSize,
        entries: entries.map(e => ({ index: e.index, busy: e.busy, discussionId: e.discussionId })),
      }
    },
  }
}

// Aggregate multi-tick results into a single ChatResult envelope.
// Final response priority:
//   1. Last respond in the LAST tick (agent's intended final answer)
//   2. Last respond in any earlier tick (fallback — agent responded early)
//   3. Last tick's thought (graceful degradation — agent forgot to respond)
function aggregateChain(results: TickResult[], mode: string): ChatResult & { chainTicks: number } {
  const last = results[results.length - 1]
  const allActionTypes: string[] = []
  const filesRead = new Set<string>()
  const filesWritten = new Set<string>()
  let totalDuration = 0
  let totalContextChars = 0
  let respondContent = ''
  let lastTickRespond = ''
  // Walk ticks in order — latest respond wins, but prefer last tick's respond
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    totalDuration += r.observation.duration
    totalContextChars += r.perception.length
    const isLastTick = i === results.length - 1
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
        if (c) {
          respondContent = c
          if (isLastTick) lastTickRespond = c
        }
      }
    }
  }
  // Prefer last tick's respond over earlier ticks' respond. If neither, fallback to thought.
  const finalResponse = lastTickRespond || respondContent || last.thought
  return {
    response: finalResponse,
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
  /** Called before each tick — agent-specific setup (e.g., clear inbox files).
   *  When pool is active, `agentIndex` identifies which pool agent is handling. */
  onBeforeChat?: (from: string, text: string, agentIndex?: number) => void | Promise<void>
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
  /** Agent config for pool — allows creating additional agent instances for parallel discussions.
   *  Without this, pool size is always 1 (singleton behavior). */
  agentConfig?: TanrenConfig
  /** Max concurrent pool agents (default: 3). Does not include the autonomous loop agent. */
  maxPoolSize?: number
}

export function serve(agent: TanrenAgent, options: ServeOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10)
  const serviceName = options.serviceName ?? 'tanren-agent'
  const memoryDir = options.memoryDir ?? './memory'
  let tickCount = 0
  let errorCount = 0
  const startTime = Date.now()

  // Agent Pool — enables concurrent /chat with different discussionIds
  const maxPoolSize = options.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE
  const pool = createAgentPool(agent, options.agentConfig, maxPoolSize)

  // Autonomous loop — independent from pool, never blocks /chat
  let autonomousBusy = false

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
  })
  process.on('unhandledRejection', (reason) => {
    console.error(`[${serviceName}] UNHANDLED: ${reason}`)
    errorCount++
  })

  async function handleChat(poolEntry: PoolEntry, from: string, text: string, sessionId?: string): Promise<ChatResult & { tick: number; chainTicks: number; sessionId?: string }> {
    const ag = poolEntry.agent
    if (options.onBeforeChat) await options.onBeforeChat(from, text, poolEntry.index)

    if (sessionId) ag.setSessionId(sessionId)
    else ag.setSessionId(null)

    const results = await (ag as TanrenAgent & {
      runChain(message?: string, options?: { from?: string; wallClockMs?: number }): Promise<TickResult[]>
    }).runChain(text, { from, wallClockMs: CHAT_WALL_CLOCK_MS })

    if (!results.length) {
      throw new Error('runChain returned no ticks')
    }

    tickCount += results.length
    const loopWithMode = ag as TanrenAgent & { getCurrentMode?: () => string }
    const mode = loopWithMode.getCurrentMode?.() ?? 'unknown'
    const chatResult = aggregateChain(results, mode)
    const resultSessionId = ag.getSessionId() ?? undefined
    if (options.onAfterChat) await options.onAfterChat(chatResult)

    return { ...chatResult, tick: tickCount, chainTicks: results.length, ...(resultSessionId ? { sessionId: resultSessionId } : {}) }
  }

  async function handleChatStream(poolEntry: PoolEntry, from: string, text: string, res: ServerResponse, sessionId?: string): Promise<void> {
    const ag = poolEntry.agent
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    if (options.onBeforeChat) await options.onBeforeChat(from, text, poolEntry.index)

    if (sessionId) ag.setSessionId(sessionId)
    else ag.setSessionId(null)

    const start = Date.now()

    try {
      const results = await (ag as TanrenAgent & {
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
      const loopWithMode = ag as TanrenAgent & { getCurrentMode?: () => string }
      const mode = loopWithMode.getCurrentMode?.() ?? 'unknown'
      const chatResult = aggregateChain(results, mode)
      const resultSessionId = ag.getSessionId() ?? undefined
      if (options.onAfterChat) await options.onAfterChat(chatResult)
      recordTick(tickCount, Date.now() - start, chatResult.actions ?? [], chatResult.meta?.mode ?? 'unknown')
      sse('result', { response: chatResult.response, chainTicks: chatResult.chainTicks, ...(resultSessionId ? { sessionId: resultSessionId } : {}) })
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
      const lastTick = recentTicks[recentTicks.length - 1]
      const unit = options.unit ?? { unit_id: serviceName, available_modes: CONTEXT_MODES }
      const unitNamespace = {
        unit: {
          unit_id: unit.unit_id,
          available_modes: unit.available_modes,
          current_mode: lastTick?.mode ?? null,
        },
      }
      const poolStatus = pool.status()
      json(res, 200, {
        status: errorRate > 50 ? 'degraded' : 'ok',
        service: serviceName,
        ticking: poolStatus.active > 0 || autonomousBusy,
        tickCount,
        uptime,
        errors: errorCount,
        errorRate: `${errorRate}%`,
        avgTickDuration: `${avgDuration}ms`,
        recentTicks: recentTicks.slice(-5),
        pool: poolStatus,
        autonomous: { busy: autonomousBusy },
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
      let parsed: { from?: string; text?: string; sessionId?: string; discussionId?: string }
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      if (!text.trim()) { json(res, 400, { error: 'Empty text' }); return }

      const poolEntry = pool.acquire(parsed.discussionId)
      if (!poolEntry) {
        const ps = pool.status()
        res.setHeader('Retry-After', '30')
        json(res, 429, { error: `${serviceName} is thinking (${ps.active}/${ps.max} agents busy), try again later`, estimatedWaitMs: 30000 })
        return
      }

      const tickStart = Date.now()
      try {
        const result = await handleChat(poolEntry, from, text, parsed.sessionId)
        recordTick(tickCount, Date.now() - tickStart, result.actions ?? [], result.meta?.mode ?? 'unknown')
        json(res, 200, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordTick(tickCount, Date.now() - tickStart, [], 'error', msg)
        json(res, 500, { error: msg })
      } finally {
        pool.release(poolEntry)
      }

    } else if (url.pathname === '/chat/stream' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: { from?: string; text?: string; sessionId?: string; discussionId?: string }
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      if (!text.trim()) { json(res, 400, { error: 'Empty text' }); return }

      const poolEntry = pool.acquire(parsed.discussionId)
      if (!poolEntry) {
        const ps = pool.status()
        res.setHeader('Retry-After', '30')
        json(res, 429, { error: `${serviceName} is thinking (${ps.active}/${ps.max} agents busy), try again later`, estimatedWaitMs: 30000 })
        return
      }

      try {
        await handleChatStream(poolEntry, from, text, res, parsed.sessionId)
      } finally {
        pool.release(poolEntry)
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
            description: 'Send a message, get a response (blocks until complete). Supports concurrent discussions via discussionId.',
            body: { from: 'string', text: 'string (required)', discussionId: 'string (optional — routes to dedicated pool agent)' },
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
          'GET /health': { description: 'Health check', returns: { status: 'ok', ticking: 'boolean', tickCount: 'number', pool: '{ active, idle, total, max }' } },
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

  const shutdown = () => { console.log(`\n[${serviceName}] Stopping...`); pool.destroy(); server.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return {
    server,
    /** Is any tick/chat currently in progress (pool or autonomous)? */
    isTicking: () => pool.status().active > 0 || autonomousBusy,
    /**
     * Run a function with exclusive access to the autonomous agent.
     * Returns null if autonomous agent is already busy (non-blocking).
     * Independent from pool — never blocks /chat endpoints.
     */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
      if (autonomousBusy) return null
      autonomousBusy = true
      try { return await fn() } finally { autonomousBusy = false }
    },
    /** Get pool status for external monitoring */
    getPoolStatus: () => pool.status(),
  }
}

export type ServeHandle = ReturnType<typeof serve>
