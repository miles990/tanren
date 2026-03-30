/**
 * Akari — Kuro's research partner, built on Tanren
 *
 * Demonstrates gates, custom actions, and perception plugins.
 * Run: npx tsx examples/with-learning/run.ts
 */

import { createAgent, createOutputGate, createSymptomFixGate, createAnalysisWithoutActionGate, createAnthropicProvider } from '../../src/index.js'
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ActionHandler } from '../../src/types.js'

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

// LLM provider: use Anthropic API when key available (enables native tool use),
// otherwise fall back to Claude CLI (text-based action tags)
const apiKey = process.env.ANTHROPIC_API_KEY
const llmProvider = apiKey
  ? createAnthropicProvider({
      apiKey,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
    })
  : undefined  // falls back to CLI provider

if (apiKey) {
  console.log('[akari] Using Anthropic API provider (native tool use)')
} else {
  console.log('[akari] Using Claude CLI provider (text-based actions)')
}

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
  tickInterval: 300_000,        // 5 min between ticks (cost-conscious)
})

// CLI argument parsing
const args = process.argv.slice(2)
const mode = args.includes('--loop') ? 'loop'
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

if (mode === 'loop') {
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
