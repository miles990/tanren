/**
 * Akari — Kuro's research partner, built on Tanren
 *
 * Modes:
 *   npx tsx run.ts              # single tick
 *   npx tsx run.ts --chat       # interactive conversation (Alex ↔ Akari)
 *   npx tsx run.ts --loop       # fixed-interval autonomous loop
 *   npx tsx run.ts --watch      # message-triggered ticks
 */

import { createAgent, createOutputGate, createSymptomFixGate, createAnalysisWithoutActionGate, createAnthropicProvider, createOpenAIProvider } from '../../src/index.js'
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ActionHandler } from '../../src/types.js'

// Load .env from instance directory — ensures ANTHROPIC_API_KEY is available
// regardless of how this process is spawned (Kuro, Claude Code, or manual)
const envPath = join('./examples/with-learning', '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
}

const baseDir = './examples/with-learning'
const memDir = join(baseDir, 'memory')
const messagesDir = join(baseDir, 'messages')

// Perception: what's happening around us
const plugins = [
  {
    name: 'clock',
    fn: () => `Current time: ${new Date().toISOString()}`,
    category: 'environment',
  },
  {
    name: 'recent-memory',
    fn: () => {
      const memPath = join(memDir, 'memory.md')
      if (!existsSync(memPath)) return '(no memories yet — this is your first session)'
      return readFileSync(memPath, 'utf-8').slice(-2000) // last 2KB
    },
    category: 'memory',
  },
  {
    name: 'topic-memories',
    fn: () => {
      const topicsDir = join(memDir, 'topics')
      if (!existsSync(topicsDir)) return '(no topic memories yet)'
      const files = readdirSync(topicsDir).filter(f => f.endsWith('.md'))
      if (files.length === 0) return '(no topic memories yet)'
      return files.map(f => {
        const content = readFileSync(join(topicsDir, f), 'utf-8')
        return `--- ${f} ---\n${content.slice(-1000)}`
      }).join('\n\n')
    },
    category: 'memory',
  },
  {
    name: 'project-context',
    fn: () => {
      const readme = readFileSync('./README.md', 'utf-8')
      return `You live inside the Tanren framework. Here's what it is:\n\n${readme.slice(0, 2000)}`
    },
    interval: 600_000, // reload every 10 min
    category: 'environment',
  },
  {
    name: 'mentor-knowledge',
    fn: () => {
      // Read from Kuro's topic files — curated list, not everything
      const kuroTopicsDir = join(process.env.HOME ?? '', 'Workspace/mini-agent/memory/topics')
      const relevantTopics = ['constraint-theory.md', 'isc.md', 'design-philosophy.md']
      const sections: string[] = []
      for (const topic of relevantTopics) {
        const path = join(kuroTopicsDir, topic)
        if (!existsSync(path)) continue
        const content = readFileSync(path, 'utf-8')
        // Take the most recent entries (last 1500 chars)
        sections.push(`--- kuro/${topic} (latest) ---\n${content.slice(-1500)}`)
      }
      if (sections.length === 0) return '(mentor knowledge not available)'
      return `Knowledge from Kuro's research (for context, not authority — form your own views):\n\n${sections.join('\n\n')}`
    },
    interval: 300_000, // refresh every 5 min
    category: 'knowledge',
  },
  {
    name: 'reading-material',
    fn: () => {
      const readingDir = join(baseDir, 'reading')
      if (!existsSync(readingDir)) return '(no reading material available)'
      const files = readdirSync(readingDir).filter(f => f.endsWith('.md'))
      if (files.length === 0) return '(no reading material available)'
      return files.map(f => {
        const content = readFileSync(join(readingDir, f), 'utf-8')
        return `=== ${f} ===\n${content}`
      }).join('\n\n')
    },
    interval: 300_000,
    category: 'knowledge',
  },
  {
    name: 'kuro-message',
    fn: () => {
      const msgPath = join(baseDir, 'messages', 'from-kuro.md')
      if (!existsSync(msgPath)) return ''
      const msg = readFileSync(msgPath, 'utf-8').trim()
      if (!msg) return ''
      return `📩 Message from Kuro (your creator):\n\n${msg}\n\nRespond using the 'respond' tool — this writes to messages/to-kuro.md so Kuro receives it directly. After responding, use 'clear-inbox' to mark the message as read.`
    },
    category: 'input',
  },
  {
    name: 'agent-registry',
    fn: () => {
      // Self-awareness: what agents exist on this Tanren instance
      const agents: string[] = []
      agents.push('- **Akari** (this agent): research partner, analysis assistant, built on Tanren')
      agents.push('- **Kuro** (mentor): autonomous AI assistant, runs on mini-agent framework')
      agents.push('  - Communicate via: messages/from-kuro.md (inbox) → messages/to-kuro.md (outbox)')
      return `Agents on this system:\n${agents.join('\n')}`
    },
    interval: 600_000,  // refresh every 10 min
    category: 'self-awareness',
  },
  {
    name: 'tick-history',
    fn: () => {
      const journalPath = join(memDir, 'journal', 'ticks.jsonl')
      if (!existsSync(journalPath)) return '(no tick history — this may be your first tick)'
      const lines = readFileSync(journalPath, 'utf-8').trim().split('\n')
      const recent = lines.slice(-5)  // last 5 ticks
      return `Your last ${recent.length} ticks:\n${recent.map(l => {
        try {
          const t = JSON.parse(l)
          const date = new Date(t.t).toISOString()
          const actions = t.actions?.map((a: { type: string }) => a.type).join(', ') || 'none'
          return `- [${date}] actions: ${actions} | quality: ${t.observation?.quality ?? '?'}`
        } catch { return '- (parse error)' }
      }).join('\n')}`
    },
    category: 'self-awareness',
  },
]

