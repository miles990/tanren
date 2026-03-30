/**
 * Tanren Smoke Test — verify the framework works without LLM
 *
 * Tests: memory, perception, gates, actions, loop (with mock LLM)
 * Run: npx tsx src/smoke-test.ts
 */

import { createAgent, defineGate, createOutputGate } from './index.js'
import type { LLMProvider, GateResult, MemoryReader } from './types.js'
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

function testCrystallization() {
  console.log('\n--- Crystallization: Failure → Pattern → Gate ---')
  const dir = mkdtempSync(join(tmpdir(), 'tanren-crystal-'))
  const gateSystem = createGateSystem()

  const learning = createLearningSystem({
    stateDir: dir,
    gateSystem,
    enabled: true,
    crystallization: true,
    selfPerception: true,
  })

  // Simulate 3 ticks where the same action fails with the same error.
  // The crystallization engine should detect the repeated-failure pattern
  // and auto-generate a gate after the 3rd occurrence.

  const makeFailingTick = (i: number) => ({
    perception: `tick ${i}`,
    thought: `Attempting to fetch data, try #${i}`,
    timestamp: Date.now() + i * 1000,
    actions: [{ type: 'fetch', content: 'https://api.example.com/data', raw: '<action:fetch>https://api.example.com/data</action:fetch>' }],
    gateResults: [] as GateResult[],
    observation: {
      outputExists: false,
      outputQuality: 0,
      confidenceCalibration: 0,
      actionsExecuted: 0,
      actionsFailed: 1,
      duration: 3000,
      environmentFeedback: 'action fetch failed: connection timeout after <n>ms',
    },
  })

  const allTicks: TickResult[] = []

  // Tick 1: first failure — pattern recorded, no crystallization yet
  const tick1 = makeFailingTick(1)
  const result1 = learning.afterTick(tick1, allTicks)
  allTicks.push(tick1)
  assert(result1.newGates.length === 0, 'tick 1: no gates yet (1st occurrence)')

  const patterns1 = learning.getPatterns()
  const failurePattern1 = patterns1.find(p => p.type === 'repeated-failure')
  assert(failurePattern1 !== undefined, 'tick 1: failure pattern detected')
  assert(failurePattern1!.occurrences === 1, 'tick 1: 1 occurrence recorded')

  // Tick 2: same failure — approaching threshold
  const tick2 = makeFailingTick(2)
  const result2 = learning.afterTick(tick2, allTicks)
  allTicks.push(tick2)
  assert(result2.newGates.length === 0, 'tick 2: no gates yet (2nd occurrence)')

  const patterns2 = learning.getPatterns()
  const failurePattern2 = patterns2.find(p => p.type === 'repeated-failure')
  assert(failurePattern2!.occurrences === 2, 'tick 2: 2 occurrences recorded')

  // Tick 3: same failure — threshold reached, gate should crystallize
  const tick3 = makeFailingTick(3)
  const result3 = learning.afterTick(tick3, allTicks)
  allTicks.push(tick3)
  assert(result3.newGates.length === 1, 'tick 3: 1 gate crystallized!')

  const crystallizedGate = result3.newGates[0]
  assert(crystallizedGate.name.startsWith('auto-'), 'crystallized gate has auto- prefix')
  assert(crystallizedGate.description.includes('fetch'), 'gate description mentions the failing action')

  // Context section reports the crystallization event (check immediately after tick 3)
  const ctx = learning.getContextSection()
  assert(ctx.includes('Crystallized'), 'context section reports crystallization')

  // Verify pattern is marked as crystallized
  const patterns3 = learning.getPatterns()
  const failurePattern3 = patterns3.find(p => p.type === 'repeated-failure')
  assert(failurePattern3!.crystallized === true, 'pattern marked as crystallized')

  // Tick 4: same action attempted again — the auto-gate should fire a warning
  const tick4 = makeFailingTick(4)
  const gateContext = {
    tick: tick4,
    recentTicks: allTicks,
    memory: { read: async () => null, search: async () => [] } as MemoryReader,
    state: {},
  }
  const gateResults = gateSystem.runAll(gateContext)
  const warnings = gateResults.filter(r => r.action === 'warn')
  assert(warnings.length >= 1, 'tick 4: auto-crystallized gate fires warning on same action')
  assert(
    (warnings[0] as { message: string }).message.includes('fetch'),
    'gate warning mentions the problematic action type'
  )

  // Verify no duplicate crystallization on tick 4
  const result4 = learning.afterTick(tick4, allTicks)
  assert(result4.newGates.length === 0, 'tick 4: no duplicate crystallization')

  // Verify state persistence
  learning.save()
  const stateFile = join(dir, 'crystallization.json')
  assert(existsSync(stateFile), 'crystallization state persisted')
  const savedState = JSON.parse(readFileSync(stateFile, 'utf-8'))
  assert(savedState.patterns.length > 0, 'patterns saved to disk')
  assert(savedState.patterns.some((p: { crystallized: boolean }) => p.crystallized), 'crystallized flag persisted')

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
  testCrystallization()
  await testFullCycle()

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
