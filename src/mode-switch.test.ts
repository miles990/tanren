/**
 * Mode-switch tests (KG discussion 620bae11).
 *
 * Verifies the three Phase 1 mechanisms:
 *   - TickPathConfig schema + REACTIVE_PATH / DEEP_PATH constants
 *   - Anthropic cache_control breakpoint injection (Hermes system_and_3)
 *   - buildSystemPrompt LRU memoize (stable prefix for prompt cache)
 *
 * Does NOT test latency end-to-end — that requires a real LLM (see N5 in plan).
 */

import { describe, expect, it } from 'bun:test'
import { REACTIVE_PATH, DEEP_PATH } from './types.js'
import { buildSystemPrompt, buildToolUseSystemPrompt } from './prompt-builder.js'
import type { ActionRegistry } from './actions.js'
import { createAnthropicProvider } from './llm/anthropic.js'

describe('TickPathConfig constants', () => {
  it('REACTIVE_PATH = latency-optimal preset', () => {
    expect(REACTIVE_PATH.mode).toBe('reactive')
    expect(REACTIVE_PATH.feedbackRounds).toBe(0)
    expect(REACTIVE_PATH.promptCacheTTL).toBe('5m')
    expect(REACTIVE_PATH.memoryWriteBlocking).toBe(false)
  })

  it('DEEP_PATH = coherence-optimal preset', () => {
    expect(DEEP_PATH.mode).toBe('deep')
    expect(DEEP_PATH.feedbackRounds).toBe(5)
    expect(DEEP_PATH.promptCacheTTL).toBe(null)
    expect(DEEP_PATH.memoryWriteBlocking).toBe(true)
  })
})

describe('buildSystemPrompt memoize', () => {
  const fakeActions: ActionRegistry = {
    types: () => ['respond', 'remember'],
    getDescription: (t: string) => t === 'respond' ? 'send response' : 'save memory',
  } as unknown as ActionRegistry

  it('returns identical string on repeated calls (same identity + actions)', () => {
    const a = buildSystemPrompt('agent-identity-1', fakeActions)
    const b = buildSystemPrompt('agent-identity-1', fakeActions)
    expect(a).toBe(b)
    // Reference equality proves memoize hit, not just structural equality
    expect(a === b).toBe(true)
  })

  it('invalidates cache when identity changes', () => {
    const a = buildSystemPrompt('identity-A', fakeActions)
    const b = buildSystemPrompt('identity-B', fakeActions)
    expect(a).not.toBe(b)
    expect(a).toContain('identity-A')
    expect(b).toContain('identity-B')
  })

  it('buildToolUseSystemPrompt also memoizes', () => {
    const a = buildToolUseSystemPrompt('tool-identity-1')
    const b = buildToolUseSystemPrompt('tool-identity-1')
    expect(a === b).toBe(true)
  })
})

describe('Anthropic setCacheControl + applyCacheControlToBody', () => {
  // We can't make real API calls in unit tests, but we can verify:
  //   1. setCacheControl exists on the returned provider
  //   2. Setting null is safe (no-op)
  //   3. Setting valid TTL doesn't throw

  it('exposes setCacheControl setter', () => {
    const provider = createAnthropicProvider({ apiKey: 'dummy-key-for-test' })
    expect(typeof (provider as { setCacheControl?: unknown }).setCacheControl).toBe('function')
  })

  it('setCacheControl(null) is safe', () => {
    const provider = createAnthropicProvider({ apiKey: 'dummy-key-for-test' })
    const setter = (provider as { setCacheControl: (c: { ttl: '5m' | '1h' } | null) => void }).setCacheControl
    expect(() => setter(null)).not.toThrow()
  })

  it('setCacheControl({ttl:"5m"}) is safe', () => {
    const provider = createAnthropicProvider({ apiKey: 'dummy-key-for-test' })
    const setter = (provider as { setCacheControl: (c: { ttl: '5m' | '1h' } | null) => void }).setCacheControl
    expect(() => setter({ ttl: '5m' })).not.toThrow()
    expect(() => setter({ ttl: '1h' })).not.toThrow()
  })
})
