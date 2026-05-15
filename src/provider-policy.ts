/**
 * Tanren — Provider Policy
 *
 * Deterministic guard around cloud-capable provider use. Usage ledger tells you
 * what happened; policy decides whether a call should be allowed before it
 * happens.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderKey, ProviderSelection } from './provider-registry.js'
import type {
  ConversationMessage,
  LLMProvider,
  Prompt,
  SessionAwareLLMProvider,
  StreamChunk,
  ToolDefinition,
  ToolUseLLMProvider,
} from './types.js'

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

export interface PolicyEvent {
  timestamp: string
  domain: 'llm' | 'artifact'
  provider: string
  allowed: boolean
  reason: string
  autonomous?: boolean
  risk?: TaskRisk
}

export interface ProviderPolicyGuardOptions {
  selection: Pick<ProviderSelection, 'providerKey' | 'cloud'>
  policy?: ProviderPolicy
  stateDir?: string
  autonomous?: boolean
  risk?: TaskRisk
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

export function wrapProviderWithPolicy(provider: LLMProvider, opts: ProviderPolicyGuardOptions): LLMProvider {
  const guard = () => {
    const decision = decideProviderUse(opts.selection, {
      policy: opts.policy,
      autonomous: opts.autonomous,
      stateDir: opts.stateDir,
      risk: opts.risk,
    })
    if (!decision.allowed) {
      writePolicyEvent(opts.stateDir, {
        domain: 'llm',
        provider: opts.selection.providerKey,
        allowed: false,
        reason: decision.reason,
        autonomous: opts.autonomous,
        risk: opts.risk,
      })
      throw new Error(`LLM provider blocked by policy: ${decision.reason}`)
    }
  }

  const wrapped: LLMProvider = {
    capabilities: provider.capabilities,
    async think(context: string, systemPrompt: string) {
      guard()
      return provider.think(context, systemPrompt)
    },
  }

  if (provider.thinkStructured) {
    wrapped.thinkStructured = async (prompt: Prompt, systemPrompt: string) => {
      guard()
      return provider.thinkStructured!(prompt, systemPrompt)
    }
  }

  if (provider.thinkStream) {
    wrapped.thinkStream = async function* (prompt: Prompt, systemPrompt: string): AsyncIterable<StreamChunk> {
      guard()
      yield* provider.thinkStream!(prompt, systemPrompt)
    }
  }

  if ('thinkWithTools' in provider) {
    const toolUseProvider = wrapped as ToolUseLLMProvider
    toolUseProvider.thinkWithTools = async (
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ) => {
      guard()
      return (provider as ToolUseLLMProvider).thinkWithTools(messages, systemPrompt, tools)
    }
  }

  if ('skipFeedbackLoop' in provider) {
    Object.defineProperty(wrapped, 'skipFeedbackLoop', { value: (provider as SessionAwareLLMProvider).skipFeedbackLoop })
  }

  if ('getSessionId' in provider && 'setResumeSession' in provider) {
    const sessionProvider = provider as SessionAwareLLMProvider
    const wrappedSessionProvider = wrapped as SessionAwareLLMProvider
    wrappedSessionProvider.getSessionId = () => sessionProvider.getSessionId()
    wrappedSessionProvider.setResumeSession = (id: string | null) => {
      sessionProvider.setResumeSession(id)
    }
  }

  return wrapped
}

export function writePolicyEvent(stateDir: string | undefined, event: Omit<PolicyEvent, 'timestamp'>): void {
  if (!stateDir) return
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(
      join(stateDir, 'policy-events.jsonl'),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      'utf-8',
    )
  } catch {
    // Policy logs are diagnostic only; enforcement must not depend on disk writes.
  }
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
