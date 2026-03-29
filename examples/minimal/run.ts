/**
 * Minimal Tanren Agent — 10 lines to configure
 *
 * Run: npx tsx examples/minimal/run.ts
 */

import { createAgent } from '../../src/index.js'

const agent = createAgent({
  identity: './examples/minimal/soul.md',
  memoryDir: './examples/minimal/memory',
  perceptionPlugins: [
    { name: 'clock', fn: () => `Current time: ${new Date().toISOString()}` },
    { name: 'greeting', fn: () => 'This is your first tick. Say hello and remember something.' },
  ],
  tickInterval: 60_000,
})

// Run a single tick to verify everything works
console.log('[tanren] Running one tick...')
agent.tick().then((result) => {
  console.log('[tanren] Tick completed.')
  console.log(`  Perception: ${result.perception.slice(0, 100)}...`)
  console.log(`  Actions parsed: ${result.actions.length}`)
  console.log(`  Duration: ${result.observation.duration}ms`)
  if (result.gateResults.length > 0) {
    console.log(`  Gate results: ${result.gateResults.map(g => `${g.action}`).join(', ')}`)
  }
  console.log(`  Thought (first 200 chars): ${result.thought.slice(0, 200)}...`)
}).catch((err) => {
  console.error('[tanren] Tick failed:', err.message)
  process.exit(1)
})
