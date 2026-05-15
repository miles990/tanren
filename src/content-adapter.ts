/**
 * Tanren — Prompt Content Adapter
 *
 * Converts Tanren's universal Prompt blocks into provider-specific shapes.
 * Text-only providers should call `promptToText()` for graceful degradation.
 */

import type { Prompt, PromptContentBlock } from './types.js'

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }

export type OpenAIBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { file_uri: string; mime_type: string } }

export function promptToText(prompt: Prompt): string {
  if (typeof prompt === 'string') return prompt
  return prompt.map(blockToText).join('\n\n')
}

function blockToText(block: PromptContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'media': return `[${block.mediaType}${block.label ? `: ${block.label}` : ''} via ${block.source.type}]`
    case 'stream': return `[Stream: ${block.mediaType} ${block.url}${block.protocol ? ` (${block.protocol})` : ''}]`
    case 'ref': return `[Ref: ${block.uri}${block.mediaType ? ` (${block.mediaType})` : ''}]`
  }
}

export function toAnthropic(blocks: PromptContentBlock[]): AnthropicBlock[] {
  const result: AnthropicBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        result.push({ type: 'text', text: block.text })
        break
      case 'media':
        if (block.mediaType.startsWith('image/')) {
          if (block.source.type === 'base64') {
            result.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.source.data } })
          } else if (block.source.type === 'url') {
            result.push({ type: 'image', source: { type: 'url', url: block.source.url } })
          } else {
            result.push({ type: 'text', text: `[Image file: ${block.source.path}]` })
          }
        } else if (block.mediaType === 'application/pdf' && block.source.type === 'base64') {
          result.push({ type: 'document', source: { type: 'base64', media_type: block.mediaType, data: block.source.data } })
        } else {
          result.push({ type: 'text', text: blockToText(block) })
        }
        break
      case 'stream':
      case 'ref':
        result.push({ type: 'text', text: blockToText(block) })
        break
    }
  }
  return result
}

export function toOpenAI(blocks: PromptContentBlock[]): OpenAIBlock[] {
  const result: OpenAIBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        result.push({ type: 'text', text: block.text })
        break
      case 'media':
        if (block.mediaType.startsWith('image/')) {
          const url = block.source.type === 'url'
            ? block.source.url
            : block.source.type === 'base64'
              ? `data:${block.mediaType};base64,${block.source.data}`
              : `file://${block.source.path}`
          result.push({ type: 'image_url', image_url: { url } })
        } else if (block.mediaType.startsWith('audio/') && block.source.type === 'base64') {
          result.push({ type: 'input_audio', input_audio: { data: block.source.data, format: block.mediaType.split('/')[1] ?? 'mp3' } })
        } else {
          result.push({ type: 'text', text: blockToText(block) })
        }
        break
      case 'stream':
      case 'ref':
        result.push({ type: 'text', text: blockToText(block) })
        break
    }
  }
  return result
}

export function toGemini(blocks: PromptContentBlock[]): GeminiPart[] {
  const result: GeminiPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        result.push({ text: block.text })
        break
      case 'media':
        if (block.source.type === 'base64') {
          result.push({ inline_data: { mime_type: block.mediaType, data: block.source.data } })
        } else if (block.source.type === 'url') {
          result.push({ file_data: { file_uri: block.source.url, mime_type: block.mediaType } })
        } else {
          result.push({ text: blockToText(block) })
        }
        break
      case 'stream':
      case 'ref':
        result.push({ text: blockToText(block) })
        break
    }
  }
  return result
}
