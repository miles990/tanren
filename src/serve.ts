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

export interface TanrenAgent {
  chat(message: string, options?: { from?: string }): Promise<ChatResult>
  isRunning(): boolean
}

export interface ServeOptions {
  port?: number
  serviceName?: string
  memoryDir?: string
  /** Called before each tick — agent-specific setup (e.g., clear inbox files) */
  onBeforeChat?: (from: string, text: string) => void | Promise<void>
  /** Called after each tick — agent-specific cleanup */
  onAfterChat?: (result: ChatResult) => void | Promise<void>
}

export function serve(agent: TanrenAgent, options: ServeOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10)
  const serviceName = options.serviceName ?? 'tanren-agent'
  const memoryDir = options.memoryDir ?? './memory'
  let ticking = false
  let tickCount = 0

  async function handleChat(from: string, text: string): Promise<ChatResult & { tick: number }> {
    if (options.onBeforeChat) await options.onBeforeChat(from, text)

    const chatResult = await agent.chat(text, { from })
    tickCount++

    if (options.onAfterChat) await options.onAfterChat(chatResult)

    return { ...chatResult, tick: tickCount } as ChatResult & { tick: number }
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
      json(res, 200, { status: 'ok', service: serviceName, ticking, tickCount })

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
      try {
        const result = await handleChat(from, text)
        json(res, 200, result)
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      } finally {
        ticking = false
      }

    } else {
      json(res, 404, { error: `Not found. Endpoints: POST /chat, GET /health, GET /status` })
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

  return server
}