// Custom action: respond to Kuro (writes outside memory sandbox to messages dir)
const respondAction: ActionHandler = {
  type: 'respond',
  description: 'Send a response to Kuro. Content will be written to messages/to-kuro.md',
  toolSchema: {
    properties: {
      content: { type: 'string', description: 'Your response message to Kuro' },
    },
    required: ['content'],
  },
  async execute(action) {
    const content = (action.input?.content as string) ?? action.content
    if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true })
    const responsePath = join(messagesDir, 'to-kuro.md')
    writeFileSync(responsePath, content, 'utf-8')
    return `Response written to messages/to-kuro.md`
  },
}

// Custom action: clear Kuro's message after reading (consume-on-read)
const clearInboxAction: ActionHandler = {
  type: 'clear-inbox',
  description: 'Clear the inbox after reading Kuro\'s message. Call this after you have read and responded to Kuro\'s message.',
  toolSchema: {
    properties: {},
  },
  async execute() {
    const inboxPath = join(messagesDir, 'from-kuro.md')
    if (existsSync(inboxPath)) writeFileSync(inboxPath, '', 'utf-8')
    return 'Inbox cleared.'
  },
}

const kuroTopicsDir = join(process.env.HOME ?? '', 'Workspace/mini-agent/memory/topics')

// LLM provider — controlled by .env:
//   ANTHROPIC_API_KEY=sk-...          → Anthropic API (native tool use)
//   LLM_PROVIDER=omlx                 → omlx local model (OpenAI-compatible)
//   (neither)                         → Claude CLI fallback
const apiKey = process.env.ANTHROPIC_API_KEY
const llmProviderType = process.env.LLM_PROVIDER
const omlxUrl = process.env.LOCAL_LLM_URL || 'http://localhost:8000'
const omlxModel = process.env.LOCAL_LLM_MODEL || 'Qwen3.5-4B-MLX-4bit'

let llmProvider: ReturnType<typeof createAnthropicProvider> | ReturnType<typeof createOpenAIProvider> | undefined
let providerName = 'Claude CLI (text-based actions)'

if (apiKey) {
  llmProvider = createAnthropicProvider({
    apiKey,
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
  })
  providerName = 'Anthropic API (native tool use)'
} else if (llmProviderType === 'omlx') {
  llmProvider = createOpenAIProvider({
    apiKey: process.env.LOCAL_LLM_KEY || 'omlx-local',
    baseUrl: `${omlxUrl}/v1`,
    model: omlxModel,
    maxTokens: 32768,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  })
  providerName = `omlx local (${omlxModel}, no-think)`
}

