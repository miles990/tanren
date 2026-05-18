/**
 * Tanren — Memory Write Async Queue (Phase 2, KG discussion 94c784bd).
 *
 * Three-layer mechanism:
 *
 *   Layer 1 — At-least-once persistent queue:
 *     File-backed JSONL append in memory/state/write-queue/.
 *     fsync after each enqueue guarantees durability before response.
 *     Consumer thread drains every 100ms; failed writes → dead-letter dir.
 *     Back-pressure: max queue depth = 1000, exceeded → fall back to sync write.
 *
 *   Layer 2 — Write-through in-memory cache:
 *     Per-agent Map<key, value> updated synchronously with enqueue.
 *     Cache entry lives until queue-drain ack (primary) OR 60s (fallback).
 *     Same-tick read-your-own-write correctness preserved.
 *
 *   Layer 3 — Causal-key FIFO:
 *     Each write carries optional causal_key. Default = framework-inferred
 *     path-hash. Same causal_key consumed strictly FIFO; different keys
 *     can drain in parallel.
 *
 * Activation: only when TickPathConfig.memoryWriteBlocking === false
 * (reactive path). Deep path bypasses and writes sync.
 */

import { existsSync, mkdirSync, appendFileSync, openSync, fsyncSync, closeSync, readdirSync, readFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export interface QueueEntry {
  id: string                    // ts-rand
  path: string                  // memory file path (relative to memoryDir)
  op: 'write' | 'append'        // write replaces; append concatenates
  content: string
  causal_key: string            // explicit or path-hash fallback
  enqueued_at: number           // ms epoch
  attempts: number              // retry count (consumer increments)
}

export interface WriteQueueConfig {
  /** Max in-flight entries before back-pressure → sync write fallback. */
  maxDepth?: number              // default 1000
  /** Consumer drain interval ms. */
  drainIntervalMs?: number       // default 100
  /** Max retries before dead-letter. */
  maxRetries?: number            // default 3
  /** Cache fallback expiry (when queue-drain ack signal missing). */
  cacheFallbackMs?: number       // default 60_000
  /** Cache hard cap to prevent unbounded growth. */
  maxCacheEntries?: number       // default 500
}

export interface WriteQueue {
  /** Enqueue a write. Returns immediately after fsync. Falls back to sync if queue full. */
  enqueue(entry: Omit<QueueEntry, 'id' | 'enqueued_at' | 'attempts' | 'causal_key'> & { causal_key?: string }): Promise<void>
  /** Read from in-memory cache; returns null if not cached (caller falls through to disk). */
  cacheGet(path: string): string | null
  /** Currently in-flight queue depth (across all causal keys). */
  depth(): number
  /** Drain queue once (called by consumer thread or test). */
  drain(): Promise<{ drained: number; failed: number }>
  /** Stop consumer thread + flush remaining. For shutdown / test cleanup. */
  stop(): Promise<void>
  /** Replay any pending JSONL files on disk (for crash recovery / restart). */
  replay(): Promise<number>
}

const DEFAULTS = {
  maxDepth: 1000,
  drainIntervalMs: 100,
  maxRetries: 3,
  cacheFallbackMs: 60_000,
  maxCacheEntries: 500,
}

/** path-hash fallback for causal_key when caller doesn't provide one. */
function pathHashCausalKey(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12)
}

interface CacheRecord {
  content: string
  written_at: number
  drain_acked: boolean
}

