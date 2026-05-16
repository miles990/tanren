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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatResult, TickResult, Action, TanrenConfig, PromptContentBlock } from './types.js'
import type { TanrenAgent } from './index.js'
import { createAgent } from './index.js'
import { CONTEXT_MODES } from './context-modes.js'
import { handleArtifactHttpRoute } from './artifact-http.js'
import type { ArtifactProviderSelection } from './artifact-types.js'
import { handleLongTaskHttpRoute } from './long-task-http.js'
import type { LongTaskController } from './long-task.js'
import { handleAnupHttpRoute } from './anup-http.js'
import { getAnupWorkbenchHtml } from './anup-workbench.js'
import { FileAgentUIStore, chatResultToAnupEnvelope } from './anup.js'
import type { ModelIO, ModelRequest, ModelRouteDecision, ModelRouteRequirement } from './model-io.js'

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

interface ChatBody {
  from?: string
  text?: string
  sessionId?: string
  discussionId?: string
  attachments?: unknown
}

interface ModelRoutePreviewBody {
  text?: string
  attachments?: unknown
  requirement?: ModelRouteRequirement
}

interface ServeModelRouter {
  providers: ModelIO[]
  route(request: ModelRequest, requirement?: ModelRouteRequirement): ModelRouteDecision
}

function guessMediaType(uri: string): string {
  if (/\.png($|\?)/i.test(uri)) return 'image/png'
  if (/\.jpe?g($|\?)/i.test(uri)) return 'image/jpeg'
  if (/\.webp($|\?)/i.test(uri)) return 'image/webp'
  if (/\.gif($|\?)/i.test(uri)) return 'image/gif'
  if (/\.mp3($|\?)/i.test(uri)) return 'audio/mpeg'
  if (/\.wav($|\?)/i.test(uri)) return 'audio/wav'
  if (/\.mp4($|\?)/i.test(uri)) return 'video/mp4'
  if (/\.pdf($|\?)/i.test(uri)) return 'application/pdf'
  return 'application/octet-stream'
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = value == null ? fallback : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback
}

function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function readTextSnippet(path: string, maxChars: number): string | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf-8')
    return text.length > maxChars ? text.slice(0, maxChars) : text
  } catch {
    return null
  }
}

function readJsonlTail(path: string, limit: number): unknown[] {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line) as unknown } catch { return { raw: line } }
      })
  } catch {
    return []
  }
}

function listRecentMarkdown(dir: string, limit: number): Array<{ path: string; name: string; updatedAt: string; excerpt: string }> {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const path = join(dir, name)
        const stat = statSync(path)
        return {
          path,
          name,
          updatedAt: stat.mtime.toISOString(),
          excerpt: readTextSnippet(path, 2000) ?? '',
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
  } catch {
    return []
  }
}

function buildBehaviorDigest(
  tickEntries: unknown[],
  inProcessTicks: Array<{ tick: number; timestamp: string; duration: number; actions: string[]; mode: string; error?: string }>,
) {
  const actionCounts = new Map<string, number>()
  const modes = new Map<string, number>()
  let totalDuration = 0
  let qualityCount = 0
  let qualityTotal = 0
  let errors = 0

  for (const entry of tickEntries) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const actions = Array.isArray(item.actions)
      ? item.actions.map(action => typeof action === 'string' ? action : typeof action === 'object' && action ? String((action as Record<string, unknown>).type ?? '') : '').filter(Boolean)
      : []
    for (const action of actions) actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1)
    const mode = typeof item.mode === 'string' ? item.mode : typeof item.contextMode === 'string' ? item.contextMode : 'unknown'
    modes.set(mode, (modes.get(mode) ?? 0) + 1)
    const observation = typeof item.observation === 'object' && item.observation ? item.observation as Record<string, unknown> : {}
    if (typeof observation.duration === 'number') totalDuration += observation.duration
    const quality = typeof observation.outputQuality === 'number'
      ? observation.outputQuality
      : typeof observation.quality === 'number'
        ? observation.quality
        : null
    if (quality != null) {
      qualityTotal += quality
      qualityCount++
    }
    if (typeof item.error === 'string' || observation.actionsFailed && Number(observation.actionsFailed) > 0) errors++
  }

  return {
    tickCount: tickEntries.length,
    inProcessRecentTicks: inProcessTicks.slice(-20),
    averageDurationMs: tickEntries.length ? Math.round(totalDuration / tickEntries.length) : 0,
    averageQuality: qualityCount ? Number((qualityTotal / qualityCount).toFixed(2)) : null,
    errors,
    actionCounts: Object.fromEntries([...actionCounts.entries()].sort((a, b) => b[1] - a[1])),
    modes: Object.fromEntries([...modes.entries()].sort((a, b) => b[1] - a[1])),
  }
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
  cleanupTimer.unref?.()

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
  /** Extra health metadata supplied by the concrete agent instance. */
  health?: () => Record<string, unknown>
  /** Declared runtime capabilities exposed under /health.capabilities. */
  capabilities?: unknown
  /** Artifact providers exposed through /artifacts endpoints. */
  artifacts?: ArtifactProviderSelection
  /** Resumable long task controller exposed through /tasks endpoints. */
  longTasks?: LongTaskController
  /** Shared model router used for capability previews without invoking cloud LLM calls. */
  modelRouter?: ServeModelRouter
}

