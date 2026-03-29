/**
 * Akari — Kuro's research partner, built on Tanren
 *
 * Demonstrates gates, custom actions, and perception plugins.
 * Run: npx tsx examples/with-learning/run.ts
 */

import { createAgent, createOutputGate, createSymptomFixGate } from '../../src/index.js'
import { readFileSync, existsSync } from 'node:fs'

// Perception: what's happening around us
const plugins = [
  {
    name: 'clock',
    fn: () => `Current time: ${new Date().toISOString()}`,
    category: 'environment',
  },
  {
    name: 'identity',
    fn: () => {
      const soul = readFileSync('./examples/with-learning/soul.md', 'utf-8')
      return soul
    },
    interval: 300_000, // reload every 5 min
    category: 'self',
  },
  {
    name: 'recent-memory',
    fn: () => {
      const memPath = './examples/with-learning/memory/memory.md'
      if (!existsSync(memPath)) return '(no memories yet)'
      return readFileSync(memPath, 'utf-8').slice(-2000) // last 2KB
    },
    category: 'memory',
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
