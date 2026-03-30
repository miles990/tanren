/**
 * Tanren — Anthropic API Provider
 *
 * Direct API calls to Anthropic. Requires API key.
 * For headless/server deployments where CLI isn't available.
 */

import type { LLMProvider } from '../types.js'

export interface AnthropicProviderOptions {
  apiKey: string
  model?: string             // default: claude-sonnet-4-20250514
  maxTokens?: number         // default: 8192
  baseUrl?: string           // default: https://api.anthropic.com
  timeoutMs?: number         // default: 1_500_000
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): LLMProvider {
  const model = opts.model ?? 'claude-sonnet-4-20250514'
  const maxTokens = opts.maxTokens ?? 8192
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 1_500_000

  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: systemPrompt || undefined,
            messages: [{ role: 'user', content: context }],
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 500)}`)
        }

        const data = await response.json() as {
          content: Array<{ type: string; text?: string }>
        }

        const text = data.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')

        return text.trim()
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