export interface TanrenHealth {
  status: 'ok' | 'degraded'
  service: string
  ticking: boolean
  tickCount: number
  uptime: number
  errors: number
  errorRate: string
  avgTickDuration: string
  recentTicks: Array<{ tick: number; timestamp: string; duration: number; actions: string[]; mode: string; error?: string }>
  pool: ReturnType<AgentPool['status']>
  autonomous: { busy: boolean }
  agent?: Record<string, unknown>
  capabilities?: unknown
  unit: { unit_id: string; available_modes: readonly string[]; current_mode: string | null }
}

export function serve(agent: TanrenAgent, options: ServeOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10)
  const serviceName = options.serviceName ?? 'tanren-agent'
  const memoryDir = options.memoryDir ?? './memory'
  const anupStore = new FileAgentUIStore(join(memoryDir, 'state', 'anup'))
  let tickCount = 0
  let errorCount = 0
  const startTime = Date.now()

  // Agent Pool — enables concurrent /chat with different discussionIds
  const maxPoolSize = options.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE
  const pool = createAgentPool(agent, options.agentConfig, maxPoolSize)

  // Autonomous loop — independent from pool, never blocks /chat
  let autonomousBusy = false
  let lastWebhookTick = 0
  const WEBHOOK_TICK_COOLDOWN = 30_000

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

  async function handleChatStream(
    poolEntry: PoolEntry,
    from: string,
    text: string,
    res: ServerResponse,
    sessionId?: string,
    onResult?: (result: ChatResult & { chainTicks: number; sessionId?: string }) => void,
  ): Promise<void> {
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
      onResult?.({ ...chatResult, ...(resultSessionId ? { sessionId: resultSessionId } : {}) })
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

  const readJsonBody = async <T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> => {
    let body = ''
    for await (const chunk of req) body += chunk
    return JSON.parse(body) as T
  }

  const normalizeChatAttachments = (value: unknown): PromptContentBlock[] => {
    if (!Array.isArray(value)) return []
    return value.flatMap((item): PromptContentBlock[] => {
      if (!item || typeof item !== 'object') return []
      const obj = item as Record<string, unknown>
      if (typeof obj.uri === 'string') {
        const mediaType = typeof obj.mediaType === 'string' ? obj.mediaType : guessMediaType(obj.uri)
        const label = typeof obj.label === 'string' ? obj.label : undefined
        if (/^https?:\/\//.test(obj.uri) || obj.uri.startsWith('data:')) {
          return [{ type: 'media', mediaType, source: { type: 'url', url: obj.uri }, label }]
        }
        if (/^[a-z]+:\/\//i.test(obj.uri)) return [{ type: 'ref', uri: obj.uri, mediaType, label }]
        return [{ type: 'media', mediaType, source: { type: 'file', path: obj.uri }, label }]
      }
      if (typeof obj.url === 'string') {
        return [{
          type: 'media',
          mediaType: typeof obj.mediaType === 'string' ? obj.mediaType : guessMediaType(obj.url),
          source: { type: 'url', url: obj.url },
          label: typeof obj.label === 'string' ? obj.label : undefined,
        }]
      }
      return []
    })
  }

  const textWithAttachments = (text: string, attachments: PromptContentBlock[]): string => {
    if (!attachments.length) return text
    const summaries = attachments.map((attachment, index) => {
      if (attachment.type === 'media') {
        const source = attachment.source.type === 'url' ? attachment.source.url : attachment.source.type === 'file' ? attachment.source.path : '[base64]'
        return `${index + 1}. ${attachment.mediaType} ${source}${attachment.label ? ` (${attachment.label})` : ''}`
      }
      if (attachment.type === 'ref') return `${index + 1}. ${attachment.mediaType ?? 'resource'} ${attachment.uri}${attachment.label ? ` (${attachment.label})` : ''}`
      if (attachment.type === 'stream') return `${index + 1}. ${attachment.mediaType} stream ${attachment.url}${attachment.label ? ` (${attachment.label})` : ''}`
      return `${index + 1}. text attachment`
    })
    return `${text.trim() || 'Please inspect the attached input.'}\n\n[ATTACHMENTS]\n${summaries.join('\n')}`
  }

  const summarizePromptBlocks = (prompt: PromptContentBlock[]) => ({
    blockTypes: prompt.map(block => block.type),
    attachmentCount: prompt.filter(block => block.type !== 'text').length,
    mediaTypes: prompt
      .map(block => 'mediaType' in block ? block.mediaType : undefined)
      .filter((mediaType): mediaType is string => typeof mediaType === 'string'),
  })

  const summarizeModel = (model: ModelIO | undefined) => model ? {
    name: model.name,
    capabilities: model.capabilities,
  } : null

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
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
      const health: TanrenHealth = {
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
        ...(options.health ? { agent: options.health() } : {}),
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        ...unitNamespace,
      }
      json(res, 200, health)

    } else if (url.pathname === '/status' && req.method === 'GET') {
      try {
        const statusPath = join(memoryDir, 'state', 'live-status.json')
        const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
        json(res, 200, status)
      } catch { json(res, 200, { phase: 'unknown' }) }

    } else if (url.pathname === '/loop/status' && req.method === 'GET') {
      const poolStatus = pool.status()
      json(res, 200, {
        running: poolStatus.active > 0 || autonomousBusy,
        ticking: poolStatus.active > 0 || autonomousBusy,
        tickCount,
        autonomous: { busy: autonomousBusy, lastWebhookTick },
        pool: poolStatus,
        liveStatus: readJsonFile(join(memoryDir, 'state', 'live-status.json')) ?? { phase: 'unknown' },
        recentTicks: recentTicks.slice(-10),
      })

    } else if (url.pathname === '/logs' && req.method === 'GET') {
      const limit = parsePositiveInt(url.searchParams.get('limit'), 50)
      const tickEntries = readJsonlTail(join(memoryDir, 'journal', 'ticks.jsonl'), limit)
      const markdownTicks = listRecentMarkdown(join(memoryDir, 'journal', 'ticks'), Math.min(limit, 20))
      json(res, 200, {
        recentTicks,
        tickEntries,
        markdownTicks,
        policyEvents: readJsonlTail(join(memoryDir, 'state', 'policy-events.jsonl'), limit),
      })

    } else if (url.pathname === '/context' && req.method === 'GET') {
      const topicLimit = parsePositiveInt(url.searchParams.get('topicLimit'), 20)
      json(res, 200, {
        memory: readTextSnippet(join(memoryDir, 'memory.md'), 12_000),
        heartbeat: readTextSnippet(join(memoryDir, 'HEARTBEAT.md'), 8_000),
        soul: readTextSnippet(join(memoryDir, 'SOUL.md'), 8_000),
        workingMemory: readJsonFile(join(memoryDir, 'state', 'working-memory.json')),
        sessionBridge: readJsonFile(join(memoryDir, 'state', 'session-bridge.json')),
        topics: listRecentMarkdown(join(memoryDir, 'topics'), topicLimit),
      })

    } else if (url.pathname === '/api/dashboard/behaviors' && req.method === 'GET') {
      const limit = parsePositiveInt(url.searchParams.get('limit'), 200)
      const tickEntries = readJsonlTail(join(memoryDir, 'journal', 'ticks.jsonl'), limit)
      json(res, 200, buildBehaviorDigest(tickEntries, recentTicks))

    } else if (url.pathname === '/api/dashboard/learning' && req.method === 'GET') {
      json(res, 200, {
        actionHealth: readJsonFile(join(memoryDir, 'state', 'action-health.json')),
        gateState: readJsonFile(join(memoryDir, 'state', 'gate-state.json')),
        crystallization: readJsonFile(join(memoryDir, 'state', 'crystallization.json')),
        workingMemory: readJsonFile(join(memoryDir, 'state', 'working-memory.json')),
        usage: readJsonFile(join(memoryDir, 'state', 'usage-summary.json')),
      })

    } else if (url.pathname === '/api/dashboard/journal' && req.method === 'GET') {
      const limit = parsePositiveInt(url.searchParams.get('limit'), 30)
      json(res, 200, {
        tickEntries: readJsonlTail(join(memoryDir, 'journal', 'ticks.jsonl'), limit),
        markdownTicks: listRecentMarkdown(join(memoryDir, 'journal', 'ticks'), limit),
        kgPending: readJsonlTail(join(memoryDir, 'journal', 'kg-pending.jsonl'), limit),
      })

    } else if (url.pathname === '/model/route-preview' && req.method === 'POST') {
      let parsed: ModelRoutePreviewBody
      try { parsed = await readJsonBody<Record<string, unknown>>(req) as ModelRoutePreviewBody } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const text = typeof parsed.text === 'string' ? parsed.text : ''
      const attachments = normalizeChatAttachments(parsed.attachments)
      const prompt: PromptContentBlock[] = []
      if (text.trim()) prompt.push({ type: 'text', text: text.trim() })
      prompt.push(...attachments)
      if (!prompt.length) prompt.push({ type: 'text', text: 'Route preview' })

      const requirement = parsed.requirement && typeof parsed.requirement === 'object' ? parsed.requirement : undefined
      if (!options.modelRouter) {
        json(res, 200, {
          selected: null,
          rejected: [],
          prompt: summarizePromptBlocks(prompt),
          requirement,
          reason: 'model router unavailable',
        })
        return
      }

      const decision = options.modelRouter.route({ prompt, metadata: { source: 'route-preview' } }, requirement)
      json(res, 200, {
        selected: summarizeModel(decision.selected),
        rejected: decision.rejected,
        prompt: summarizePromptBlocks(prompt),
        requirement,
        providers: options.modelRouter.providers.map(summarizeModel),
      })

    } else if ((url.pathname === '/workbench' || url.pathname === '/chat-ui') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getAnupWorkbenchHtml())

    } else if (await handleAnupHttpRoute(req, res, url, {
      memoryDir,
      serviceName,
      longTasks: options.longTasks,
      artifacts: options.artifacts,
      capabilities: options.capabilities,
    })) {

    } else if (options.longTasks && await handleLongTaskHttpRoute(req, res, url, { controller: options.longTasks })) {

    } else if (await handleArtifactHttpRoute(req, res, url, { artifacts: options.artifacts, memoryDir })) {

    } else if (url.pathname === '/chat' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: ChatBody
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      const attachments = normalizeChatAttachments(parsed.attachments)
      const chatText = textWithAttachments(text, attachments)
      if (!chatText.trim()) { json(res, 400, { error: 'Empty text' }); return }

      const poolEntry = pool.acquire(parsed.discussionId)
      if (!poolEntry) {
        const ps = pool.status()
        res.setHeader('Retry-After', '30')
        json(res, 429, { error: `${serviceName} is thinking (${ps.active}/${ps.max} agents busy), try again later`, estimatedWaitMs: 30000 })
        return
      }

      const tickStart = Date.now()
      try {
        const result = await handleChat(poolEntry, from, chatText, parsed.sessionId)
        recordTick(tickCount, Date.now() - tickStart, result.actions ?? [], result.meta?.mode ?? 'unknown')
        const run = chatResultToAnupEnvelope({
          agentId: serviceName,
          from,
          text: chatText,
          attachments,
          result,
          startedAt: new Date(tickStart).toISOString(),
        })
        anupStore.put(run)
        anupStore.appendEvent({ event: 'run.started', run_id: run.run_id, timestamp: run.timestamp })
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
      let parsed: ChatBody
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      const attachments = normalizeChatAttachments(parsed.attachments)
      const chatText = textWithAttachments(text, attachments)
      if (!chatText.trim()) { json(res, 400, { error: 'Empty text' }); return }

      const poolEntry = pool.acquire(parsed.discussionId)
      if (!poolEntry) {
        const ps = pool.status()
        res.setHeader('Retry-After', '30')
        json(res, 429, { error: `${serviceName} is thinking (${ps.active}/${ps.max} agents busy), try again later`, estimatedWaitMs: 30000 })
        return
      }

      try {
        const streamStart = Date.now()
        await handleChatStream(poolEntry, from, chatText, res, parsed.sessionId, (result) => {
          const run = chatResultToAnupEnvelope({
            agentId: serviceName,
            from,
            text: chatText,
            attachments,
            result,
            startedAt: new Date(streamStart).toISOString(),
          })
          anupStore.put(run)
          anupStore.appendEvent({ event: 'run.started', run_id: run.run_id, timestamp: run.timestamp })
        })
      } finally {
        pool.release(poolEntry)
      }

    } else if (url.pathname === '/webhook' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(body) } catch { json(res, 400, { error: 'Invalid JSON' }); return }

      // Normalize: accept both EventQueue format ({ source, event }) and KG notification format ({ discussion_id, events })
      let source = (parsed.source as string) ?? 'webhook'
      let eventName = parsed.event as string | undefined
      let priorityHint = (parsed.priority_hint as string) ?? 'medium'
      const payload = (parsed.payload as Record<string, unknown>) ?? {}

      if (!eventName && parsed.discussion_id) {
        source = 'kg-notification'
        eventName = 'discussion.update'
        payload.discussion_id = parsed.discussion_id
        payload.events = parsed.events
        payload.event_count = parsed.event_count
        const events = parsed.events as Array<{ data?: { priority_hint?: string } }> | undefined
        if (events?.some(e => e.data?.priority_hint === 'high')) priorityHint = 'high'
      }

      if (!eventName) { json(res, 400, { error: 'event (or discussion_id) required' }); return }

      const eventsDir = join(memoryDir, 'events')
      const pendingDir = join(eventsDir, 'pending')
      const { mkdirSync: mk, writeFileSync: wf, renameSync: rn } = await import('node:fs')
      const { randomBytes } = await import('node:crypto')
      mk(pendingDir, { recursive: true })
      const id = `${Date.now()}-${randomBytes(2).toString('hex')}-${source.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 20)}.json`
      const event = { source, event: eventName, priority_hint: priorityHint, payload, version: 1, timestamp: new Date().toISOString() }
      const tmpPath = join(pendingDir, `.${id}.tmp`)
      wf(tmpPath, JSON.stringify(event, null, 2), 'utf-8')
      rn(tmpPath, join(pendingDir, id))

      // Event-driven tick: fire-and-forget, rate-limited
      const now = Date.now()
      const cooldown = priorityHint === 'high' ? 0 : WEBHOOK_TICK_COOLDOWN
      if (now - lastWebhookTick >= cooldown && !autonomousBusy) {
        lastWebhookTick = now
        {
          autonomousBusy = true
          agent.tick().then(result => {
            tickCount++
            const actions = result.actions.map(a => a.type).join(', ') || '(none)'
            console.log(`[${serviceName}] webhook tick: ${actions} (${result.observation.duration}ms)`)
            recordTick(tickCount, result.observation.duration, result.actions.map(a => a.type), 'webhook')
          }).catch(err => {
            console.error(`[${serviceName}] webhook tick error: ${err instanceof Error ? err.message : err}`)
            recordTick(tickCount, 0, [], 'webhook', String(err))
          }).finally(() => { autonomousBusy = false })
        }
      }

      json(res, 200, { ok: true, id })

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
            body: { from: 'string', text: 'string (required unless attachments provided)', discussionId: 'string (optional — routes to dedicated pool agent)', attachments: 'optional [{ uri, mediaType?, label? }]' },
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
            body: { from: 'string', text: 'string (required unless attachments provided)', attachments: 'optional [{ uri, mediaType?, label? }]' },
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
          'GET /loop/status': { description: 'Loop/pool status plus live-status.json and recent in-process ticks' },
          'GET /logs': { description: 'Recent tick JSONL entries, markdown tick logs, and policy events', query: { limit: 'default 50' } },
          'GET /context': { description: 'Human-readable memory/context snapshot from memory files and topics', query: { topicLimit: 'default 20' } },
          'GET /api/dashboard/behaviors': { description: 'Behavior digest from recent tick history', query: { limit: 'default 200' } },
          'GET /api/dashboard/learning': { description: 'Learning/action-health/gate/working-memory dashboard state' },
          'GET /api/dashboard/journal': { description: 'Recent journal entries and tick markdown files', query: { limit: 'default 30' } },
          'POST /model/route-preview': { description: 'Preview which model provider can handle a text/multimodal request without invoking an LLM', body: { text: 'optional', attachments: 'optional [{ uri, mediaType?, label? }]', requirement: 'optional output/streaming capability requirement' } },
          'GET /workbench': { description: 'Human-readable Agent Native UI Protocol workbench' },
          'GET /chat-ui': { description: 'Browser chat UI with live ANUP workbench side panel' },
          'POST /demo/anup': { description: 'Create a demo ANUP run with decision, approval, trace, and media_ref blocks' },
          'GET /anup/overview': { description: 'Project runtime tasks, artifacts, policy, and capabilities into ANUP blocks' },
          'GET /anup/tasks/:taskId': { description: 'Project one long task into ANUP task/state/trace/artifact blocks' },
          'GET /anup/runs': { description: 'List persisted ANUP runs' },
          'POST /anup/runs': { description: 'Persist an ANUP run envelope', body: { agent_id: 'optional', blocks: 'AgentUIBlock[]' } },
          'POST /anup/runs/:runId/blocks': { description: 'Append or replace one block in a persisted ANUP run' },
          'POST /anup/runs/:runId/actions': { description: 'Record structured human action for approval/decision blocks' },
          'GET /anup/approvals': { description: 'List pending approval_request blocks in persisted ANUP runs' },
          'GET /policy/events': { description: 'List blocked provider/artifact policy events', query: { limit: 'default 100', domain: 'llm | artifact optional', provider: 'optional' } },
          'GET /artifacts': { description: 'List persisted artifact jobs', query: { date: 'YYYY-MM-DD optional', provider: 'optional' } },
          'POST /artifacts': { description: 'Submit artifact generation job', body: { type: 'image | audio | file | ...', prompt: 'string', provider: 'optional', refs: 'optional artifact refs or URIs' } },
          'POST /artifacts/stream': { description: 'Submit artifact generation job and stream SSE artifact events' },
          'GET /artifacts/:jobId': { description: 'Fetch artifact job by id' },
          'GET /artifacts/:jobId/stream': { description: 'Replay/follow artifact job events as SSE' },
          'GET /artifacts/:jobId/file': { description: 'Serve a local artifact file from a completed job', query: { index: 'artifact index, default 0' } },
          'DELETE /artifacts/:jobId': { description: 'Cancel a job and persist the cancelled status when possible' },
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

  // Some TS runners can exit after top-level await resolves when the HTTP
  // server object is only retained through native handles. Keep an explicit
  // ref alive for serve mode; tests clear it by closing the server.
  const keepAliveTimer = setInterval(() => {}, 60 * 60 * 1000)
  server.on('close', () => clearInterval(keepAliveTimer))

  server.listen(port, () => {
    console.log(`[${serviceName}] Server on port ${port}`)
    console.log(`[${serviceName}] POST /chat — { "from": "user", "text": "message" }`)
    console.log(`[${serviceName}] GET  /health | GET /status`)
  })

  const shutdown = () => { console.log(`\n[${serviceName}] Stopping...`); pool.destroy(); clearInterval(keepAliveTimer); server.close(); process.exit(0) }
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
