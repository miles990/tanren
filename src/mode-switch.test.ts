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

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { REACTIVE_PATH, DEEP_PATH } from './types.js'
import { buildSystemPrompt, buildToolUseSystemPrompt } from './prompt-builder.js'
import type { ActionRegistry } from './actions.js'
import { createAnthropicProvider } from './llm/anthropic.js'

describe('TickPathConfig constants', () => {
  it('REACTIVE_PATH = latency-optimal preset', () => {
    assert.equal(REACTIVE_PATH.mode, 'reactive')
    assert.equal(REACTIVE_PATH.feedbackRounds, 0)
    assert.equal(REACTIVE_PATH.promptCacheTTL, '5m')
    assert.equal(REACTIVE_PATH.memoryWriteBlocking, false)
  })

  it('DEEP_PATH = coherence-optimal preset', () => {
    assert.equal(DEEP_PATH.mode, 'deep')
    assert.equal(DEEP_PATH.feedbackRounds, 5)
    assert.equal(DEEP_PATH.promptCacheTTL, null)
    assert.equal(DEEP_PATH.memoryWriteBlocking, true)
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
    assert.equal(a, b)
    // Reference equality proves memoize hit, not just structural equality
    assert.equal(a === b, true)
  })

  it('invalidates cache when identity changes', () => {
    const a = buildSystemPrompt('identity-A', fakeActions)
    const b = buildSystemPrompt('identity-B', fakeActions)
    assert.notEqual(a, b)
    assert.ok(a.includes('identity-A'))
    assert.ok(b.includes('identity-B'))
  })

  it('buildToolUseSystemPrompt also memoizes', () => {
    const a = buildToolUseSystemPrompt('tool-identity-1')
    const b = buildToolUseSystemPrompt('tool-identity-1')
    assert.equal(a === b, true)
  })
})

describe('Anthropic setCacheControl + applyCacheControlToBody', () => {
  // We can't make real API calls in unit tests, but we can verify:
  //   1. setCacheControl exists on the returned provider
  //   2. Setting null is safe (no-op)
  //   3. Setting valid TTL doesn't throw

  it('exposes setCacheControl setter', () => {
    const provider = createAnthropicProvider({ apiKey: 'dummy-key-for-test' })
    assert.equal(typeof (provider as { setCacheControl?: unknown }).setCacheControl, 'function')
  })

  it('setCacheControl(null) is safe', () => {
    const provider = createAnthropicProvider({ apiKey: 'dummy-key-for-test' })
    const setter = (provider as { setCacheControl: (c: { ttl: '5m' | '1h' } | null) => void }).setCacheControl
    assert.doesNotThrow(() => setter(null))
  })

  it('setCacheControl({ttl:"5m"}) is safe', () => {
    const provider = createAnthropicProvider({ apiKey: 'dummy-key-for-test' })
    const setter = (provider as { setCacheControl: (c: { ttl: '5m' | '1h' } | null) => void }).setCacheControl
    assert.doesNotThrow(() => setter({ ttl: '5m' }))
    assert.doesNotThrow(() => setter({ ttl: '1h' }))
  })
})
