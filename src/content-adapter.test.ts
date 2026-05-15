import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promptToText, toAnthropic, toGemini, toOpenAI } from './content-adapter.js'
import type { PromptContentBlock } from './types.js'

describe('content adapter', () => {
  const prompt: PromptContentBlock[] = [
    { type: 'text', text: 'Describe this image' },
    { type: 'media', mediaType: 'image/png', source: { type: 'base64', data: 'abc123' }, label: 'screenshot' },
  ]

  it('degrades multimodal prompts to text for text-only providers', () => {
    const text = promptToText(prompt)
    assert.match(text, /Describe this image/)
    assert.match(text, /image\/png: screenshot/)
  })

  it('converts image blocks for Anthropic', () => {
    const blocks = toAnthropic(prompt)
    assert.equal(blocks[1].type, 'image')
  })

  it('converts image blocks for OpenAI', () => {
    const blocks = toOpenAI(prompt)
    assert.equal(blocks[1].type, 'image_url')
  })

  it('converts image blocks for Gemini', () => {
    const parts = toGemini(prompt)
    assert.deepEqual(parts[1], { inline_data: { mime_type: 'image/png', data: 'abc123' } })
  })
})
