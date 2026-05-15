/**
 * Tanren — Provider Policy
 *
 * Deterministic guard around cloud-capable provider use. Usage ledger tells you
 * what happened; policy decides whether a call should be allowed before it
 * happens.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderKey, ProviderSelection } from './provider-registry.js'

export type TaskRisk = 'safe' | 'moderate' | 'dangerous'

export interface ProviderPolicy {
  allowCloud?: boolean
  allowAutonomousCloud?: boolean
  dailyCloudCallCap?: number
  cloudProviders?: ProviderKey[]
}

export interface ProviderPolicyDecision {
  allowed: boolean
  reason: string
}

export function decideProviderUse(
  selection: Pick<ProviderSelection, 'providerKey' | 'cloud'>,
  opts: {
    policy?: ProviderPolicy
    autonomous?: boolean
    stateDir?: string
    risk?: TaskRisk
  } = {},
): ProviderPolicyDecision {
  const policy = opts.policy ?? {}
  const cloudProviders = new Set(policy.cloudProviders ?? ['agent-sdk', 'anthropic', 'anthropic-managed', 'openai', 'google', 'codex', 'claude-cli'])
  const isCloud = selection.cloud || cloudProviders.has(selection.providerKey)

  if (!isCloud) return { allowed: true, reason: 'local provider' }
  if (policy.allowCloud === false) return { allowed: false, reason: 'cloud providers disabled by policy' }
  if (opts.autonomous && policy.allowAutonomousCloud === false) return { allowed: false, reason: 'autonomous cloud use disabled by policy' }

  if (policy.dailyCloudCallCap !== undefined && opts.stateDir) {
    const calls = readTodayCloudCalls(opts.stateDir)
    if (calls >= policy.dailyCloudCallCap) {
      return { allowed: false, reason: `daily cloud call cap reached (${calls}/${policy.dailyCloudCallCap})` }
    }
  }

  if (opts.risk === 'dangerous' && opts.autonomous && policy.allowAutonomousCloud !== true) {
    return { allowed: false, reason: 'dangerous autonomous cloud task requires explicit allowAutonomousCloud=true' }
  }

  return { allowed: true, reason: 'policy allowed' }
}

function readTodayCloudCalls(stateDir: string): number {
  const path = join(stateDir, 'llm-usage-summary.json')
  if (!existsSync(path)) return 0
  try {
    const today = new Date().toISOString().slice(0, 10)
    const summary = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { date: string; cloudCalls?: number }>
    return Object.values(summary)
      .filter(row => row.date === today)
      .reduce((sum, row) => sum + (row.cloudCalls ?? 0), 0)
  } catch {
    return 0
  }
}
