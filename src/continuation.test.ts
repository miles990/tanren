/**
 * Tanren — Continuation System Tests
 *
 * Verifies convergence logic: agent explicit declaration is the only
 * convergence source. Framework never infers intent from action types.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContinuationSystem } from './continuation.js'
import type { TickResult } from './types.js'

function makeTick(overrides: Partial<TickResult> = {}): TickResult {
  return {
    perception: '',
    thought: '',
    actions: [],
    observation: {
      outputExists: false,
      outputQuality: 0,
      confidenceCalibration: 0,
      actionsExecuted: 1,
      actionsFailed: 0,
      duration: 1000,
    },
    timestamp: Date.now(),
    gateResults: [],
    ...overrides,
  }
}

describe('ContinuationSystem', () => {
  let memoryDir: string
  let stateDir: string

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), 'tanren-cont-test-'))
    stateDir = join(memoryDir, 'state')
    mkdirSync(stateDir, { recursive: true })
  })

  it('respond action does NOT stop chain (regression)', () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    const tick = makeTick({
      actions: [{ type: 'respond', content: 'Hello', raw: '', attrs: {} }],
    })
    cont.recordTick(tick, 1)

    const decision = cont.shouldContinue(tick)
    assert.equal(decision.continue, true, 'respond should NOT trigger implicit convergence')
  })

  it('converged:yes in reflect stops chain', () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    writeFileSync(join(stateDir, 'last-reflection.md'), 'converged: yes\nreason: task complete')

    const tick = makeTick({
      actions: [{ type: 'respond', content: 'Done', raw: '', attrs: {} }],
    })
    cont.recordTick(tick, 1)

    const decision = cont.shouldContinue(tick)
    assert.equal(decision.continue, false, 'explicit converged:yes should stop chain')
    assert.match(decision.reason, /converged/)
  })

  it('hard cap stops chain at 20 ticks', () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    const tick = makeTick({
      actions: [{ type: 'http_request', content: '', raw: '', attrs: {} }],
    })

    for (let i = 0; i < 20; i++) {
      cont.recordTick(tick, i + 1)
    }

    const decision = cont.shouldContinue(tick)
    assert.equal(decision.continue, false, 'should stop at hard cap')
    assert.match(decision.reason, /hard cap/)
  })

  it('gate violation stops chain', () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    const tick = makeTick({
      actions: [{ type: 'respond', content: 'test', raw: '', attrs: {} }],
      gateResults: [{ action: 'warn', message: 'quality too low' }],
    })
    cont.recordTick(tick, 1)

    const decision = cont.shouldContinue(tick)
    assert.equal(decision.continue, false, 'gate violation should stop chain')
    assert.match(decision.reason, /gate violation/)
  })

  it('2 consecutive empty ticks stops chain', () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    const emptyTick = makeTick({ observation: { outputExists: false, outputQuality: 0, confidenceCalibration: 0, actionsExecuted: 0, actionsFailed: 0, duration: 500 } })

    cont.recordTick(emptyTick, 1)
    cont.shouldContinue(emptyTick)
    cont.recordTick(emptyTick, 2)

    const decision = cont.shouldContinue(emptyTick)
    assert.equal(decision.continue, false, '2 empty ticks should stop chain')
  })

  it('respond + more actions in next tick continues (multi-step workflow)', () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    const tick1 = makeTick({
      actions: [
        { type: 'http_request', content: '', raw: '', attrs: {} },
        { type: 'respond', content: 'Acknowledged, working on it', raw: '', attrs: {} },
      ],
    })
    cont.recordTick(tick1, 1)

    const decision1 = cont.shouldContinue(tick1)
    assert.equal(decision1.continue, true, 'respond in tick 1 should NOT stop — agent has more work')

    const tick2 = makeTick({
      actions: [{ type: 'http_request', content: '', raw: '', attrs: {} }],
    })
    cont.recordTick(tick2, 2)

    const decision2 = cont.shouldContinue(tick2)
    assert.equal(decision2.continue, true, 'tick 2 without converged should continue')
  })

  it('no reflection file defaults to not converged', () => {
    const cont = createContinuationSystem(memoryDir)
    const result = cont.readConvergence()
    assert.equal(result.converged, false)
  })

  it('alternative converged keywords: done and 完成', () => {
    const cont = createContinuationSystem(memoryDir)

    writeFileSync(join(stateDir, 'last-reflection.md'), 'converged: done\nreason: all tasks finished')
    assert.equal(cont.readConvergence().converged, true, 'converged:done should work')

    writeFileSync(join(stateDir, 'last-reflection.md'), 'converged: 完成\nreason: 全部做完了')
    assert.equal(cont.readConvergence().converged, true, 'converged:完成 should work')

    writeFileSync(join(stateDir, 'last-reflection.md'), 'converged: true\nreason: done')
    assert.equal(cont.readConvergence().converged, true, 'converged:true should work')
  })

  it('chain perception includes respond drift warning', async () => {
    const cont = createContinuationSystem(memoryDir)
    cont.startChain()

    const tick1 = makeTick({
      actions: [
        { type: 'http_request', content: '', raw: '', attrs: {} },
        { type: 'respond', content: 'I will do X', raw: '', attrs: {} },
      ],
    })
    cont.recordTick(tick1, 1)

    const tick2 = makeTick({
      actions: [{ type: 'http_request', content: '', raw: '', attrs: {} }],
    })
    cont.recordTick(tick2, 2)

    const perception = await cont.getChainPerception().fn()
    assert.ok(perception.includes('STALE'), 'should warn about stale respond')
  })
})
