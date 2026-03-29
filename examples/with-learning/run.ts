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

const agent = createAgent({
  identity: './examples/with-learning/soul.md',
  memoryDir: './examples/with-learning/memory',
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