export function createWriteQueue(
  memoryDir: string,
  syncWriter: (path: string, content: string, op: 'write' | 'append') => Promise<void>,
  config: WriteQueueConfig = {},
): WriteQueue {
  const cfg = { ...DEFAULTS, ...config }
  const queueDir = join(memoryDir, 'state', 'write-queue')
  const pendingDir = join(queueDir, 'pending')
  const deadDir = join(queueDir, 'dead')
  for (const d of [queueDir, pendingDir, deadDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }

  // Layer 2 cache: path -> CacheRecord
  const cache = new Map<string, CacheRecord>()
  // Layer 3 causal queues: causal_key -> ordered list of pending entry ids
  const causalQueues = new Map<string, string[]>()
  // In-flight entries (id -> entry) — source of truth before disk
  const inFlight = new Map<string, QueueEntry>()
  let depth = 0
  let stopped = false
  let consumerTimer: ReturnType<typeof setInterval> | null = null

  /** Persist entry to its own JSONL file (fsync before return). */
  function persistEntry(entry: QueueEntry): void {
    const filename = `${entry.id}.jsonl`
    const fpath = join(pendingDir, filename)
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(fpath, line, 'utf-8')
    // fsync to guarantee durability
    const fd = openSync(fpath, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  /** Remove entry's pending file (after successful consume). */
  function removePending(entryId: string): void {
    const fpath = join(pendingDir, `${entryId}.jsonl`)
    if (existsSync(fpath)) {
      try { unlinkSync(fpath) } catch { /* best effort */ }
    }
  }

  /** Move entry to dead-letter dir after max retries. */
  function moveToDead(entry: QueueEntry, reason: string): void {
    const src = join(pendingDir, `${entry.id}.jsonl`)
    const dst = join(deadDir, `${entry.id}.jsonl`)
    if (existsSync(src)) {
      try { renameSync(src, dst) } catch { /* best effort */ }
    }
    const ann = { ...entry, dead_reason: reason, moved_at: Date.now() }
    try { appendFileSync(dst, '\n' + JSON.stringify(ann) + '\n', 'utf-8') } catch { /* best effort */ }
    console.error(`[write-queue] dead-letter ${entry.id} path=${entry.path}: ${reason}`)
  }

  /** Evict cache entries past fallback expiry OR over hard cap (LRU-ish). */
  function evictCache(): void {
    const now = Date.now()
    // Pass 1: time-based eviction (drain-acked OR fallback expired)
    for (const [path, rec] of cache.entries()) {
      if (rec.drain_acked && now - rec.written_at > 5_000) {
        // Acked + 5s grace for same-tick reads → safe to evict
        cache.delete(path)
      } else if (!rec.drain_acked && now - rec.written_at > cfg.cacheFallbackMs) {
        cache.delete(path)
      }
    }
    // Pass 2: hard cap
    while (cache.size > cfg.maxCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  async function enqueue(input: Omit<QueueEntry, 'id' | 'enqueued_at' | 'attempts' | 'causal_key'> & { causal_key?: string }): Promise<void> {
    const path = input.path
    const causal_key = input.causal_key ?? pathHashCausalKey(path)

    // Update cache write-through (Layer 2) — synchronous, before disk
    cache.set(path, {
      content: input.content,
      written_at: Date.now(),
      drain_acked: false,
    })
    evictCache()

    // Back-pressure (Layer 1): fall back to sync if queue full
    if (depth >= cfg.maxDepth) {
      console.error(`[write-queue] back-pressure (depth=${depth}/${cfg.maxDepth}), falling back to sync write for ${path}`)
      try {
        await syncWriter(path, input.content, input.op)
        // Mark cache acked (sync write succeeded)
        const rec = cache.get(path)
        if (rec) rec.drain_acked = true
        return
      } catch (err) {
        console.error(`[write-queue] sync fallback failed for ${path}: ${err instanceof Error ? err.message : err}`)
        throw err
      }
    }

    // Build entry
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const entry: QueueEntry = {
      id,
      path,
      op: input.op,
      content: input.content,
      causal_key,
      enqueued_at: Date.now(),
      attempts: 0,
    }

    // Persist (fsync) — durability before we return success
    persistEntry(entry)

    // Track in-flight + causal queue
    inFlight.set(id, entry)
    if (!causalQueues.has(causal_key)) causalQueues.set(causal_key, [])
    causalQueues.get(causal_key)!.push(id)
    depth++
  }

  function cacheGet(path: string): string | null {
    const rec = cache.get(path)
    if (!rec) return null
    // Refresh LRU position
    cache.delete(path)
    cache.set(path, rec)
    return rec.content
  }

  /** Drain one pass. For each causal queue, drain in FIFO order until head fails
   *  (which stays put for next retry) or queue empties. */
  async function drain(): Promise<{ drained: number; failed: number }> {
    let drained = 0
    let failed = 0
    const keys = Array.from(causalQueues.keys())
    for (const key of keys) {
      const queue = causalQueues.get(key)
      if (!queue || queue.length === 0) {
        causalQueues.delete(key)
        continue
      }
      // FIFO: keep popping head until failure or empty
      while (queue.length > 0) {
        const headId = queue[0]
        const entry = inFlight.get(headId)
        if (!entry) {
          queue.shift()
          continue
        }
        let success = false
        try {
          await syncWriter(entry.path, entry.content, entry.op)
          success = true
        } catch (err) {
          entry.attempts++
          if (entry.attempts >= cfg.maxRetries) {
            moveToDead(entry, err instanceof Error ? err.message : String(err))
            inFlight.delete(entry.id)
            queue.shift()
            depth = Math.max(0, depth - 1)
            failed++
            continue  // try next entry in same causal queue
          }
          // Retry budget remaining: leave head in place, abort this key's drain
          break
        }
        if (success) {
          removePending(entry.id)
          inFlight.delete(entry.id)
          queue.shift()
          depth = Math.max(0, depth - 1)
          const rec = cache.get(entry.path)
          if (rec) rec.drain_acked = true
          drained++
        }
      }
      if (queue.length === 0) causalQueues.delete(key)
    }
    return { drained, failed }
  }

  async function replay(): Promise<number> {
    if (!existsSync(pendingDir)) return 0
    const files = readdirSync(pendingDir).filter(f => f.endsWith('.jsonl'))
    let replayed = 0
    for (const f of files) {
      const fpath = join(pendingDir, f)
      try {
        const lines = readFileSync(fpath, 'utf-8').trim().split('\n').filter(Boolean)
        const lastLine = lines[lines.length - 1]
        const entry = JSON.parse(lastLine) as QueueEntry
        if (!inFlight.has(entry.id)) {
          inFlight.set(entry.id, entry)
          if (!causalQueues.has(entry.causal_key)) causalQueues.set(entry.causal_key, [])
          causalQueues.get(entry.causal_key)!.push(entry.id)
          depth++
          replayed++
        }
      } catch (err) {
        console.error(`[write-queue] replay parse failure for ${f}: ${err instanceof Error ? err.message : err}`)
      }
    }
    return replayed
  }

  // Boot: replay any leftover entries from previous run
  replay().then(n => {
    if (n > 0) console.error(`[write-queue] replayed ${n} pending entries on startup`)
  }).catch(err => console.error(`[write-queue] replay startup error: ${err}`))

  // Consumer thread
  consumerTimer = setInterval(() => {
    if (stopped) return
    drain().catch(err => console.error(`[write-queue] drain error: ${err}`))
  }, cfg.drainIntervalMs)
  // Don't keep event loop alive just for this timer
  if (typeof consumerTimer.unref === 'function') consumerTimer.unref()

  async function stop(): Promise<void> {
    stopped = true
    if (consumerTimer) clearInterval(consumerTimer)
    // Final flush attempt
    let safetyCount = 100
    while (depth > 0 && safetyCount-- > 0) {
      await drain()
    }
  }

  return { enqueue, cacheGet, depth: () => depth, drain, stop, replay }
}
