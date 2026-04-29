/**
 * Tanren — Event Queue Tests
 *
 * Covers: enqueue/claim/complete/fail, race condition mitigations,
 * backpressure, dead-letter, crash recovery.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEventQueue, type AgentEvent, type QueuedEvent } from './event-queue.js'

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    source: 'test',
    event: 'test.event',
    priority_hint: 'medium',
    payload: {},
    version: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('EventQueue', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'tanren-eq-test-'))
  })

  it('enqueue creates file in pending/', () => {
    const q = createEventQueue(baseDir)
    const id = q.enqueue(makeEvent())
    const files = readdirSync(join(baseDir, 'pending')).filter(f => f.endsWith('.json'))
    assert.equal(files.length, 1)
    assert.ok(id.endsWith('.json'))
  })

  it('enqueue uses atomic write (.tmp not visible)', () => {
    const q = createEventQueue(baseDir)
    q.enqueue(makeEvent())
    const allFiles = readdirSync(join(baseDir, 'pending'))
    const tmpFiles = allFiles.filter(f => f.startsWith('.'))
    assert.equal(tmpFiles.length, 0, 'no .tmp files should remain')
  })

  it('claim moves files from pending to processing', () => {
    const q = createEventQueue(baseDir)
    q.enqueue(makeEvent())
    q.enqueue(makeEvent())
    const claimed = q.claim(5)
    assert.equal(claimed.length, 2)
    assert.equal(readdirSync(join(baseDir, 'pending')).filter(f => f.endsWith('.json')).length, 0)
    assert.equal(readdirSync(join(baseDir, 'processing')).filter(f => f.endsWith('.json')).length, 2)
  })

  it('claim respects maxCount', () => {
    const q = createEventQueue(baseDir)
    q.enqueue(makeEvent())
    q.enqueue(makeEvent())
    q.enqueue(makeEvent())
    const claimed = q.claim(2)
    assert.equal(claimed.length, 2)
    assert.equal(readdirSync(join(baseDir, 'pending')).filter(f => f.endsWith('.json')).length, 1)
  })

  it('claim returns events sorted by priority (high first)', () => {
    const q = createEventQueue(baseDir)
    q.enqueue(makeEvent({ priority_hint: 'low', event: 'low' }))
    q.enqueue(makeEvent({ priority_hint: 'high', event: 'high' }))
    q.enqueue(makeEvent({ priority_hint: 'medium', event: 'medium' }))
    const claimed = q.claim(3)
    assert.equal(claimed[0].event, 'high')
    assert.equal(claimed[1].event, 'medium')
    assert.equal(claimed[2].event, 'low')
  })

  it('complete moves from processing to processed/date/', () => {
    const q = createEventQueue(baseDir)
    q.enqueue(makeEvent())
    const [evt] = q.claim(1)
    q.complete(evt.id)
    assert.equal(readdirSync(join(baseDir, 'processing')).filter(f => f.endsWith('.json')).length, 0)
    const today = new Date().toISOString().slice(0, 10)
    const processed = readdirSync(join(baseDir, 'processed', today))
    assert.equal(processed.length, 1)
  })

  it('fail retries up to MAX_RETRY then dead-letters', () => {
    const q = createEventQueue(baseDir)
    q.enqueue(makeEvent())

    // Attempt 1 → fail → back to pending (attempt 2)
    let [evt] = q.claim(1)
    q.fail(evt.id, 'error 1')
    assert.equal(readdirSync(join(baseDir, 'pending')).filter(f => f.endsWith('.json')).length, 1)

    // Attempt 2 → fail → back to pending (attempt 3)
    ;[evt] = q.claim(1)
    assert.equal(evt.attempt, 2)
    q.fail(evt.id, 'error 2')

    // Attempt 3 → fail → dead-letter
    ;[evt] = q.claim(1)
    assert.equal(evt.attempt, 3)
    q.fail(evt.id, 'error 3')

    assert.equal(readdirSync(join(baseDir, 'pending')).filter(f => f.endsWith('.json')).length, 0)
    assert.equal(readdirSync(join(baseDir, 'dead-letter')).filter(f => f.endsWith('.json')).length, 1)
  })

  it('recover moves stale processing back to pending', () => {
    const q = createEventQueue(baseDir)
    // Simulate crash: file left in processing/
    const fakeEvent: QueuedEvent = {
      ...makeEvent(), id: 'crash-test.json', attempt: 1, enqueuedAt: new Date().toISOString(),
    }
    writeFileSync(join(baseDir, 'processing', 'crash-test.json'), JSON.stringify(fakeEvent), 'utf-8')

    const recovered = q.recover()
    assert.equal(recovered, 1)
    assert.equal(readdirSync(join(baseDir, 'pending')).filter(f => f.endsWith('.json')).length, 1)
    assert.equal(readdirSync(join(baseDir, 'processing')).filter(f => f.endsWith('.json')).length, 0)
  })

  it('stats reports correct counts and backpressure', () => {
    const q = createEventQueue(baseDir)
    let s = q.stats()
    assert.equal(s.pending, 0)
    assert.equal(s.backpressure, 'normal')

    for (let i = 0; i < 55; i++) q.enqueue(makeEvent())
    s = q.stats()
    assert.equal(s.pending, 55)
    assert.equal(s.backpressure, 'warning')
  })

  it('monotonic counter ensures unique filenames', () => {
    const q = createEventQueue(baseDir)
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) {
      ids.add(q.enqueue(makeEvent()))
    }
    assert.equal(ids.size, 20, 'all IDs should be unique')
  })
})
