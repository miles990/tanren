import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { serve } from './serve.js'
import type { TanrenAgent } from './index.js'
import { FileArtifactJobStore, FileArtifactStore, type ArtifactProvider } from './artifact-io.js'

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

  it('submits artifact jobs and streams artifact events', async () => {
    const agent = createFakeAgent()
    const provider: ArtifactProvider = {
      name: 'fake-artifacts',
      capabilities: { kinds: ['image'], streaming: true, input: { image: true, audio: false, video: false, file: true }, output: { base64: false, file: true, url: true } },
      async submit(request) {
        return {
          id: 'job-1',
          provider: 'fake-artifacts',
          status: 'completed',
          request,
          artifacts: [{ id: 'artifact-1', uri: '/tmp/a.png', kind: 'image', mediaType: 'image/png' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
      async get(jobId) {
        return {
          id: jobId,
          provider: 'fake-artifacts',
          status: 'completed',
          request: { type: 'image', prompt: 'x' },
          artifacts: [{ id: 'artifact-1', uri: '/tmp/a.png', kind: 'image', mediaType: 'image/png' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
    }
    const handle = serve(agent, {
      port: 0,
      serviceName: 'test-agent',
      artifacts: {
        enabled: true,
        defaultProvider: 'fake-artifacts',
        providers: { 'fake-artifacts': provider },
        store: new FileArtifactStore('/tmp/tanren-test-artifacts'),
        jobStore: new FileArtifactJobStore('/tmp/tanren-test-artifacts'),
      },
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port

      const response = await fetch(`http://127.0.0.1:${port}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'image', prompt: 'draw', refs: ['/tmp/source.png'] }),
      })
      const job = await response.json() as { status: string; artifacts: Array<{ uri: string }>; request: { inputs?: Array<{ type: string }> } }
      assert.equal(response.status, 200)
      assert.equal(job.status, 'completed')
      assert.equal(job.request.inputs?.[0]?.type, 'ref')

      const streamResponse = await fetch(`http://127.0.0.1:${port}/artifacts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'image', prompt: 'draw' }),
      })
      const streamText = await streamResponse.text()
      assert.match(streamText, /event: job\.submitted/)
      assert.match(streamText, /event: artifact\.completed/)
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
