import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectStream, createGenerationIO, createModelIO, routeModelRequest, supportsModelRequest } from './model-io.js'
import { GEMINI_CAPABILITIES, TEXT_ONLY_CAPABILITIES } from './provider-capabilities.js'
import type { LLMProvider } from './types.js'

describe('ModelIO', () => {
  it('wraps legacy providers behind a common generate interface', async () => {
    const provider: LLMProvider = {
      async think(context) { return `echo:${context}` },
    }
    const io = createModelIO('test', provider)
    const response = await io.generate({ prompt: [{ type: 'text', text: 'hello' }] })
    assert.equal(response.text, 'echo:hello')
    assert.equal(response.provider, 'test')
    assert.equal(response.metadata?.degradedToText, true)
  })

  it('collects text and content blocks from streams', async () => {
    async function* stream() {
      yield { type: 'text_delta' as const, text: 'he' }
      yield { type: 'text_delta' as const, text: 'llo' }
      yield { type: 'content_block' as const, content: { type: 'ref' as const, uri: 'file://out.png', mediaType: 'image/png' } }
      yield { type: 'done' as const, metadata: { ok: true } }
    }
    const response = await collectStream(stream())
    assert.equal(response.text, 'hello')
    assert.equal(response.outputs?.[0]?.type, 'ref')
    assert.equal(response.metadata?.ok, true)
  })

  it('exposes provider capabilities for routing', () => {
    const provider: LLMProvider = {
      capabilities: TEXT_ONLY_CAPABILITIES,
      async think() { return 'ok' },
    }
    const io = createModelIO('text', provider)
    assert.equal(io.capabilities.input.text, true)
    assert.equal(io.capabilities.input.image, false)
  })

  it('routes unified generation requests to model or artifact adapters', async () => {
    const model = createModelIO('model', { async think() { return 'ok' } })
    const generation = createGenerationIO({
      name: 'mixed',
      model,
      artifactProvider: {
        name: 'artifact',
        capabilities: { kinds: ['image'], streaming: false, input: { image: false, audio: false, video: false, file: false }, output: { base64: true, file: true, url: false } },
        async submit(request) {
          return { id: 'job-1', provider: 'artifact', status: 'completed', request, artifacts: [], createdAt: 'now', updatedAt: 'now' }
        },
        async get() { return null },
      },
    })
    assert.equal((await generation.generate({ modality: 'model', request: { prompt: 'x' } })).modality, 'model')
    assert.equal((await generation.generate({ modality: 'artifact', request: { type: 'image', prompt: 'x' } })).modality, 'artifact')
  })

  it('routes model requests by multimodal capabilities', () => {
    const text = createModelIO('text', { capabilities: TEXT_ONLY_CAPABILITIES, async think() { return 'text' } })
    const gemini = createModelIO('gemini', { capabilities: GEMINI_CAPABILITIES, async think() { return 'multi' } })
    const request = {
      prompt: [
        { type: 'text' as const, text: 'describe this' },
        { type: 'media' as const, mediaType: 'image/png', source: { type: 'url' as const, url: 'https://example.test/a.png' } },
      ],
    }

    assert.equal(supportsModelRequest(text, request).ok, false)
    const routed = routeModelRequest([text, gemini], request, { output: { structured: true } })
    assert.equal(routed.selected?.name, 'gemini')
    assert.equal(routed.rejected[0]?.reason, 'image input unsupported')
  })
})
