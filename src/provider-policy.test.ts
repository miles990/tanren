import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideProviderUse, wrapProviderWithPolicy } from './provider-policy.js'

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

  it('guards provider calls before cloud tokens are spent', async () => {
    const provider = wrapProviderWithPolicy({
      async think() {
        throw new Error('provider should not be called')
      },
    }, {
      selection: { providerKey: 'agent-sdk', cloud: true },
      policy: { allowCloud: false },
    })

    await assert.rejects(
      () => provider.think('context', 'system'),
      /cloud providers disabled by policy/,
    )
  })

  it('writes blocked provider attempts to the policy event ledger', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
    try {
      const provider = wrapProviderWithPolicy({
        async think() {
          throw new Error('provider should not be called')
        },
      }, {
        selection: { providerKey: 'codex', cloud: true },
        policy: { allowCloud: false },
        stateDir,
      })

      await assert.rejects(() => provider.think('context', 'system'))
      const ledger = join(stateDir, 'policy-events.jsonl')
      assert.equal(existsSync(ledger), true)
      assert.match(readFileSync(ledger, 'utf-8'), /"domain":"llm"/)
      assert.match(readFileSync(ledger, 'utf-8'), /"provider":"codex"/)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
