/**
 * Tanren — Google Gemini Provider
 */

import type { LLMProvider, Prompt } from '../types.js'
import { toGemini, promptToText } from '../content-adapter.js'

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
    async think(context: string, systemPrompt: string): Promise<string> {
      return this.thinkStructured
        ? (await this.thinkStructured(context, systemPrompt)).text
        : context
    },

    async thinkStructured(prompt: Prompt, systemPrompt: string) {
      if (!apiKey) throw new Error('GOOGLE_API_KEY not set')

      const parts = typeof prompt === 'string'
        ? [{ text: promptToText(prompt) }]
        : toGemini(prompt)

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
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

      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      return {
        text: data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '',
        metadata: { model },
      }
    },
  }
}
