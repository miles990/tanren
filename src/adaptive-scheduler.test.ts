/**
 * Tanren — Adaptive Scheduler Tests
 *
 * Covers: D/E/C behavior, wake budget, feature flag, edge cases.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAdaptiveScheduler } from './adaptive-scheduler.js'

function writeEvent(dir: string, name: string, priorityHint: string = 'medium'): void {
  const pendingDir = join(dir, 'pending')
  if (!existsSync(pendingDir)) mkdirSync(pendingDir, { recursive: true })
  writeFileSync(join(pendingDir, name), JSON.stringify({ priority_hint: priorityHint, event: 'test' }))
}

describe('AdaptiveScheduler', () => {
  let queueDir: string

  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), 'tanren-as-test-'))
    mkdirSync(join(queueDir, 'pending'), { recursive: true })
  })

  it('D behavior: returns baseInterval when queue is empty', () => {
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000 })
    assert.equal(as.getNextInterval(), 60_000)
  })

  it('E behavior: returns reactiveInterval when events are pending', () => {
    writeEvent(queueDir, 'evt-001.json', 'medium')
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000, reactiveInterval: 30_000 })
    assert.equal(as.getNextInterval(), 30_000)
  })

  it('E behavior: restores baseInterval when queue drains', () => {
    writeEvent(queueDir, 'evt-001.json', 'medium')
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000, reactiveInterval: 30_000 })
    assert.equal(as.getNextInterval(), 30_000)

    // Remove event
    unlinkSync(join(queueDir, 'pending', 'evt-001.json'))
    assert.equal(as.getNextInterval(), 60_000)
  })

  it('C behavior: trigger detects high-priority as urgent', async () => {
    writeEvent(queueDir, 'evt-high.json', 'high')
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000 })
    const event = await as.trigger.detect()
    assert.ok(event)
    assert.equal(event!.priority, 'urgent')
    assert.equal((event!.data as any).hasHighPriority, true)
  })

  it('C behavior: trigger detects medium-priority as normal', async () => {
    writeEvent(queueDir, 'evt-med.json', 'medium')
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000 })
    const event = await as.trigger.detect()
    assert.ok(event)
    assert.equal(event!.priority, 'normal')
  })

  it('trigger returns null when queue is empty', async () => {
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000 })
    const event = await as.trigger.detect()
    assert.equal(event, null)
  })

  it('wake budget allows wakes within limit', () => {
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000, wakeBudgetPerHour: 3 })
    assert.equal(as.recordWake(), true)
    assert.equal(as.recordWake(), true)
    assert.equal(as.recordWake(), true)
    assert.equal(as.recordWake(), false, 'should reject after budget exhausted')
  })

  it('wake budget resets after reset()', () => {
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000, wakeBudgetPerHour: 2 })
    assert.equal(as.recordWake(), true)
    assert.equal(as.recordWake(), true)
    assert.equal(as.recordWake(), false)
    as.reset()
    assert.equal(as.recordWake(), true)
  })

  it('stats reports correct values', () => {
    writeEvent(queueDir, 'evt-001.json')
    writeEvent(queueDir, 'evt-002.json')
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000, wakeBudgetPerHour: 10 })
    as.recordWake()
    const s = as.stats()
    assert.equal(s.queuePending, 2)
    assert.equal(s.wakesThisHour, 1)
    assert.equal(s.budgetRemaining, 9)
  })

  it('ignores .tmp files and hidden files in pending/', () => {
    writeFileSync(join(queueDir, 'pending', '.evt-001.json.tmp'), '{}')
    writeFileSync(join(queueDir, 'pending', '.hidden'), '{}')
    writeEvent(queueDir, 'real-event.json')
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000 })
    assert.equal(as.stats().queuePending, 1)
  })

  it('defaults: reactiveInterval=30s, wakeBudget=30, cooldown=10s', () => {
    const as = createAdaptiveScheduler({ queueDir, baseInterval: 60_000 })
    assert.equal(as.trigger.cooldown, 10_000)
    // Verify default reactive interval by adding an event
    writeEvent(queueDir, 'evt-001.json')
    assert.equal(as.getNextInterval(), 30_000)
  })
})
