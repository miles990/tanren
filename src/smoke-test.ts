/**
 * Tanren Smoke Test — verify the framework works without LLM
 *
 * Tests: memory, perception, gates, actions, loop (with mock LLM)
 * Run: npx tsx src/smoke-test.ts
 */

import { createAgent, defineGate, createOutputGate } from './index.js'
import type { LLMProvider } from './types.js'
import { createMemorySystem } from './memory.js'
import { createPerception } from './perception.js'
import { createActionRegistry, builtinActions } from './actions.js'
import { createGateSystem } from './gates.js'
import { createLearningSystem } from './learning/index.js'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
let failed = 0

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    passed++
  } else {
    console.error(`  ❌ ${name}`)
    failed++
  }
}

async function testMemory() {
  console.log('\n--- Memory ---')
  const dir = mkdtempSync(join(tmpdir(), 'tanren-test-'))

  const memory = createMemorySystem(dir)

  await memory.write('test.md', '# Hello\nWorld')
  const content = await memory.read('test.md')
  assert(content === '# Hello\nWorld', 'write + read')

  await memory.append('test.md', 'Line 2')
  const appended = await memory.read('test.md')
  assert(appended!.includes('Line 2'), 'append')

  await memory.remember('Test fact')
  const memFile = await memory.read('memory.md')
  assert(memFile!.includes('Test fact'), 'remember (general)')

  await memory.remember('Topic fact', { topic: 'testing' })
  const topicFile = await memory.read('topics/testing.md')
  assert(topicFile!.includes('Topic fact'), 'remember (topic)')

  const results = await memory.search('Topic fact')
  assert(results.length > 0, 'search finds results')

  const recalled = await memory.recall('Topic')
  assert(recalled.length > 0, 'recall finds results')

  // Path traversal protection
  let blocked = false
  try { await memory.read('../etc/passwd') } catch { blocked = true }
  assert(blocked, 'path traversal blocked')

  rmSync(dir, { recursive: true })
}

async function testPerception() {
  console.log('\n--- Perception ---')
  const perception = createPerception([
    { name: 'clock', fn: () => 'now', category: 'time' },
    { name: 'status', fn: () => 'ok' },
  ])

  const output = await perception.perceive()
  assert(output.includes('<clock>'), 'plugin output has XML tags')
  assert(output.includes('now'), 'plugin content present')
  assert(output.includes('<time>'), 'category grouping works')

  // Test dynamic registration
  perception.register({ name: 'dynamic', fn: () => 'added' })
  const output2 = await perception.perceive()
  assert(output2.includes('added'), 'dynamic registration works')

  // Test error handling
  perception.register({ name: 'broken', fn: () => { throw new Error('boom') } })
  const output3 = await perception.perceive()
  assert(output3.includes('[error:'), 'error handled gracefully')
}

async function testActions() {
  console.log('\n--- Actions ---')
  const registry = createActionRegistry()
  for (const h of builtinActions) registry.register(h)

  // Parse
  const response = '<action:remember>Test note</action:remember> text <action:search>query</action:search>'
  const actions = registry.parse(response)
  assert(actions.length === 2, 'parses 2 actions from response')
  assert(actions[0].type === 'remember', 'first action is remember')
  assert(actions[1].type === 'search', 'second action is search')

  // Unknown action
  assert(!registry.has('nonexistent'), 'unknown action returns false')

  // Execute remember action
  const dir = mkdtempSync(join(tmpdir(), 'tanren-action-'))
  const memory = createMemorySystem(dir)
  const result = await registry.execute(
    { type: 'remember', content: 'smoke test', raw: '' },
    { memory, workDir: dir },
  )
  assert(result === 'Remembered.', 'remember action executes')

  rmSync(dir, { recursive: true })
}

