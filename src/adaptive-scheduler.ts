/**
 * Tanren — Adaptive Scheduler (D+C+E)
 *
 * D (Default):  Events queue, processed at next scheduled tick
 * E (Elastic):  Medium-priority pending → shorten interval, auto-restore when empty
 * C (Critical): High-priority event → immediate tick (via urgent trigger)
 *
 * Wake budget caps reactive ticks per hour to prevent runaway.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventTrigger, TriggerEvent } from './types.js'

export interface AdaptiveSchedulerConfig {
  queueDir: string
  baseInterval: number
  reactiveInterval?: number
  wakeBudgetPerHour?: number
  cooldown?: number
}

export interface AdaptiveScheduler {
  trigger: EventTrigger
  getNextInterval(): number
  recordWake(): boolean
  reset(): void
  stats(): { wakesThisHour: number; budgetRemaining: number; queuePending: number }
}

export function createAdaptiveScheduler(opts: AdaptiveSchedulerConfig): AdaptiveScheduler {
  const reactiveInterval = opts.reactiveInterval ?? 30_000
  const budgetPerHour = opts.wakeBudgetPerHour ?? 30
  const cooldown = opts.cooldown ?? 10_000
  const wakeTimestamps: number[] = []

  function listPending(): string[] {
    const dir = join(opts.queueDir, 'pending')
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    } catch { return [] }
  }

  function peekHighPriority(): boolean {
    const dir = join(opts.queueDir, 'pending')
    for (const file of listPending()) {
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
        if (data.priority_hint === 'high') return true
      } catch { /* skip unreadable */ }
    }
    return false
  }

  function pruneOldWakes(): void {
    const cutoff = Date.now() - 3_600_000
    while (wakeTimestamps.length > 0 && wakeTimestamps[0] < cutoff) {
      wakeTimestamps.shift()
    }
  }

  const trigger: EventTrigger = {
    name: 'event-queue',
    description: 'Monitors file-based event queue for pending events',
    priority: 'normal',
    cooldown,
    async detect(): Promise<TriggerEvent | null> {
      const files = listPending()
      if (files.length === 0) return null

      const hasHigh = peekHighPriority()
      return {
        type: 'queue.event',
        source: 'event-queue',
        data: { count: files.length, hasHighPriority: hasHigh },
        timestamp: Date.now(),
        priority: hasHigh ? 'urgent' : 'normal',
      }
    },
  }

  return {
    trigger,

    getNextInterval(): number {
      return listPending().length === 0
        ? opts.baseInterval
        : reactiveInterval
    },

    recordWake(): boolean {
      pruneOldWakes()
      if (wakeTimestamps.length >= budgetPerHour) return false
      wakeTimestamps.push(Date.now())
      return true
    },

    reset(): void { wakeTimestamps.length = 0 },

    stats() {
      pruneOldWakes()
      return {
        wakesThisHour: wakeTimestamps.length,
        budgetRemaining: Math.max(0, budgetPerHour - wakeTimestamps.length),
        queuePending: listPending().length,
      }
    },
  }
}
