/**
 * Memory + write-queue integration test (Phase 2, KG 94c784bd).
 *
 * Validates setAsyncMode wiring:
 *   - async=false (deep path) → memory.write() does sync writeFile (current behavior)
 *   - async=true (reactive path) → memory.write() enqueues, returns immediately,
 *     content visible to memory.read() via cache before disk drain
 *   - same-tick read-your-own-write works
 *   - toggling back to sync after async drains pending entries
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemorySystem } from './memory.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tanren-mem-async-test-'))
}

describe('memory.setAsyncMode wiring', () => {
  let dir: string

  beforeEach(() => {
    dir = tmp()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exposes setAsyncMode method', () => {
    const mem = createMemorySystem(dir)
    expect(typeof (mem as { setAsyncMode?: unknown }).setAsyncMode).toBe('function')
  })

  it('sync mode (default): write hits disk immediately', async () => {
    const mem = createMemorySystem(dir)
    await mem.write('a.md', 'hello')
    const filePath = join(dir, 'a.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('hello')
  })

  it('async mode: write enqueues, persists to queue dir', async () => {
    const mem = createMemorySystem(dir)
    mem.setAsyncMode!(true)
    await mem.write('a.md', 'async-content')
    // Queue persisted but disk not yet (drain runs every 100ms)
    const pendingDir = join(dir, 'state', 'write-queue', 'pending')
    expect(existsSync(pendingDir)).toBe(true)
    const queueFiles = readdirSync(pendingDir)
    expect(queueFiles.length).toBeGreaterThan(0)
  })

  it('async mode: same-tick read-your-own-write via cache', async () => {
    const mem = createMemorySystem(dir)
    mem.setAsyncMode!(true)
    await mem.write('a.md', 'fresh-content')
    // Read immediately — should hit cache before disk drain
    const got = await mem.read('a.md')
    expect(got).toBe('fresh-content')
  })

  it('async mode: cache wins over stale disk', async () => {
    const mem = createMemorySystem(dir)
    // First sync-write something old
    await mem.write('a.md', 'old-disk-content')
    // Switch to async, write new content
    mem.setAsyncMode!(true)
    await mem.write('a.md', 'new-cached-content')
    // Cache returns new, before drain hits disk
    expect(await mem.read('a.md')).toBe('new-cached-content')
  })

  it('async mode: drain eventually writes to disk', async () => {
    const mem = createMemorySystem(dir)
    mem.setAsyncMode!(true)
    await mem.write('drain-target.md', 'will-land-on-disk')
    // Wait for consumer thread to drain (drainIntervalMs default = 100ms)
    await new Promise(r => setTimeout(r, 300))
    const filePath = join(dir, 'drain-target.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('will-land-on-disk')
  })

  it('async append also routes through queue', async () => {
    const mem = createMemorySystem(dir)
    mem.setAsyncMode!(true)
    await mem.append('log.md', 'line one')
    // Cache should reflect append content
    expect(await mem.read('log.md')).toBe('line one')
  })

  it('toggle async → sync: subsequent writes go straight to disk', async () => {
    const mem = createMemorySystem(dir)
    mem.setAsyncMode!(true)
    await mem.write('mixed.md', 'async-write')
    mem.setAsyncMode!(false)
    await mem.write('mixed-2.md', 'sync-write')
    expect(existsSync(join(dir, 'mixed-2.md'))).toBe(true)
    expect(readFileSync(join(dir, 'mixed-2.md'), 'utf-8')).toBe('sync-write')
  })

  it('causal_key forwards to underlying queue', async () => {
    const mem = createMemorySystem(dir)
    mem.setAsyncMode!(true)
    await mem.write('a.md', '1', { causal_key: 'session-A' })
    await mem.write('a.md', '2', { causal_key: 'session-A' })
    // Wait for drain
    await new Promise(r => setTimeout(r, 300))
    // FIFO within same causal_key — final content is '2'
    const final = readFileSync(join(dir, 'a.md'), 'utf-8')
    expect(final).toBe('2')
  })
})