function testGates() {
  console.log('\n--- Gates ---')
  const system = createGateSystem()

  // Define + register gate
  const gate = defineGate({
    name: 'test-gate',
    description: 'Always warns',
    check: () => ({ action: 'warn', message: 'test warning' }),
  })
  system.register(gate)

  // Create minimal tick for gate context
  const tick = {
    perception: '', thought: '', actions: [], timestamp: Date.now(),
    gateResults: [],
    observation: {
      outputExists: false, outputQuality: 3, confidenceCalibration: 0,
      actionsExecuted: 0, actionsFailed: 0, duration: 100,
    },
  }

  const results = system.runAll({
    tick, recentTicks: [], memory: { read: async () => null, search: async () => [] }, state: {},
  })
  assert(results.length === 1, 'gate fired')
  assert(results[0].action === 'warn', 'gate returned warn')

  const warnings = system.getWarnings()
  assert(warnings.length === 1 && warnings[0] === 'test warning', 'getWarnings works')

  // Output gate
  const outputGate = createOutputGate(2)
  system.register(outputGate)
  system.clearResults()

  // Simulate 2 empty ticks
  system.runAll({ tick, recentTicks: [], memory: { read: async () => null, search: async () => [] }, state: {} })
  system.runAll({ tick, recentTicks: [], memory: { read: async () => null, search: async () => [] }, state: {} })
  const outputWarnings = system.getWarnings()
  assert(outputWarnings.some(w => w.includes('without visible output')), 'output gate fires after threshold')
}

function testLearning() {
  console.log('\n--- Learning ---')
  const dir = mkdtempSync(join(tmpdir(), 'tanren-learn-'))
  const gateSystem = createGateSystem()

  const learning = createLearningSystem({
    stateDir: dir,
    gateSystem,
    enabled: true,
    crystallization: true,
    selfPerception: true,
  })

  // Simulate a tick with actions
  const goodTick = {
    perception: 'test', thought: 'test', timestamp: Date.now(),
    actions: [{ type: 'remember', content: 'test', raw: '' }],
    gateResults: [],
    observation: {
      outputExists: true, outputQuality: 0, confidenceCalibration: 0,
      actionsExecuted: 1, actionsFailed: 0, duration: 5000,
    },
  }

  const result = learning.afterTick(goodTick, [])
  assert(result.quality >= 3, 'good tick gets decent quality')
  assert(result.signals.length > 0, 'signals reported')

  // Simulate empty tick
  const emptyTick = {
    perception: 'test', thought: 'thinking...', timestamp: Date.now(),
    actions: [],
    gateResults: [],
    observation: {
      outputExists: false, outputQuality: 0, confidenceCalibration: 0,
      actionsExecuted: 0, actionsFailed: 0, duration: 500,
    },
  }

  const result2 = learning.afterTick(emptyTick, [])
  assert(result2.quality < 3, 'empty tick gets low quality')

  // Crystallization state persists
  learning.save()
  assert(existsSync(join(dir, 'crystallization.json')), 'crystallization state saved')

  rmSync(dir, { recursive: true })
}

async function testFullCycle() {
  console.log('\n--- Full Cycle (mock LLM) ---')
  const dir = mkdtempSync(join(tmpdir(), 'tanren-full-'))

  // Mock LLM that returns a remember action
  const mockLLM: LLMProvider = {
    async think() {
      return 'I see the environment. <action:remember>First memory from smoke test</action:remember>'
    },
  }

  const agent = createAgent({
    identity: 'I am a test agent.',
    memoryDir: join(dir, 'memory'),
    llm: mockLLM,
    feedbackRounds: 0,  // disable feedback loop for basic cycle test
    perceptionPlugins: [
      { name: 'test', fn: () => 'Hello from test' },
    ],
  })

  const result = await agent.tick()
  assert(result.actions.length === 1, 'parsed 1 action from mock LLM')
  assert(result.actions[0].type === 'remember', 'action type is remember')
  assert(result.observation.actionsExecuted === 1, '1 action executed')
  assert(result.observation.actionsFailed === 0, '0 actions failed')

  // Memory was written
  const memoryContent = readFileSync(join(dir, 'memory', 'memory.md'), 'utf-8')
  assert(memoryContent.includes('First memory from smoke test'), 'memory written by agent')

  rmSync(dir, { recursive: true })
}

// === Run All ===

async function main() {
  console.log('🔨 Tanren Smoke Test\n')

  await testMemory()
  await testPerception()
  await testActions()
  testGates()
  testLearning()
  await testFullCycle()

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