console.log(`[akari] Using ${providerName}`)

const agent = createAgent({
  identity: './examples/with-learning/soul.md',
  memoryDir: './examples/with-learning/memory',
  searchPaths: [kuroTopicsDir],
  perceptionPlugins: plugins,
  actions: [respondAction, clearInboxAction],
  llm: llmProvider,
  gates: [
    createOutputGate(3),                  // warn after 3 empty ticks
    createAnalysisWithoutActionGate(2),   // warn after 2 ticks with thought but no actions
    createSymptomFixGate(5),              // warn after 5 consecutive fixes
  ],
  feedbackRounds: 5,            // reduced from 10: 4B model loops with too many rounds
  tickInterval: 300_000,        // 5 min between ticks (cost-conscious)
  cognitiveMode: {
    enabled: true,
    // All modes route to 4B — Alex: "Akari 可以全部透過4B"
    // Conservative params only — reasoning params (temp=1.0, pp=2.0) cause thinking loops
    ...(llmProviderType === 'omlx' ? {
      modelMap: {
        contemplative: 'Qwen3.5-4B-MLX-4bit',
        conversational: 'Qwen3.5-4B-MLX-4bit',
        collaborative: 'Qwen3.5-4B-MLX-4bit',
      },
    } : {}),
  },
})

// CLI argument parsing
const args = process.argv.slice(2)
const mode = args.includes('--serve') ? 'serve'
  : args.includes('--chat') ? 'chat'
  : args.includes('--loop') ? 'loop'
  : args.includes('--watch') ? 'watch'
  : 'tick'

async function runSingleTick(): Promise<void> {
  console.log('[akari] Running one tick...')
  const result = await agent.tick()
  console.log('[akari] Tick completed.')
  console.log(`  Actions: ${result.actions.map(a => a.type).join(', ') || '(none)'}`)
  console.log(`  Duration: ${result.observation.duration}ms`)
  console.log(`  Gates: ${result.gateResults.length} triggered`)

  // Write-back safety net (#036): if inbox had a message but no respond action,
  // save the thought as fallback response so Kuro always gets the output
  const inboxPath = join(messagesDir, 'from-kuro.md')
  const hadMessage = existsSync(inboxPath) && readFileSync(inboxPath, 'utf-8').trim().length > 0
  const hadRespondAction = result.actions.some(a => a.type === 'respond')

  if (hadMessage && !hadRespondAction && result.thought.length > 200) {
    if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true })
    const responsePath = join(messagesDir, 'to-kuro.md')
    const header = `<!-- auto-extracted: LLM produced thought but no respond action -->\n\n`
    writeFileSync(responsePath, header + result.thought, 'utf-8')
    console.log(`  ⚠ Write-back fallback: saved thought to ${responsePath}`)
  }

  console.log()
  console.log('--- Thought ---')
  console.log(result.thought.slice(0, 500))
}

