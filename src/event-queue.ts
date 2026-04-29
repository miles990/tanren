/**
 * Tanren — Event Queue
 *
 * File-based priority event queue with atomic operations.
 * Designed for tick-based agents: events accumulate between ticks,
 * processed in priority order during ticks.
 *
 * Lifecycle: pending/ → processing/ → processed/ (or dead-letter/)
 * Concurrency: atomic rename for claim, .tmp write for safety.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

// === Types ===

export type EventPriority = 'low' | 'medium' | 'high'

export interface AgentEvent {
  source: string
  event: string
  priority_hint: EventPriority
  payload: Record<string, unknown>
  version: number
  timestamp: string
  mentions?: string[]
}

export interface QueuedEvent extends AgentEvent {
  id: string
  attempt: number
  enqueuedAt: string
}

export interface QueueStats {
  pending: number
  processing: number
  dropped: number
  backpressure: 'normal' | 'warning' | 'critical'
}

export interface EventQueue {
  enqueue(event: AgentEvent): string
  claim(maxCount: number): QueuedEvent[]
  complete(id: string): void
  fail(id: string, error: string): void
  recover(): number
  stats(): QueueStats
}

// === Billing & Quota ===

export type BillingType = 'free' | 'pro' | 'max' | 'api'

export interface QuotaPolicy {
  type: 'unlimited' | 'daily_cap' | 'token_budget' | 'rate_limited'
  dailyCap?: number
  tokenBudget?: number
  rateLimit?: { rpm: number }
}

export interface BillingProfile {
  name: BillingType
  localFirstThreshold: number
  wakeBudgetPerHour: number
  providers: Array<{
    provider: string
    quota: QuotaPolicy
    models: string[]
  }>
}

export const BILLING_PROFILES: Record<BillingType, BillingProfile> = {
  free: {
    name: 'free',
    localFirstThreshold: 0.9,
    wakeBudgetPerHour: 5,
    providers: [{ provider: 'local', quota: { type: 'unlimited' }, models: ['qwen-4b'] }],
  },
  pro: {
    name: 'pro',
    localFirstThreshold: 0.5,
    wakeBudgetPerHour: 15,
    providers: [
      { provider: 'local', quota: { type: 'unlimited' }, models: ['qwen-4b'] },
      { provider: 'anthropic', quota: { type: 'daily_cap', dailyCap: 50 }, models: ['sonnet'] },
    ],
  },
  max: {
    name: 'max',
    localFirstThreshold: 0.1,
    wakeBudgetPerHour: 60,
    providers: [
      { provider: 'local', quota: { type: 'unlimited' }, models: ['qwen-4b'] },
      { provider: 'anthropic', quota: { type: 'daily_cap', dailyCap: 500 }, models: ['opus', 'sonnet', 'haiku'] },
    ],
  },
  api: {
    name: 'api',
    localFirstThreshold: 0,
    wakeBudgetPerHour: 30,
    providers: [
      { provider: 'local', quota: { type: 'unlimited' }, models: ['qwen-4b'] },
      { provider: 'anthropic', quota: { type: 'token_budget', tokenBudget: 10_000_000 }, models: ['opus', 'sonnet', 'haiku'] },
    ],
  },
}

// === Implementation ===

const MAX_RETRY = 3
const BACKPRESSURE_WARNING = 50
const BACKPRESSURE_CRITICAL = 100
const PRIORITY_ORDER: Record<EventPriority, number> = { high: 0, medium: 1, low: 2 }

let counter = 0

export function createEventQueue(baseDir: string): EventQueue {
  const dirs = {
    pending: join(baseDir, 'pending'),
    processing: join(baseDir, 'processing'),
    processed: join(baseDir, 'processed'),
    deadLetter: join(baseDir, 'dead-letter'),
  }

  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function generateFilename(source: string): string {
    const c = String(++counter).padStart(6, '0')
    const ts = Date.now()
    const rand = randomBytes(2).toString('hex')
    const safeSrc = source.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 20)
    return `${c}-${ts}-${rand}-${safeSrc}.json`
  }

  function readEvent(filePath: string): QueuedEvent | null {
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch { return null }
  }

  function listDir(dir: string): string[] {
    try {
      return readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    } catch { return [] }
  }

  return {
    enqueue(event: AgentEvent): string {
      const id = generateFilename(event.source)
      const queued: QueuedEvent = { ...event, id, attempt: 1, enqueuedAt: new Date().toISOString() }
      const tmpPath = join(dirs.pending, `.${id}.tmp`)
      const finalPath = join(dirs.pending, id)
      writeFileSync(tmpPath, JSON.stringify(queued, null, 2), 'utf-8')
      renameSync(tmpPath, finalPath)
      return id
    },

    claim(maxCount: number): QueuedEvent[] {
      const files = listDir(dirs.pending)
      const events: QueuedEvent[] = []

      for (const file of files) {
        const evt = readEvent(join(dirs.pending, file))
        if (evt) events.push(evt)
      }

      events.sort((a, b) => PRIORITY_ORDER[a.priority_hint] - PRIORITY_ORDER[b.priority_hint])
      const claimed: QueuedEvent[] = []

      for (const evt of events.slice(0, maxCount)) {
        try {
          renameSync(join(dirs.pending, evt.id), join(dirs.processing, evt.id))
          claimed.push(evt)
        } catch { /* already claimed by another tick */ }
      }

      return claimed
    },

    complete(id: string): void {
      const src = join(dirs.processing, id)
      if (!existsSync(src)) return
      const dateDir = join(dirs.processed, new Date().toISOString().slice(0, 10))
      if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true })
      renameSync(src, join(dateDir, id))
    },

    fail(id: string, error: string): void {
      const src = join(dirs.processing, id)
      if (!existsSync(src)) return
      const evt = readEvent(src)
      if (!evt) { unlinkSync(src); return }

      if (evt.attempt >= MAX_RETRY) {
        const deadPath = join(dirs.deadLetter, id)
        const withError = { ...evt, lastError: error, failedAt: new Date().toISOString() }
        writeFileSync(deadPath, JSON.stringify(withError, null, 2), 'utf-8')
        unlinkSync(src)
        return
      }

      const retried: QueuedEvent = { ...evt, attempt: evt.attempt + 1 }
      const newId = generateFilename(evt.source)
      retried.id = newId
      const tmpPath = join(dirs.pending, `.${newId}.tmp`)
      writeFileSync(tmpPath, JSON.stringify(retried, null, 2), 'utf-8')
      renameSync(tmpPath, join(dirs.pending, newId))
      unlinkSync(src)
    },

    recover(): number {
      const stale = listDir(dirs.processing)
      let recovered = 0
      for (const file of stale) {
        try {
          renameSync(join(dirs.processing, file), join(dirs.pending, file))
          recovered++
        } catch { /* ignore */ }
      }
      return recovered
    },

    stats(): QueueStats {
      const pending = listDir(dirs.pending).length
      const processing = listDir(dirs.processing).length
      const dropped = listDir(dirs.deadLetter).length
      const backpressure: QueueStats['backpressure'] =
        pending >= BACKPRESSURE_CRITICAL ? 'critical' :
        pending >= BACKPRESSURE_WARNING ? 'warning' : 'normal'
      return { pending, processing, dropped, backpressure }
    },
  }
}
