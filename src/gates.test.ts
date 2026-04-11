/**
 * Tanren — Gate System Tests
 *
 * Verifies gate execution, built-in gates, and the GateSystem interface.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGateSystem,
  defineGate,
  createOutputGate,
  createAnalysisWithoutActionGate,
  createProductivityGate,
} from './gates.js'
import type { TickResult, GateContext, MemoryReader } from './types.js'

// Helper: minimal TickResult for testing
function makeTick(overrides: Partial<TickResult> = {}): TickResult {
  return {
    perception: '',
    thought: '',
    actions: [],
    observation: {
      outputExists: false,
      outputQuality: 0,
      confidenceCalibration: 0,
      actionsExecuted: 0,
      actionsFailed: 0,
      duration: 1000,
    },
    timestamp: Date.now(),
    gateResults: [],
    ...overrides,
  }
}

function makeContext(tick: TickResult, recentTicks: TickResult[] = []): GateContext {
  return {
    tick,
    recentTicks,
    memory: { read: async () => null, search: async () => [] } as MemoryReader,
    state: {},
  }
}

describe('GateSystem', () => {
  it('runs all registered gates', () => {
    const system = createGateSystem()
    const gate = defineGate({
      name: 'test-gate',
      description: 'always warns',
      check: () => ({ action: 'warn', message: 'test warning' }),
    })
    system.register(gate)

    const tick = makeTick()
    const results = system.runAll(makeContext(tick))

    assert.equal(results.length, 1)
    assert.equal(results[0].action, 'warn')
  })

  it('prevents duplicate gate registration', () => {
    const system = createGateSystem()
    system.register(defineGate({ name: 'g', description: '', check: () => ({ action: 'pass' }) }))
    system.register(defineGate({ name: 'g', description: 'updated', check: () => ({ action: 'warn', message: 'v2' }) }))

    assert.equal(system.getGateNames().length, 1)
  })

  it('catches gate errors gracefully', () => {
    const system = createGateSystem()
    system.register(defineGate({
      name: 'broken',
      description: 'throws',
      check: () => { throw new Error('boom') },
    }))

    const results = system.runAll(makeContext(makeTick()))
    assert.equal(results.length, 1)
    assert.equal(results[0].action, 'warn')
    assert.ok((results[0] as { message: string }).message.includes('boom'))
  })
})

describe('OutputGate', () => {
  it('warns after N consecutive ticks without output', () => {
    const gate = createOutputGate(2)

    // Tick 1: no output → no warn yet
    let result = gate.check(makeContext(makeTick({ observation: { outputExists: false, outputQuality: 0, confidenceCalibration: 0, actionsExecuted: 0, actionsFailed: 0, duration: 1000 } })))
    assert.equal(result.action, 'pass')

    // Tick 2: no output → warn
    result = gate.check(makeContext(makeTick({ observation: { outputExists: false, outputQuality: 0, confidenceCalibration: 0, actionsExecuted: 0, actionsFailed: 0, duration: 1000 } })))
    assert.equal(result.action, 'warn')

    // Tick 3: has output → reset
    result = gate.check(makeContext(makeTick({ observation: { outputExists: true, outputQuality: 3, confidenceCalibration: 0, actionsExecuted: 1, actionsFailed: 0, duration: 1000 } })))
    assert.equal(result.action, 'pass')
  })
})

describe('AnalysisWithoutActionGate', () => {
  it('warns after N ticks with thought but zero actions', () => {
    const gate = createAnalysisWithoutActionGate(2, 50)

    // Tick 1: long thought, no actions
    let result = gate.check(makeContext(makeTick({ thought: 'a'.repeat(100), actions: [] })))
    assert.equal(result.action, 'pass')

    // Tick 2: same → warn
    result = gate.check(makeContext(makeTick({ thought: 'b'.repeat(100), actions: [] })))
    assert.equal(result.action, 'warn')
  })

  it('resets when actions are present', () => {
    const gate = createAnalysisWithoutActionGate(2, 50)

    gate.check(makeContext(makeTick({ thought: 'a'.repeat(100), actions: [] })))
    gate.check(makeContext(makeTick({ thought: 'b'.repeat(100), actions: [{ type: 'respond', content: 'hi', raw: '' }] })))

    // Should be reset — next empty tick should not warn
    const result = gate.check(makeContext(makeTick({ thought: 'c'.repeat(100), actions: [] })))
    assert.equal(result.action, 'pass')
  })
})

describe('ProductivityGate', () => {
  it('warns after N ticks with only internal actions', () => {
    const gate = createProductivityGate(2)

    const internalTick = makeTick({ actions: [{ type: 'remember', content: 'x', raw: '' }] })

    gate.check(makeContext(internalTick))
    const result = gate.check(makeContext(internalTick))

    assert.equal(result.action, 'warn')
  })

  it('does not warn when external actions are present', () => {
    const gate = createProductivityGate(2)

    gate.check(makeContext(makeTick({ actions: [{ type: 'remember', content: 'x', raw: '' }] })))
    gate.check(makeContext(makeTick({ actions: [{ type: 'respond', content: 'hi', raw: '' }] })))

    // reset — next internal-only should not warn
    const result = gate.check(makeContext(makeTick({ actions: [{ type: 'read', content: '', raw: '' }] })))
    assert.equal(result.action, 'pass')
  })
})