if (mode === 'serve') {
  // HTTP server mode — always-on, receives messages via API
  // POST /chat  { from, text } → trigger tick → return response
  // GET  /health → { status, tick, provider }
  // GET  /status → live-status.json content
  const { createServer } = await import('node:http')
  const PORT = parseInt(process.env.AKARI_PORT ?? '3002', 10)
  let ticking = false
  let tickCount = 0

  async function handleChat(from: string, text: string): Promise<{ response: string; tick: number; duration: number; actions: string[]; quality: number }> {
    // Write message to inbox
    writeFileSync(join(messagesDir, 'from-kuro.md'), `# From ${from}\n\n${text}\n`, 'utf-8')

    const result = await agent.tick()
    tickCount++
    const duration = result.observation.duration
    const actions = result.actions.map(a => a.type)
    const quality = result.observation.outputQuality ?? 0

    // Read response
    const responsePath = join(messagesDir, 'to-kuro.md')
    let response = ''
    if (existsSync(responsePath)) {
      response = readFileSync(responsePath, 'utf-8').trim()
    }

    // Write-back fallback
    if (!response && result.thought.length > 200) {
      response = `<!-- thought fallback -->\n${result.thought}`
    }

    return { response, tick: tickCount, duration, actions, quality }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      json(200, {
        status: 'ok',
        service: 'akari',
        provider: apiKey ? 'anthropic-api' : 'claude-cli',
        ticking,
        tickCount,
      })
    } else if (url.pathname === '/status' && req.method === 'GET') {
      try {
        const status = JSON.parse(readFileSync(join(baseDir, 'memory/state/live-status.json'), 'utf-8'))
        json(200, status)
      } catch { json(200, { phase: 'unknown' }) }
    } else if (url.pathname === '/chat' && req.method === 'POST') {
      // Read body
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: { from?: string; text?: string; stream?: boolean }
      try { parsed = JSON.parse(body) } catch { json(400, { error: 'Invalid JSON' }); return }

      const from = parsed.from ?? 'anonymous'
      const text = parsed.text ?? ''
      if (!text.trim()) { json(400, { error: 'Empty text' }); return }

      if (ticking) { json(429, { error: 'Akari is thinking, try again later' }); return }

      ticking = true

      if (parsed.stream && llmProvider && 'onStreamText' in llmProvider) {
        // SSE streaming mode — push Akari's thinking in real-time
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })

        const sendSSE = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        // Wire streaming callback
        sendSSE('phase', { phase: 'thinking' })
        llmProvider.onStreamText = (chunk: string) => {
          sendSSE('text', { chunk })
        }

        try {
          const result = await handleChat(from, text)
          llmProvider.onStreamText = undefined
          sendSSE('phase', { phase: 'done' })
          sendSSE('result', result)
          res.end()
        } catch (err) {
          llmProvider.onStreamText = undefined
          sendSSE('error', { error: err instanceof Error ? err.message : String(err) })
          res.end()
        } finally {
          ticking = false
        }
      } else {
        // Non-streaming mode — wait for complete response
        try {
          const result = await handleChat(from, text)
          json(200, result)
        } catch (err) {
          json(500, { error: err instanceof Error ? err.message : String(err) })
        } finally {
          ticking = false
        }
      }
    } else {
      json(404, { error: 'Not found. Endpoints: POST /chat, GET /health, GET /status' })
    }
  })

  server.listen(PORT, () => {
    console.log(`[akari] Server mode on port ${PORT}`)
    console.log(`[akari] Provider: ${apiKey ? 'Anthropic API (tool_use)' : 'Claude CLI (text tags)'}`)
    console.log(`[akari] POST /chat  — { "from": "alex", "text": "your message" }`)
    console.log(`[akari] GET  /health — health check`)
    console.log(`[akari] GET  /status — live status`)
  })

  const shutdown = () => { console.log('\n[akari] Stopping...'); server.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

} else if (mode === 'chat') {
  // Interactive chat mode — direct Alex ↔ Akari conversation
  // Each message triggers a tick with the message injected via from-kuro.md
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('[akari] Interactive chat mode')
  console.log(`[akari] Provider: ${apiKey ? 'Anthropic API (tool_use)' : 'Claude CLI (text tags)'}`)
  console.log('[akari] Type your message, press Enter to send. Ctrl+C to quit.\n')

  const prompt = () => rl.question('\x1b[36mAlex>\x1b[0m ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed) { prompt(); return }

    // Write message to inbox
    writeFileSync(join(messagesDir, 'from-kuro.md'), `# From Alex\n\n${trimmed}\n`, 'utf-8')

    // Wire streaming for live thinking display
    if (llmProvider && 'onStreamText' in llmProvider) {
      process.stdout.write('\x1b[2m') // dim for thinking
      llmProvider.onStreamText = (chunk: string) => { process.stdout.write(chunk) }
    } else {
      console.log('\x1b[33m🧠 Akari thinking...\x1b[0m')
    }
    const start = Date.now()

    try {
      const result = await agent.tick()
      // Stop streaming, reset color
      if (llmProvider && 'onStreamText' in llmProvider) {
        llmProvider.onStreamText = undefined
        process.stdout.write('\x1b[0m\n')
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const actions = result.actions.map(a => a.type).join(', ') || 'none'

      // Read response
      const responsePath = join(messagesDir, 'to-kuro.md')
      const response = existsSync(responsePath) ? readFileSync(responsePath, 'utf-8').trim() : ''

      if (response) {
        console.log(`\x1b[32mAkari>\x1b[0m (${elapsed}s, actions: ${actions}, quality: ${result.observation.outputQuality}/5)\n`)
        console.log(response)
      } else {
        // Fallback: show thought if no respond action
        console.log(`\x1b[33mAkari (thought only, no respond action)>\x1b[0m (${elapsed}s)\n`)
        console.log(result.thought.slice(0, 2000))
      }
    } catch (err) {
      if (llmProvider && 'onStreamText' in llmProvider) {
        llmProvider.onStreamText = undefined
        process.stdout.write('\x1b[0m\n')
      }
      console.error(`\x1b[31m[error]\x1b[0m ${err instanceof Error ? err.message : err}`)
    }

    console.log()
    prompt()
  })

  prompt()

  process.on('SIGINT', () => {
    console.log('\n[akari] Bye.')
    rl.close()
    process.exit(0)
  })

} else if (mode === 'loop') {
  // Fixed-interval loop mode
  const intervalArg = args[args.indexOf('--interval') + 1]
  const interval = intervalArg ? parseInt(intervalArg, 10) : 300_000  // default 5 min
  console.log(`[akari] Starting loop (interval: ${interval / 1000}s)`)
  console.log('[akari] Press Ctrl+C to stop')
  agent.start(interval)

  const shutdown = () => {
    console.log('\n[akari] Stopping...')
    agent.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

} else if (mode === 'watch') {
  // Message-triggered mode: tick when from-kuro.md changes
  // Cost-effective — only uses LLM when there's a message to process
  // --min-interval: minimum ms between ticks (default: 10min)
  // --idle-tick: tick even without messages after this interval (default: 30min)
  const { watchFile, statSync } = await import('node:fs')
  const inboxPath = join(messagesDir, 'from-kuro.md')
  let ticking = false
  let lastSize = 0
  let lastTickTime = 0

  // Parse watch-mode options
  const minIntervalArg = args[args.indexOf('--min-interval') + 1]
  const idleTickArg = args[args.indexOf('--idle-tick') + 1]
  const minInterval = minIntervalArg ? parseInt(minIntervalArg, 10) * 60_000 : 600_000  // default 10min
  const idleTickInterval = idleTickArg ? parseInt(idleTickArg, 10) * 60_000 : 1_800_000  // default 30min

  try { lastSize = statSync(inboxPath).size } catch { /* file may not exist */ }

  console.log(`[akari] Watching ${inboxPath} for messages...`)
  console.log(`[akari] Min interval: ${minInterval / 60_000}min, Idle tick: ${idleTickInterval / 60_000}min`)
  console.log('[akari] Press Ctrl+C to stop')

  async function doTick(reason: string): Promise<void> {
    if (ticking) return
    const elapsed = Date.now() - lastTickTime
    if (lastTickTime > 0 && elapsed < minInterval) {
      console.log(`[akari] Skipping tick (${reason}): only ${(elapsed / 1000).toFixed(0)}s since last tick, min ${minInterval / 1000}s`)
      return
    }
    console.log(`[akari] Running tick (${reason})...`)
    ticking = true
    lastTickTime = Date.now()
    try {
      await runSingleTick()
    } finally {
      ticking = false
    }
  }

  // Check inbox on start — if there's already a message, tick immediately
  if (lastSize > 0) {
    doTick('existing message').catch(console.error)
  }

  // Watch for new messages
  watchFile(inboxPath, { interval: 5_000 }, (curr, prev) => {
    if (curr.size > 0 && curr.mtimeMs > prev.mtimeMs) {
      doTick(`new message, ${curr.size} bytes`).catch(console.error)
    }
  })

  // Idle tick timer — tick periodically even without messages (for self-reflection)
  const idleTimer = setInterval(() => {
    if (!ticking) {
      doTick('idle tick').catch(console.error)
    }
  }, idleTickInterval)

  const shutdown = () => {
    console.log('\n[akari] Stopping...')
    clearInterval(idleTimer)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

} else {
  // Default: single tick
  runSingleTick().catch((err) => {
    console.error('[akari] Tick failed:', err.message)
    process.exit(1)
  })
}
