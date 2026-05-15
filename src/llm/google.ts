/**
 * Tanren — Google Gemini Provider
 */

import type { LLMProvider, Prompt } from '../types.js'
import { extractGeminiOutputs, toGemini, promptToText } from '../content-adapter.js'
import { GEMINI_CAPABILITIES } from '../provider-capabilities.js'

export interface GoogleProviderOptions {
  model?: string
  apiKey?: string
  maxTokens?: number
  temperature?: number
}

export function createGoogleProvider(opts?: GoogleProviderOptions): LLMProvider {
  const model = opts?.model ?? 'gemini-2.0-flash'
  const apiKey = opts?.apiKey ?? process.env.GOOGLE_API_KEY
  const maxTokens = opts?.maxTokens ?? 4096
  const temperature = opts?.temperature ?? 0.7

  return {
    capabilities: GEMINI_CAPABILITIES,

    async think(context: string, systemPrompt: string): Promise<string> {
      return this.thinkStructured
        ? (await this.thinkStructured(context, systemPrompt)).text
        : context
    },

    async thinkStructured(prompt: Prompt, systemPrompt: string) {
      if (!apiKey) throw new Error('GOOGLE_API_KEY not set')

      const requestParts = typeof prompt === 'string'
        ? [{ text: promptToText(prompt) }]
        : toGemini(prompt)

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: requestParts }],
          systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        }),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Gemini API ${response.status}: ${text.slice(0, 300)}`)
      }

      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown> & { text?: string }> } }> }
      const responseParts = data.candidates?.[0]?.content?.parts ?? []
      return {
        text: responseParts.map(p => p.text ?? '').join(''),
        outputs: extractGeminiOutputs(responseParts),
        metadata: { model },
      }
    },

    async *thinkStream(prompt: Prompt, systemPrompt: string) {
      if (!apiKey) {
        yield { type: 'error', error: 'GOOGLE_API_KEY not set' }
        return
      }
      const parts = typeof prompt === 'string'
        ? [{ text: promptToText(prompt) }]
        : toGemini(prompt)
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
            generationConfig: { maxOutputTokens: maxTokens, temperature },
          }),
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`Gemini API ${response.status}: ${text.slice(0, 300)}`)
        }
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let sseBuffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop()!
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (!data) continue
            let parsed: { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown> & { text?: string }> } }> }
            try { parsed = JSON.parse(data) } catch { continue }
            const chunkParts = parsed.candidates?.[0]?.content?.parts ?? []
            for (const part of chunkParts) {
              if (part.text) yield { type: 'text_delta', text: part.text }
            }
            for (const output of extractGeminiOutputs(chunkParts)) yield { type: 'media_delta', content: output }
          }
        }
        yield { type: 'done', metadata: { model } }
      } catch (err) {
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
