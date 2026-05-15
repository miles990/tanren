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

export function extractOpenAIOutputs(value: unknown): PromptContentBlock[] {
  const outputs: PromptContentBlock[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    const type = String(obj.type ?? '')
    if ((type === 'image_url' || type === 'output_image') && typeof obj.image_url === 'object') {
      const image = obj.image_url as Record<string, unknown>
      if (typeof image.url === 'string') outputs.push({ type: 'media', mediaType: 'image/*', source: { type: 'url', url: image.url } })
    }
    if ((type === 'input_image' || type === 'image') && typeof obj.image_url === 'string') {
      outputs.push({ type: 'media', mediaType: 'image/*', source: { type: 'url', url: obj.image_url } })
    }
    if ((type === 'file' || type === 'output_file') && typeof obj.file_id === 'string') {
      outputs.push({ type: 'ref', uri: `openai:file:${obj.file_id}` })
    }
    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(value)
  return outputs
}

export function extractAnthropicOutputs(content: Array<Record<string, unknown>>): PromptContentBlock[] {
  const outputs: PromptContentBlock[] = []
  for (const block of content) {
    const type = String(block.type ?? '')
    if (type === 'image' && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>
      const mediaType = String(source.media_type ?? 'image/*')
      if (source.type === 'base64' && typeof source.data === 'string') outputs.push({ type: 'media', mediaType, source: { type: 'base64', data: source.data } })
      if (source.type === 'url' && typeof source.url === 'string') outputs.push({ type: 'media', mediaType, source: { type: 'url', url: source.url } })
    }
    if ((type === 'document' || type === 'file') && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>
      if (source.type === 'base64' && typeof source.data === 'string') {
        outputs.push({ type: 'media', mediaType: String(source.media_type ?? 'application/octet-stream'), source: { type: 'base64', data: source.data } })
      }
      if (source.type === 'url' && typeof source.url === 'string') {
        outputs.push({ type: 'ref', uri: source.url, mediaType: String(source.media_type ?? '') || undefined })
      }
    }
  }
  return outputs
}

export function extractGeminiOutputs(parts: Array<Record<string, unknown>>): PromptContentBlock[] {
  const outputs: PromptContentBlock[] = []
  for (const part of parts) {
    if (typeof part.inlineData === 'object') {
      const data = part.inlineData as Record<string, unknown>
      if (typeof data.data === 'string') outputs.push({ type: 'media', mediaType: String(data.mimeType ?? data.mime_type ?? 'application/octet-stream'), source: { type: 'base64', data: data.data } })
    }
    if (typeof part.fileData === 'object') {
      const data = part.fileData as Record<string, unknown>
      if (typeof data.fileUri === 'string') outputs.push({ type: 'ref', uri: data.fileUri, mediaType: String(data.mimeType ?? '') || undefined })
    }
    if (typeof part.file_data === 'object') {
      const data = part.file_data as Record<string, unknown>
      if (typeof data.file_uri === 'string') outputs.push({ type: 'ref', uri: data.file_uri, mediaType: String(data.mime_type ?? '') || undefined })
    }
  }
  return outputs
}
