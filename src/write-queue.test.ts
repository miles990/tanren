/**
 * Write queue tests — Phase 2 (KG 94c784bd).
 *
 * Covers all three layers:
 *   - L1: at-least-once persistence + retry + dead-letter + back-pressure
 *   - L2: write-through cache (same-tick read-your-own-write)
 *   - L3: causal_key FIFO ordering
 * Plus crash recovery (replay from disk).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteQueue, type WriteQueue } from './write-queue.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tanren-wq-test-'))
}

describe('Layer 2 — write-through cache', () => {
  let dir: string
  let queue: WriteQueue

  beforeEach(() => {
    dir = makeTempDir()
    queue = createWriteQueue(
      dir,
      async () => { /* no-op syncWriter */ },
      { drainIntervalMs: 10 },
    )
  })

  afterEach(async () => {
    await queue.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('cache returns content immediately after enqueue (same-tick read-your-own-write)', async () => {
    await queue.enqueue({ path: 'memory.md', op: 'write', content: 'hello' })
    expect(queue.cacheGet('memory.md')).toBe('hello')
  })

  it('cacheGet returns null for unwritten path', () => {
    expect(queue.cacheGet('never-written.md')).toBe(null)
  })

  it('latest write wins in cache', async () => {
    await queue.enqueue({ path: 'memory.md', op: 'write', content: 'first' })
    await queue.enqueue({ path: 'memory.md', op: 'write', content: 'second' })
    expect(queue.cacheGet('memory.md')).toBe('second')
  })
})

describe('Layer 1 — at-least-once persistence + consumer', () => {
  let dir: string
  let queue: WriteQueue
  let writes: Array<{ path: string; content: string; op: string }>

  beforeEach(() => {
    dir = makeTempDir()
    writes = []
    queue = createWriteQueue(
      dir,
      async (path, content, op) => { writes.push({ path, content, op }) },
      { drainIntervalMs: 10 },
    )
  })

  afterEach(async () => {
    await queue.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists entry as JSONL file in pending/ on enqueue', async () => {
    await queue.enqueue({ path: 'foo.md', op: 'write', content: 'bar' })
    const pendingDir = join(dir, 'state', 'write-queue', 'pending')
    const files = readdirSync(pendingDir)
    expect(files.length).toBe(1)
    const content = readFileSync(join(pendingDir, files[0]), 'utf-8')
    const entry = JSON.parse(content.trim())
    expect(entry.path).toBe('foo.md')
    expect(entry.content).toBe('bar')
    expect(entry.op).toBe('write')
    expect(entry.attempts).toBe(0)
  })

  it('consumer drains queue → syncWriter called', async () => {
    await queue.enqueue({ path: 'a.md', op: 'write', content: 'A' })
    expect(queue.depth()).toBe(1)
    const result = await queue.drain()
    expect(result.drained).toBe(1)
    expect(result.failed).toBe(0)
    expect(writes).toEqual([{ path: 'a.md', content: 'A', op: 'write' }])
    expect(queue.depth()).toBe(0)
  })

  it('removes pending file after successful drain', async () => {
    await queue.enqueue({ path: 'a.md', op: 'write', content: 'A' })
    await queue.drain()
    const pendingDir = join(dir, 'state', 'write-queue', 'pending')
    expect(readdirSync(pendingDir).length).toBe(0)
  })

  it('retries failed writes up to maxRetries, then dead-letters', async () => {
    let attempts = 0
    await queue.stop()
    queue = createWriteQueue(
      dir,
      async () => { attempts++; throw new Error('simulated failure') },
      { drainIntervalMs: 60_000, maxRetries: 3 },
    )
    await queue.enqueue({ path: 'failing.md', op: 'write', content: 'X' })
    await queue.drain()
    await queue.drain()
    await queue.drain()
    expect(attempts).toBe(3)
    const deadDir = join(dir, 'state', 'write-queue', 'dead')
    const deadFiles = readdirSync(deadDir)
    expect(deadFiles.length).toBe(1)
    expect(queue.depth()).toBe(0)
  })

  it('back-pressure falls back to sync write when queue full', async () => {
    await queue.stop()
    writes = []
    queue = createWriteQueue(
      dir,
      async (path, content, op) => { writes.push({ path, content, op }) },
      { drainIntervalMs: 60_000, maxDepth: 2 },
    )
    await queue.enqueue({ path: 'a.md', op: 'write', content: 'A' })
    await queue.enqueue({ path: 'b.md', op: 'write', content: 'B' })
    expect(queue.depth()).toBe(2)
    expect(writes.length).toBe(0)
    await queue.enqueue({ path: 'c.md', op: 'write', content: 'C' })
    expect(writes).toEqual([{ path: 'c.md', content: 'C', op: 'write' }])
    expect(queue.depth()).toBe(2)
  })
})

describe('Layer 3 — causal_key FIFO ordering', () => {
  let dir: string
  let queue: WriteQueue
  let writes: Array<{ path: string; content: string }>

  beforeEach(() => {
    dir = makeTempDir()
    writes = []
    queue = createWriteQueue(
      dir,
      async (path, content) => { writes.push({ path, content }) },
      { drainIntervalMs: 60_000 },
    )
  })

  afterEach(async () => {
    await queue.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('same causal_key drains FIFO', async () => {
    await queue.enqueue({ path: 'a.md', op: 'write', content: '1', causal_key: 'k1' })
    await queue.enqueue({ path: 'a.md', op: 'write', content: '2', causal_key: 'k1' })
    await queue.enqueue({ path: 'a.md', op: 'write', content: '3', causal_key: 'k1' })
    await queue.drain()
    expect(writes.map(w => w.content)).toEqual(['1', '2', '3'])
  })

  it('different causal_keys drain independently', async () => {
    await queue.enqueue({ path: 'a.md', op: 'write', content: 'A', causal_key: 'k1' })
    await queue.enqueue({ path: 'b.md', op: 'write', content: 'B', causal_key: 'k2' })
    const r = await queue.drain()
    expect(r.drained).toBe(2)
    expect(writes.map(w => w.path).sort()).toEqual(['a.md', 'b.md'])
  })

  it('framework-inferred path-hash default when causal_key omitted', async () => {
    await queue.enqueue({ path: 'memory.md', op: 'write', content: '1' })
    await queue.enqueue({ path: 'memory.md', op: 'write', content: '2' })
    await queue.drain()
    expect(writes.map(w => w.content)).toEqual(['1', '2'])
  })
})

describe('Crash recovery — replay from disk', () => {
  it('rebuilds in-flight queue from pending/ files on startup', async () => {
    const dir = makeTempDir()
    const writes: Array<{ path: string; content: string }> = []

    const q1 = createWriteQueue(
      dir,
      async () => { /* no-op for q1 */ },
      { drainIntervalMs: 60_000 },
    )
    await q1.enqueue({ path: 'survives.md', op: 'write', content: 'persist-me' })
    expect(q1.depth()).toBe(1)
    // Simulate crash: no q1.stop(), no drain — leave file on disk

    const q2 = createWriteQueue(
      dir,
      async (path, content) => { writes.push({ path, content }) },
      { drainIntervalMs: 60_000 },
    )
    // Constructor calls replay() async; give it a tick to land
    await new Promise(r => setTimeout(r, 50))
    expect(q2.depth()).toBeGreaterThanOrEqual(1)
    await q2.drain()
    expect(writes).toEqual([{ path: 'survives.md', content: 'persist-me' }])
    await q2.stop()
    rmSync(dir, { recursive: true, force: true })
  })
})
