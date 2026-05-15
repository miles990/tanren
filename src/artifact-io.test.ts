import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  FileArtifactJobStore,
  FileArtifactStore,
  createArtifactActions,
  createArtifactActionsFromEnv,
  createArtifactRequestFromInput,
  createArtifactProviderFromEnv,
  createArtifactGraphExecutor,
  createOpenAIArtifactProvider,
  routeArtifactRequest,
  wrapArtifactProviderWithPolicy,
  type ArtifactProvider,
  type ArtifactRequest,
} from './artifact-io.js'

describe('ArtifactIO', () => {
  it('stores artifacts as reusable refs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-artifacts-'))
    try {
      const store = new FileArtifactStore(dir)
      const ref = await store.put({ kind: 'image', mediaType: 'image/png', data: 'abc123', encoding: 'base64' })
      assert.equal(ref.kind, 'image')
      assert.match(ref.uri, /artifact-/)
      const blob = await store.get(ref)
      assert.equal(blob.mediaType, 'image/png')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs independent artifact graph nodes in waves and pipes deps as inputs', async () => {
    const calls: Array<{ provider: string; request: ArtifactRequest }> = []
    const provider = (name: string): ArtifactProvider => ({
      name,
      capabilities: { kinds: ['image'], streaming: false, input: { image: true, audio: false, video: false, file: true }, output: { base64: true, file: true, url: false } },
      async submit(request) {
        calls.push({ provider: name, request })
        return {
          id: `job-${name}`,
          provider: name,
          status: 'completed',
          request,
          artifacts: [{ id: `art-${name}`, uri: `/tmp/${name}.png`, kind: 'image', mediaType: 'image/png' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
      async get() { return null },
    })
    const execute = createArtifactGraphExecutor({ sketch: provider('sketch'), upscale: provider('upscale') })
    const result = await execute({
      nodes: [
        { id: 'a', provider: 'sketch', request: { type: 'image', prompt: 'draw' } },
        { id: 'b', provider: 'upscale', dependsOn: ['a'], request: { type: 'image', prompt: 'upscale' } },
      ],
    })
    assert.equal(result.summary.completed, 2)
    assert.equal(calls[1].request.inputs?.[0]?.type, 'ref')
  })

  it('exposes artifact/image/audio generation actions', async () => {
    const fakeProvider: ArtifactProvider = {
      name: 'fake',
      capabilities: { kinds: ['image', 'audio'], streaming: false, input: { image: false, audio: false, video: false, file: true }, output: { base64: true, file: true, url: false } },
      async submit(request) {
        return {
          id: 'job-1',
          provider: 'fake',
          status: 'completed',
          request,
          artifacts: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
      async get() { return null },
    }
    const actions = createArtifactActions({ providers: { fake: fakeProvider }, defaultProvider: 'fake' })
    assert.deepEqual(actions.map(a => a.type), ['artifact_generate', 'image_generate', 'audio_generate'])
    const output = await actions[1].execute({ type: 'image_generate', content: '', raw: '', input: { prompt: 'x', refs: ['/tmp/source.png'] } }, {} as never)
    assert.match(output, /"status": "completed"/)
  })

  it('normalizes artifact refs and prompt inputs from action input', () => {
    const request = createArtifactRequestFromInput({
      type: 'image',
      prompt: 'variation',
      refs: [
        '/tmp/source.png',
        { id: 'a1', uri: '/tmp/a1.png', kind: 'image', mediaType: 'image/png' },
      ],
      inputs: [{ type: 'text', text: 'style: ink' }],
    })

    assert.equal(request.inputs?.length, 3)
    assert.deepEqual(request.inputs?.map(input => input.type), ['text', 'ref', 'ref'])
  })

  it('routes artifact requests by provider capabilities', () => {
    const imageOnly: ArtifactProvider = {
      name: 'image-only',
      capabilities: { kinds: ['image'], streaming: false, input: { image: true, audio: false, video: false, file: true }, output: { base64: true, file: true, url: false } },
      async submit() { throw new Error('not used') },
      async get() { return null },
    }
    const audioOnly: ArtifactProvider = {
      name: 'audio-only',
      capabilities: { kinds: ['audio'], streaming: false, input: { image: false, audio: false, video: false, file: false }, output: { base64: true, file: true, url: false } },
      async submit() { throw new Error('not used') },
      async get() { return null },
    }
    const routed = routeArtifactRequest(
      { type: 'audio', prompt: 'say hi' },
      { providers: { image: imageOnly, audio: audioOnly }, defaultProvider: 'image' },
    )
    assert.equal(routed.provider.name, 'audio-only')
    assert.equal(routed.reason, 'capability match')
  })

  it('keeps env factory disabled when credentials are absent', () => {
    const selection = createArtifactProviderFromEnv({ env: { TANREN_ARTIFACT_PROVIDER: 'openai' } as NodeJS.ProcessEnv })
    assert.equal(selection.enabled, false)
    assert.deepEqual(createArtifactActionsFromEnv({ env: { TANREN_ARTIFACT_PROVIDER: 'openai' } as NodeJS.ProcessEnv }), [])
  })

  it('persists artifact jobs for later lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-artifact-jobs-'))
    try {
      const store = new FileArtifactJobStore(dir)
      const job = {
        id: 'job-persisted',
        provider: 'fake',
        status: 'completed' as const,
        request: { type: 'image' as const, prompt: 'x' },
        artifacts: [{ id: 'artifact-1', uri: '/tmp/a.png', kind: 'image' as const, mediaType: 'image/png' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await store.put(job)
      assert.equal((await store.get(job.id))?.artifacts[0]?.uri, '/tmp/a.png')
      assert.equal((await store.list({ provider: 'fake' })).length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('blocks artifact provider calls before cloud spend when policy disallows cloud', async () => {
    const provider: ArtifactProvider = {
      name: 'fake',
      capabilities: { kinds: ['image'], streaming: false, input: { image: false, audio: false, video: false, file: false }, output: { base64: true, file: true, url: false } },
      async submit() { throw new Error('provider should not be called') },
      async get() { return null },
    }
    const guarded = wrapArtifactProviderWithPolicy(provider, { policy: { allowCloud: false } })
    await assert.rejects(
      () => guarded.submit({ type: 'image', prompt: 'x' }),
      /artifact cloud providers disabled by policy/,
    )
  })

  it('routes image refs to OpenAI image edits through injectable fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-openai-artifacts-'))
    try {
      const source = join(dir, 'source.png')
      writeFileSync(source, Buffer.from('png'))
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(input), init })
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('out').toString('base64') }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const provider = createOpenAIArtifactProvider({
        apiKey: 'test',
        baseUrl: 'https://example.test/v1',
        store: new FileArtifactStore(dir),
        fetch: fakeFetch,
      })
      const job = await provider.submit({
        type: 'image',
        prompt: 'edit it',
        inputs: [{ type: 'ref', uri: source, mediaType: 'image/png' }],
      })
      assert.equal(job.status, 'completed')
      assert.equal(calls[0].url, 'https://example.test/v1/images/edits')
      assert.ok(calls[0].init?.body instanceof FormData)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
