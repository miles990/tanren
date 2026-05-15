import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  FileArtifactStore,
  createArtifactActions,
  createArtifactActionsFromEnv,
  createArtifactRequestFromInput,
  createArtifactProviderFromEnv,
  createArtifactGraphExecutor,
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
      capabilities: { kinds: ['image', 'audio'], streaming: false, input: { image: false, audio: false, video: false, file: false }, output: { base64: true, file: true, url: false } },
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

  it('keeps env factory disabled when credentials are absent', () => {
    const selection = createArtifactProviderFromEnv({ env: { TANREN_ARTIFACT_PROVIDER: 'openai' } as NodeJS.ProcessEnv })
    assert.equal(selection.enabled, false)
    assert.deepEqual(createArtifactActionsFromEnv({ env: { TANREN_ARTIFACT_PROVIDER: 'openai' } as NodeJS.ProcessEnv }), [])
  })
})
