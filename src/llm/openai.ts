/**
 * Tanren — OpenAI-Compatible Provider
 *
 * Works with any OpenAI-compatible API (OpenAI, Ollama, vLLM, LiteLLM, etc).
 */

import type { LLMProvider } from '../types.js'

export interface OpenAIProviderOptions {
  apiKey: string
  model?: string             // default: gpt-4o
  maxTokens?: number         // default: 8192
  baseUrl?: string           // default: https://api.openai.com/v1
  timeoutMs?: number         // default: 1_500_000
  extraBody?: Record<string, unknown>  // extra params (e.g. chat_template_kwargs)
}

export function createOpenAIProvider(opts: OpenAIProviderOptions): LLMProvider {
  const model = opts.model ?? 'gpt-4o'
  const maxTokens = opts.maxTokens ?? 8192
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 1_500_000

  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const messages: Array<{ role: string; content: string }> = []

        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt })
        }
        messages.push({ role: 'user', content: context })

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages,
            ...opts.extraBody,
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 500)}`)
        }

        const data = await response.json() as {
          choices: Array<{ message: { content: string } }>
        }

        return (data.choices[0]?.message?.content ?? '').trim()
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
