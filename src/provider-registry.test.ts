import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProvider, listProviders, registerProviderFactory } from './provider-registry.js'

describe('ProviderRegistry', () => {
  it('allows external provider factories to register behind the provider seam', async () => {
    registerProviderFactory('test-provider', () => ({
      async think(context) { return `custom:${context}` },
    }), { cloud: false, description: 'test provider' })

    const provider = createProvider({ provider: 'test-provider' })
    assert.equal(await provider.think('hello', ''), 'custom:hello')
    assert.equal(listProviders().some(row => row.provider === 'test-provider'), true)
  })
})
