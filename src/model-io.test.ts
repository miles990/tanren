import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectStream, createModelIO } from './model-io.js'
import { TEXT_ONLY_CAPABILITIES } from './provider-capabilities.js'
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
})
