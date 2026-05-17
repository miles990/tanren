/**
 * Tanren — Resilient Provider
 *
 * Wraps LLM providers with bounded retries, fallback chaining, and health
 * telemetry. This belongs at the provider seam so text, structured, streaming,
 * and tool-use paths fail consistently.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promptToText } from './content-adapter.js'
import type {
  ConversationMessage,
  LLMProvider,
  Prompt,
  ProviderCapabilities,
  SessionAwareLLMProvider,
  StreamChunk,
  StructuredResponse,
  ToolDefinition,
  ToolUseLLMProvider,
  ToolUseResponse,
} from './types.js'

export interface ProviderFailure {
  provider: string
  method: ProviderMethod
  message: string
  at: string
  transient: boolean
}

export interface ProviderSuccess {
  provider: string
  method: ProviderMethod
  at: string
}

export interface ResilientProviderState {
  degraded: boolean
  primary: string
  activeProvider: string | null
  lastError?: ProviderFailure
  lastSuccess?: ProviderSuccess
  attempts: Array<ProviderFailure | ProviderSuccess>
}

export type ProviderMethod = 'think' | 'thinkStructured' | 'thinkStream' | 'thinkWithTools'

export interface ResilientProviderOptions {
  chain: Array<{ name: string; provider: LLMProvider }>
  retryAttempts?: number
  retryDelayMs?: number
  stateDir?: string
  state?: ResilientProviderState
  onFallback?: (failed: string, next: string, error: string) => void
}

const MAX_ATTEMPTS = 50

export function createProviderHealthState(primary: string): ResilientProviderState {
  return {
    degraded: false,
    primary,
    activeProvider: null,
    attempts: [],
  }
}

export function isTransientProviderError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /\b(408|409|425|429|500|502|503|504)\b/i.test(message)
    || /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timeout|temporarily unavailable|rate limit|internal server error)\b/i.test(message)
    || /\b(process aborted by user|aborted by user|reached maximum number of turns|maximum number of turns|tool call limit reached)\b/i.test(message)
}

export function createResilientProvider(opts: ResilientProviderOptions): LLMProvider {
  if (opts.chain.length === 0) throw new Error('createResilientProvider requires at least one provider')

  const state = opts.state ?? createProviderHealthState(opts.chain[0].name)
  state.primary = opts.chain[0].name

  const retryAttempts = Math.max(1, opts.retryAttempts ?? 1)
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 250)
  const primary = opts.chain[0].provider

  function record(event: ProviderFailure | ProviderSuccess): void {
    state.attempts.push(event)
    if (state.attempts.length > MAX_ATTEMPTS) state.attempts.shift()
    if ('message' in event) {
      state.lastError = event
      state.degraded = true
    } else {
      state.lastSuccess = event
      state.activeProvider = event.provider
      state.degraded = event.provider !== state.primary
    }
    if (!opts.stateDir) return
    try {
      mkdirSync(opts.stateDir, { recursive: true })
      appendFileSync(join(opts.stateDir, 'provider-events.jsonl'), JSON.stringify(event) + '\n', 'utf-8')
      writeFileSync(join(opts.stateDir, 'provider-health.json'), JSON.stringify(state, null, 2), 'utf-8')
    } catch {
      // Provider telemetry must never break the agent.
    }
  }

  async function wait(attempt: number): Promise<void> {
    if (retryDelayMs <= 0) return
    await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
  }

  async function callChain<T>(
    method: ProviderMethod,
    call: (provider: LLMProvider, name: string) => Promise<T>,
  ): Promise<T> {
    const errors: ProviderFailure[] = []

    for (let i = 0; i < opts.chain.length; i++) {
      const entry = opts.chain[i]
      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
          const result = await call(entry.provider, entry.name)
          record({ provider: entry.name, method, at: new Date().toISOString() })
          return result
        } catch (err) {
          const failure: ProviderFailure = {
            provider: entry.name,
            method,
            message: errorMessage(err),
            at: new Date().toISOString(),
            transient: isTransientProviderError(err),
          }
          errors.push(failure)
          record(failure)
          if (!failure.transient || attempt >= retryAttempts) break
          await wait(attempt)
        }
      }

      const next = opts.chain[i + 1]
      if (next) opts.onFallback?.(entry.name, next.name, errors[errors.length - 1]?.message ?? 'provider failed')
    }

    const summary = errors.map(error => `${error.provider}: ${error.message}`).join(' | ')
    throw new Error(`All providers exhausted for ${method}. ${summary}`)
  }

  const wrapped: LLMProvider & Partial<ToolUseLLMProvider> & Partial<SessionAwareLLMProvider> = {
    get capabilities(): ProviderCapabilities | undefined {
      return primary.capabilities
    },

    async think(context: string, systemPrompt: string): Promise<string> {
      return callChain('think', provider => provider.think(context, systemPrompt))
    },

    async thinkStructured(prompt: Prompt, systemPrompt: string): Promise<StructuredResponse> {
      return callChain('thinkStructured', async provider => {
        if (provider.thinkStructured) return provider.thinkStructured(prompt, systemPrompt)
        return {
          text: await provider.think(promptToText(prompt), systemPrompt),
          metadata: { degradedToText: true },
        }
      })
    },

    async *thinkStream(prompt: Prompt, systemPrompt: string): AsyncIterable<StreamChunk> {
      const chunks = await callChain('thinkStream', async provider => {
        const collected: StreamChunk[] = []
        if (provider.thinkStream) {
          for await (const chunk of provider.thinkStream(prompt, systemPrompt)) {
            if (chunk.type === 'error') throw new Error(chunk.error ?? 'Provider stream error')
            collected.push(chunk)
          }
        } else {
          const text = await provider.think(promptToText(prompt), systemPrompt)
          if (text) collected.push({ type: 'text_delta', text })
          collected.push({ type: 'done', metadata: { degradedToText: true } })
        }
        return collected
      })
      yield* chunks
    },

    async thinkWithTools(
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ): Promise<ToolUseResponse> {
      return callChain('thinkWithTools', async provider => {
        if (hasToolUse(provider)) return provider.thinkWithTools(messages, systemPrompt, tools)
        const text = await provider.think(messagesToText(messages), systemPrompt)
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
        }
      })
    },
  }

  if (isSessionAware(primary)) {
    Object.defineProperties(wrapped, {
      skipFeedbackLoop: { get: () => primary.skipFeedbackLoop },
      getSessionId: { value: () => primary.getSessionId() },
      setResumeSession: { value: (id: string | null) => primary.setResumeSession(id) },
    })
  }

  return new Proxy(wrapped, {
    has(target, prop) {
      return prop in target || prop in primary
    },
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return Reflect.get(primary as object, prop, primary)
    },
    set(target, prop, value, receiver) {
      if (prop in target) return Reflect.set(target, prop, value, receiver)
      if (prop in primary) return Reflect.set(primary as object, prop, value, primary)
      return Reflect.set(target, prop, value, receiver)
    },
  }) as LLMProvider
}

function hasToolUse(provider: LLMProvider): provider is ToolUseLLMProvider {
  return typeof (provider as Partial<ToolUseLLMProvider>).thinkWithTools === 'function'
}

function isSessionAware(provider: LLMProvider): provider is SessionAwareLLMProvider {
  return typeof (provider as Partial<SessionAwareLLMProvider>).getSessionId === 'function'
    && typeof (provider as Partial<SessionAwareLLMProvider>).setResumeSession === 'function'
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000)
}

function messagesToText(messages: ConversationMessage[]): string {
  return messages.map(message => {
    if (typeof message.content === 'string') return message.content
    return message.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n')
  }).join('\n')
}
