/**
 * Tanren — Quota Manager
 *
 * Tracks per-provider usage against BillingProfile limits.
 * Exposes canUse() signal for routing decisions.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BillingProfile, BillingType, QuotaPolicy } from './event-queue.js'
import { BILLING_PROFILES } from './event-queue.js'

export interface ProviderUsage {
  provider: string
  callsToday: number
  tokensToday: number
  lastCallAt: string
  date: string
}

export interface QuotaManagerOptions {
  stateDir: string
  billing: BillingType
}

export interface QuotaManager {
  canUse(provider: string): boolean
  consume(provider: string, tokens?: number): void
  remaining(provider: string): number | null
  profile(): BillingProfile
  stats(): Record<string, ProviderUsage>
}

export function createQuotaManager(opts: QuotaManagerOptions): QuotaManager {
  const bp = BILLING_PROFILES[opts.billing]
  const statePath = join(opts.stateDir, 'quota-usage.json')
  const today = () => new Date().toISOString().slice(0, 10)

  function loadUsage(): Record<string, ProviderUsage> {
    if (!existsSync(statePath)) return {}
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'))
      const d = today()
      for (const key of Object.keys(data)) {
        if (data[key].date !== d) {
          data[key] = { provider: key, callsToday: 0, tokensToday: 0, lastCallAt: '', date: d }
        }
      }
      return data
    } catch { return {} }
  }

  function saveUsage(usage: Record<string, ProviderUsage>): void {
    try { writeFileSync(statePath, JSON.stringify(usage, null, 2), 'utf-8') } catch { /* best effort */ }
  }

  function getQuota(provider: string): QuotaPolicy | undefined {
    return bp.providers.find(p => p.provider === provider)?.quota
  }

  return {
    canUse(provider: string): boolean {
      const quota = getQuota(provider)
      if (!quota) return false
      if (quota.type === 'unlimited') return true

      const usage = loadUsage()[provider]
      if (!usage) return true

      if (quota.type === 'daily_cap' && quota.dailyCap !== undefined) {
        return usage.callsToday < quota.dailyCap
      }
      if (quota.type === 'token_budget' && quota.tokenBudget !== undefined) {
        return usage.tokensToday < quota.tokenBudget
      }
      if (quota.type === 'rate_limited' && quota.rateLimit) {
        const now = Date.now()
        const lastCall = usage.lastCallAt ? new Date(usage.lastCallAt).getTime() : 0
        const minGap = 60_000 / quota.rateLimit.rpm
        return (now - lastCall) >= minGap
      }
      return true
    },

    consume(provider: string, tokens = 0): void {
      const usage = loadUsage()
      const d = today()
      if (!usage[provider] || usage[provider].date !== d) {
        usage[provider] = { provider, callsToday: 0, tokensToday: 0, lastCallAt: '', date: d }
      }
      usage[provider].callsToday++
      usage[provider].tokensToday += tokens
      usage[provider].lastCallAt = new Date().toISOString()
      saveUsage(usage)
    },

    remaining(provider: string): number | null {
      const quota = getQuota(provider)
      if (!quota || quota.type === 'unlimited') return null

      const usage = loadUsage()[provider]
      if (!usage) {
        if (quota.type === 'daily_cap') return quota.dailyCap ?? null
        if (quota.type === 'token_budget') return quota.tokenBudget ?? null
        return null
      }

      if (quota.type === 'daily_cap' && quota.dailyCap !== undefined) {
        return Math.max(0, quota.dailyCap - usage.callsToday)
      }
      if (quota.type === 'token_budget' && quota.tokenBudget !== undefined) {
        return Math.max(0, quota.tokenBudget - usage.tokensToday)
      }
      return null
    },

    profile: () => bp,
    stats: () => loadUsage(),
  }
}
