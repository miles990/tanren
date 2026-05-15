import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { serve } from './serve.js'
import type { TanrenAgent } from './index.js'

describe('serve', () => {
  it('exposes declared capabilities on /health', async () => {
    const agent = createFakeAgent()
    const capabilities = {
      llm: { provider: 'fake', providerKey: 'local', cloud: false },
      artifacts: { enabled: false, providers: [] },
    }
    const handle = serve(agent, {
      port: 0,
      serviceName: 'test-agent',
      capabilities,
      health: () => ({ mode: 'test' }),
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.equal(typeof address, 'object')
      assert.ok(address)

      const port = (address as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      const health = await response.json() as {
        status: string
        agent: { mode: string }
        capabilities: typeof capabilities
      }

      assert.equal(response.status, 200)
      assert.equal(health.status, 'ok')
      assert.equal(health.agent.mode, 'test')
      assert.equal(health.capabilities.llm.provider, 'fake')
      assert.equal(health.capabilities.artifacts.enabled, false)
    } finally {
      handle.server.closeAllConnections()
      await new Promise<void>(resolve => handle.server.close(() => resolve()))
    }
  })
})

function createFakeAgent(): TanrenAgent {
  let sessionId: string | null = null
  return {
    async tick() { throw new Error('not used') },
    async chat() { throw new Error('not used') },
    async runChain() { throw new Error('not used') },
    start() {},
    stop() {},
    isRunning() { return false },
    getRecentTicks() { return [] },
    setSessionId(id) { sessionId = id },
    getSessionId() { return sessionId },
  }
}
