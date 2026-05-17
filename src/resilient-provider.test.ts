import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProviderHealthState, createResilientProvider, isTransientProviderError } from './resilient-provider.js'
import type { LLMProvider, ToolUseLLMProvider } from './types.js'

describe('createResilientProvider', () => {
  it('classifies Claude Agent SDK budget exits as recoverable provider failures', () => {
    assert.equal(isTransientProviderError(new Error('Claude Code process aborted by user')), true)
    assert.equal(isTransientProviderError(new Error('Reached maximum number of turns (20)')), true)
    assert.equal(isTransientProviderError(new Error('Tool call limit reached (40)')), true)
  })

  it('retries transient provider failures before returning success', async () => {
    let calls = 0
    const primary: LLMProvider = {
      async think() {
        calls++
        if (calls === 1) throw new Error('API Error: 500 Internal server error')
        return 'ok'
      },
    }
    const state = createProviderHealthState('primary')
    const provider = createResilientProvider({
      chain: [{ name: 'primary', provider: primary }],
      retryAttempts: 2,
      retryDelayMs: 0,
      state,
    })

    assert.equal(await provider.think('hello', 'system'), 'ok')
    assert.equal(calls, 2)
    assert.equal(state.lastError?.provider, 'primary')
    assert.equal(state.lastSuccess?.provider, 'primary')
    assert.equal(state.degraded, false)
  })

  it('falls back across tool-use providers and records degraded health', async () => {
    const primary: ToolUseLLMProvider = {
      async think() { throw new Error('not used') },
      async thinkWithTools() { throw new Error('API Error: 500 Internal server error') },
    }
    const secondary: ToolUseLLMProvider = {
      async think() { return 'fallback text' },
      async thinkWithTools() {
        return {
          content: [{ type: 'text', text: 'fallback ok' }],
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: 'end_turn',
        }
      },
    }
    const state = createProviderHealthState('primary')
    const fallbacks: string[] = []
    const provider = createResilientProvider({
      chain: [{ name: 'primary', provider: primary }, { name: 'secondary', provider: secondary }],
      retryAttempts: 1,
      retryDelayMs: 0,
      state,
      onFallback: (failed, next) => fallbacks.push(`${failed}->${next}`),
    }) as ToolUseLLMProvider

    const result = await provider.thinkWithTools([{ role: 'user', content: 'hi' }], 'system', [])
    assert.equal(result.content[0]?.type, 'text')
    assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : '', 'fallback ok')
    assert.deepEqual(fallbacks, ['primary->secondary'])
    assert.equal(state.degraded, true)
    assert.equal(state.activeProvider, 'secondary')
  })

  it('falls back when a stream yields an error chunk', async () => {
    const primary: LLMProvider = {
      async think() { throw new Error('not used') },
      async *thinkStream() {
        yield { type: 'error', error: 'API Error: 500 Internal server error' }
      },
    }
    const secondary: LLMProvider = {
      async think() { return 'fallback stream' },
    }
    const provider = createResilientProvider({
      chain: [{ name: 'primary', provider: primary }, { name: 'secondary', provider: secondary }],
      retryAttempts: 1,
      retryDelayMs: 0,
    })

    const chunks = []
    for await (const chunk of provider.thinkStream!('hi', 'system')) chunks.push(chunk)
    assert.deepEqual(chunks.map(chunk => chunk.type), ['text_delta', 'done'])
    assert.equal(chunks[0].type === 'text_delta' ? chunks[0].text : '', 'fallback stream')
  })
})
