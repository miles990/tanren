import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { serve } from './serve.js'
import type { TanrenAgent } from './index.js'
import { FileArtifactJobStore, FileArtifactStore, type ArtifactProvider } from './artifact-io.js'
import { writePolicyEvent } from './provider-policy.js'
import { LongTaskController } from './long-task.js'
import type { ModelIO, ModelRequest, ModelRouteRequirement } from './model-io.js'

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

  it('emits a server error instead of leaving listen failures as uncaught exceptions', async () => {
    const blocker = createHttpServer((_req, res) => res.end('occupied'))
    blocker.listen(0)

    try {
      await once(blocker, 'listening')
      const address = blocker.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port

      const handle = serve(createFakeAgent(), {
        port,
        serviceName: 'test-agent',
      })
      const [err] = await once(handle.server, 'error') as [NodeJS.ErrnoException]
      assert.equal(err.code, 'EADDRINUSE')
      handle.server.closeAllConnections()
      handle.server.close()
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
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

  it('lists, serves, and cancels persisted artifact jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-serve-artifacts-'))
    const file = join(dir, 'out.txt')
    writeFileSync(file, 'artifact bytes', 'utf-8')
    const jobStore = new FileArtifactJobStore(dir)
    await jobStore.put({
      id: 'job-persisted',
      provider: 'fake-artifacts',
      status: 'completed',
      request: { type: 'file', prompt: 'x' },
      artifacts: [{ id: 'artifact-1', uri: file, kind: 'file', mediaType: 'text/plain' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const handle = serve(createFakeAgent(), {
      port: 0,
      serviceName: 'test-agent',
      artifacts: {
        enabled: false,
        providers: {},
        store: new FileArtifactStore(dir),
        jobStore,
        reason: 'disabled for test',
      },
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port

      const listResponse = await fetch(`http://127.0.0.1:${port}/artifacts`)
      const list = await listResponse.json() as { jobs: Array<{ id: string }> }
      assert.equal(list.jobs[0]?.id, 'job-persisted')

      const fileResponse = await fetch(`http://127.0.0.1:${port}/artifacts/job-persisted/file`)
      assert.equal(await fileResponse.text(), 'artifact bytes')

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/artifacts/job-persisted`, { method: 'DELETE' })
      const cancelled = await cancelResponse.json() as { status: string }
      assert.equal(cancelled.status, 'cancelled')
    } finally {
      handle.server.closeAllConnections()
      await new Promise<void>(resolve => handle.server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists policy events from the runtime state directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-policy-events-'))
    writePolicyEvent(join(dir, 'state'), {
      domain: 'llm',
      provider: 'codex',
      allowed: false,
      reason: 'blocked in test',
    })
    const handle = serve(createFakeAgent(), {
      port: 0,
      serviceName: 'test-agent',
      memoryDir: dir,
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/policy/events?domain=llm`)
      const body = await response.json() as { events: Array<{ provider: string; reason: string }> }
      assert.equal(body.events[0]?.provider, 'codex')
      assert.equal(body.events[0]?.reason, 'blocked in test')
    } finally {
      handle.server.closeAllConnections()
      await new Promise<void>(resolve => handle.server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves ANUP overview, task projection, and HTML workbench', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-anup-'))
    const file = join(dir, 'out.txt')
    writeFileSync(file, 'artifact bytes', 'utf-8')
    const jobStore = new FileArtifactJobStore(dir)
    await jobStore.put({
      id: 'job-anup',
      provider: 'fake-artifacts',
      status: 'completed',
      request: { type: 'file', prompt: 'x' },
      artifacts: [{ id: 'artifact-1', uri: file, kind: 'file', mediaType: 'text/plain' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    writePolicyEvent(join(dir, 'state'), {
      domain: 'artifact',
      provider: 'fake-artifacts',
      allowed: false,
      reason: 'blocked in test',
    })
    const longTasks = new LongTaskController({ memoryDir: dir, autoStart: false })
    const task = longTasks.create({
      goal: 'Expose ANUP state',
      acceptance: 'Workbench can render the task',
      start: false,
    })
    const handle = serve(createFakeAgent(), {
      port: 0,
      serviceName: 'test-agent',
      memoryDir: dir,
      longTasks,
      capabilities: { llm: { provider: 'fake', input: { image: true }, output: { text: true } } },
      modelRouter: createFakeModelRouter(),
      artifacts: {
        enabled: false,
        providers: {},
        store: new FileArtifactStore(dir),
        jobStore,
        reason: 'disabled for test',
      },
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port

      const overviewResponse = await fetch(`http://127.0.0.1:${port}/anup/overview`)
      const overview = await overviewResponse.json() as { protocol: string; blocks: Array<{ type: string }> }
      assert.equal(overviewResponse.status, 200)
      assert.equal(overview.protocol, 'anup')
      assert.ok(overview.blocks.some(block => block.type === 'agent_state'))
      assert.ok(overview.blocks.some(block => block.type === 'media_ref'))

      const taskResponse = await fetch(`http://127.0.0.1:${port}/anup/tasks/${task.id}`)
      const taskProjection = await taskResponse.json() as { run_id: string; blocks: Array<{ type: string }> }
      assert.equal(taskProjection.run_id, `task:${task.id}`)
      assert.ok(taskProjection.blocks.some(block => block.type === 'tool_trace'))

      const workbenchResponse = await fetch(`http://127.0.0.1:${port}/workbench`)
      assert.equal(workbenchResponse.headers.get('content-type')?.startsWith('text/html'), true)
      assert.match(await workbenchResponse.text(), /Agent Workbench/)

      const chatUiResponse = await fetch(`http://127.0.0.1:${port}/chat-ui`)
      assert.equal(chatUiResponse.headers.get('content-type')?.startsWith('text/html'), true)
      const chatUi = await chatUiResponse.text()
      assert.match(chatUi, /Talk To Akari/)
      assert.match(chatUi, /Provider & Media Capability/)
      assert.match(chatUi, /Route preview/)
      assert.match(chatUi, /attachUri/)
      assert.match(chatUi, /Optional attachment URL/)
      assert.match(chatUi, /Pending approval/)

      const demoResponse = await fetch(`http://127.0.0.1:${port}/demo/anup`, { method: 'POST' })
      const demo = await demoResponse.json() as { run_id: string; blocks: Array<{ type: string }> }
      assert.equal(demoResponse.status, 201)
      assert.ok(demo.blocks.some(block => block.type === 'decision_card'))
      assert.ok(demo.blocks.some(block => block.type === 'media_ref'))

      for (const path of ['/loop/status', '/logs', '/context', '/api/dashboard/behaviors', '/api/dashboard/learning', '/api/dashboard/journal']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`)
        assert.equal(response.status, 200, `${path} should be available`)
        assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true)
      }

      const routePreviewResponse = await fetch(`http://127.0.0.1:${port}/model/route-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'inspect', attachments: [{ uri: 'https://example.test/image.png', mediaType: 'image/png' }] }),
      })
      const routePreview = await routePreviewResponse.json() as { selected: { name: string } | null; rejected: Array<{ name: string; reason: string }> }
      assert.equal(routePreviewResponse.status, 200)
      assert.equal(routePreview.selected?.name, 'vision-provider')
      assert.equal(routePreview.rejected[0]?.reason, 'image input unsupported')

      const generateResponse = await fetch(`http://127.0.0.1:${port}/model/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'describe', attachments: [{ uri: 'https://example.test/image.png', mediaType: 'image/png' }] }),
      })
      const generated = await generateResponse.json() as { selected: { name: string }; response: { text: string; provider: string } }
      assert.equal(generateResponse.status, 200)
      assert.equal(generated.selected.name, 'vision-provider')
      assert.equal(generated.response.provider, 'vision-provider')
      assert.match(generated.response.text, /vision-provider handled/)

      const streamResponse = await fetch(`http://127.0.0.1:${port}/model/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'stream', attachments: [{ uri: 'https://example.test/image.png', mediaType: 'image/png' }] }),
      })
      const streamText = await streamResponse.text()
      assert.equal(streamResponse.status, 200)
      assert.match(streamText, /event: route/)
      assert.match(streamText, /event: chunk/)
      assert.match(streamText, /event: done/)
    } finally {
      handle.server.closeAllConnections()
      await new Promise<void>(resolve => handle.server.close(() => resolve()))
      longTasks.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists ANUP chat runs from /chat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-chat-anup-'))
    const handle = serve(createChatAgent(), {
      port: 0,
      serviceName: 'test-agent',
      memoryDir: dir,
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port

      const chatResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'test',
          text: 'hello',
          attachments: [{ uri: 'https://example.test/image.png', mediaType: 'image/png' }],
        }),
      })
      assert.equal(chatResponse.status, 200)

      const runsResponse = await fetch(`http://127.0.0.1:${port}/anup/runs`)
      const runs = await runsResponse.json() as { runs: Array<{ run_id: string; blocks: Array<{ type: string }> }> }
      assert.equal(runs.runs.length, 1)
      assert.ok(runs.runs[0]?.blocks.some(block => block.type === 'tool_trace'))
      assert.ok(runs.runs[0]?.blocks.some(block => block.type === 'approval_request'))
      assert.ok(runs.runs[0]?.blocks.some(block => block.type === 'media_ref'))
    } finally {
      handle.server.closeAllConnections()
      await new Promise<void>(resolve => handle.server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats LLM error tick output as a failed chat request', async () => {
    const handle = serve(createLlmErrorAgent(), {
      port: 0,
      serviceName: 'test-agent',
    })

    try {
      await once(handle.server, 'listening')
      const address = handle.server.address()
      assert.ok(address && typeof address === 'object')
      const port = (address as AddressInfo).port

      const chatResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'test', text: 'hello' }),
      })
      const failed = await chatResponse.json() as { error: string }
      assert.equal(chatResponse.status, 500)
      assert.match(failed.error, /Provider error: upstream failed/)

      const healthResponse = await fetch(`http://127.0.0.1:${port}/health`)
      const health = await healthResponse.json() as { errors: number; recentTicks: Array<{ error?: string }> }
      assert.equal(health.errors, 1)
      assert.match(health.recentTicks.at(-1)?.error ?? '', /Provider error: upstream failed/)
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

function createFakeModelRouter() {
  const textProvider: ModelIO = {
    name: 'text-provider',
    capabilities: {
      input: { text: true, image: false, audio: false, pdf: false, file: false, url: true, streamRef: false },
      output: { text: true, image: false, audio: false, file: false, structured: false },
      streaming: { text: true, structured: false, toolCalls: false, media: false },
      tools: { native: false, parallel: false },
      state: { sessions: false },
    },
    async generate() { return { text: `${this.name} handled request`, provider: this.name } },
    async *stream() {
      yield { type: 'text_delta', text: `${this.name} streamed request` }
      yield { type: 'done', metadata: { provider: this.name } }
    },
  }
  const visionProvider: ModelIO = {
    ...textProvider,
    name: 'vision-provider',
    capabilities: {
      ...textProvider.capabilities,
      input: { ...textProvider.capabilities.input, image: true },
    },
  }
  return {
    providers: [textProvider, visionProvider],
    route(request: ModelRequest, _requirement?: ModelRouteRequirement) {
      const rejected: Array<{ name: string; reason: string }> = []
      const prompt = Array.isArray(request.prompt) ? request.prompt : [{ type: 'text' as const, text: request.prompt }]
      for (const provider of [textProvider, visionProvider]) {
        const hasImage = prompt.some(block => block.type === 'media' && block.mediaType.startsWith('image/'))
        if (hasImage && !provider.capabilities.input.image) {
          rejected.push({ name: provider.name, reason: 'image input unsupported' })
          continue
        }
        return { selected: provider, rejected }
      }
      return { rejected }
    },
  }
}

function createChatAgent(): TanrenAgent {
  let sessionId: string | null = null
  return {
    async tick() { throw new Error('not used') },
    async chat() { throw new Error('not used') },
    async runChain() {
      return [{
        perception: 'message',
        thought: '<action:respond>hello</action:respond><action:shell>echo high</action:shell>',
        actions: [
          { type: 'respond', content: 'hello', raw: '<action:respond>hello</action:respond>' },
          { type: 'shell', content: 'echo high', raw: '<action:shell>echo high</action:shell>' },
        ],
        observation: {
          outputExists: true,
          outputQuality: 3,
          confidenceCalibration: 0,
          actionsExecuted: 2,
          actionsFailed: 0,
          duration: 12,
        },
        timestamp: Date.now(),
        gateResults: [],
      }]
    },
    start() {},
    stop() {},
    isRunning() { return false },
    getRecentTicks() { return [] },
    setSessionId(id) { sessionId = id },
    getSessionId() { return sessionId },
  }
}

function createLlmErrorAgent(): TanrenAgent {
  let sessionId: string | null = null
  return {
    async tick() { throw new Error('not used') },
    async chat() { throw new Error('not used') },
    async runChain() {
      return [{
        perception: 'message',
        thought: '[LLM error: upstream failed]',
        actions: [],
        observation: {
          outputExists: false,
          outputQuality: 0,
          confidenceCalibration: 0,
          actionsExecuted: 0,
          actionsFailed: 1,
          duration: 10,
        },
        timestamp: Date.now(),
        gateResults: [],
      }]
    },
    start() {},
    stop() {},
    isRunning() { return false },
    getRecentTicks() { return [] },
    setSessionId(id) { sessionId = id },
    getSessionId() { return sessionId },
  }
}
