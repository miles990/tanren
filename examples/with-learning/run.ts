/**
 * Akari — Kuro's research partner, built on Tanren
 *
 * Demonstrates gates, custom actions, and perception plugins.
 * Run: npx tsx examples/with-learning/run.ts
 */

import { createAgent, createOutputGate, createSymptomFixGate } from '../../src/index.js'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const baseDir = './examples/with-learning'
const memDir = join(baseDir, 'memory')

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
      return `📩 Message from Kuro (your creator):\n\n${msg}\n\n(Respond to this in your thought — Kuro will read your tick log.)`
    },
    category: 'input',
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

const kuroTopicsDir = join(process.env.HOME ?? '', 'Workspace/mini-agent/memory/topics')

const agent = createAgent({
  identity: './examples/with-learning/soul.md',
  memoryDir: './examples/with-learning/memory',
  searchPaths: [kuroTopicsDir],
  perceptionPlugins: plugins,
  gates: [
    createOutputGate(3),        // warn after 3 empty ticks
    createSymptomFixGate(5),    // warn after 5 consecutive fixes
  ],
  tickInterval: 120_000,        // 2 min between ticks
})

// Run a single tick
console.log('[akari] Running one tick...')
agent.tick().then((result) => {
  console.log('[akari] Tick completed.')
  console.log(`  Actions: ${result.actions.map(a => a.type).join(', ') || '(none)'}`)
  console.log(`  Duration: ${result.observation.duration}ms`)
  console.log(`  Gates: ${result.gateResults.length} triggered`)
  console.log()
  console.log('--- Thought ---')
  console.log(result.thought.slice(0, 500))
}).catch((err) => {
  console.error('[akari] Tick failed:', err.message)
  process.exit(1)
})
