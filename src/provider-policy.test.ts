import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideProviderUse } from './provider-policy.js'

describe('ProviderPolicy', () => {
  it('allows local providers when cloud is disabled', () => {
    const decision = decideProviderUse(
      { providerKey: 'omlx', cloud: false },
      { policy: { allowCloud: false }, autonomous: true },
    )
    assert.equal(decision.allowed, true)
  })

  it('blocks cloud providers when cloud is disabled', () => {
    const decision = decideProviderUse(
      { providerKey: 'codex', cloud: true },
      { policy: { allowCloud: false } },
    )
    assert.equal(decision.allowed, false)
  })

  it('blocks autonomous cloud when not explicitly allowed', () => {
    const decision = decideProviderUse(
      { providerKey: 'agent-sdk', cloud: true },
      { policy: { allowAutonomousCloud: false }, autonomous: true },
    )
    assert.equal(decision.allowed, false)
  })
})
