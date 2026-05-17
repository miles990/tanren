import type { AgentSdkOptions } from './llm/agent-sdk.js'
import { readScopedEnv } from './provider-registry.js'

export type RuntimeTaskProfileName =
  | 'default'
  | 'autonomous'
  | 'quick-review'
  | 'deep-review'
  | 'implementation-review'
  | (string & {})

export interface RuntimeTaskProfile {
  name: RuntimeTaskProfileName
  description: string
  agentSdk?: Partial<AgentSdkOptions>
  providerRetryAttempts?: number
  providerRetryDelayMs?: number
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
const IMPLEMENTATION_REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']

export const BUILTIN_RUNTIME_TASK_PROFILES: Record<string, RuntimeTaskProfile> = {
  default: {
    name: 'default',
    description: 'Preserve provider defaults for compatibility.',
  },
  autonomous: {
    name: 'autonomous',
    description: 'Small bounded budget for recurring autonomous ticks.',
    agentSdk: {
      timeoutMs: 180_000,
      maxTurns: 8,
      maxToolCalls: 12,
      allowedTools: READ_ONLY_TOOLS,
    },
    providerRetryAttempts: 1,
    providerRetryDelayMs: 250,
  },
  'quick-review': {
    name: 'quick-review',
    description: 'Fast read-only review where stale answers are worse than incomplete answers.',
    agentSdk: {
      timeoutMs: 300_000,
      maxTurns: 12,
      maxToolCalls: 24,
      allowedTools: READ_ONLY_TOOLS,
    },
    providerRetryAttempts: 1,
    providerRetryDelayMs: 250,
  },
  'deep-review': {
    name: 'deep-review',
    description: 'Long read-only review for architecture, plans, and cross-repo analysis.',
    agentSdk: {
      timeoutMs: 900_000,
      maxTurns: 48,
      maxToolCalls: 96,
      allowedTools: READ_ONLY_TOOLS,
    },
    providerRetryAttempts: 1,
    providerRetryDelayMs: 500,
  },
  'implementation-review': {
    name: 'implementation-review',
    description: 'Review completed implementation with shell verification allowed but no edits.',
    agentSdk: {
      timeoutMs: 900_000,
      maxTurns: 36,
      maxToolCalls: 72,
      allowedTools: IMPLEMENTATION_REVIEW_TOOLS,
    },
    providerRetryAttempts: 1,
    providerRetryDelayMs: 500,
  },
}

export function readRuntimeTaskProfileName(
  env: NodeJS.ProcessEnv,
  serviceEnvPrefix?: string,
): RuntimeTaskProfileName | undefined {
  return readScopedEnv(env, 'TASK_PROFILE', serviceEnvPrefix) as RuntimeTaskProfileName | undefined
}

export function resolveRuntimeTaskProfile(
  profile?: RuntimeTaskProfileName | RuntimeTaskProfile,
): RuntimeTaskProfile {
  if (!profile) return cloneProfile(BUILTIN_RUNTIME_TASK_PROFILES.default)
  if (typeof profile !== 'string') return mergeTaskProfile(BUILTIN_RUNTIME_TASK_PROFILES.default, profile)
  const builtin = BUILTIN_RUNTIME_TASK_PROFILES[profile]
  if (builtin) return cloneProfile(builtin)
  return {
    ...cloneProfile(BUILTIN_RUNTIME_TASK_PROFILES.default),
    name: profile,
    description: `Custom task profile "${profile}" using provider defaults.`,
  }
}

export function mergeTaskProfile(
  base: RuntimeTaskProfile,
  override: RuntimeTaskProfile,
): RuntimeTaskProfile {
  return {
    ...cloneProfile(base),
    ...override,
    agentSdk: {
      ...(base.agentSdk ?? {}),
      ...(override.agentSdk ?? {}),
    },
  }
}

function cloneProfile(profile: RuntimeTaskProfile): RuntimeTaskProfile {
  return {
    ...profile,
    agentSdk: profile.agentSdk ? { ...profile.agentSdk } : undefined,
  }
}
