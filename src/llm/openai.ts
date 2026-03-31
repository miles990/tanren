/**
 * Tanren — OpenAI-Compatible Provider
 *
 * Works with any OpenAI-compatible API (OpenAI, Ollama, omlx, vLLM, LiteLLM, etc).
 * Supports streaming for real-time thought display.
 */

import type { LLMProvider } from '../types.js'

/** Callback for streaming text chunks during generation */
export type OnStreamText = (text: string) => void

export interface OpenAIProviderOptions {
  apiKey: string
  model?: string             // default: gpt-4o
  maxTokens?: number         // default: 8192
  baseUrl?: string           // default: https://api.openai.com/v1
  timeoutMs?: number         // default: 1_500_000
  extraBody?: Record<string, unknown>  // extra params (e.g. chat_template_kwargs)
}

export function createOpenAIProvider(opts: OpenAIProviderOptions): LLMProvider & { activeModel?: string; onStreamText?: OnStreamText } {
  const defaultModel = opts.model ?? 'gpt-4o'
  const maxTokens = opts.maxTokens ?? 8192
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 1_500_000

  const provider: LLMProvider & { activeModel?: string; onStreamText?: OnStreamText } = {
    activeModel: undefined,
    onStreamText: undefined,

    async think(context: string, systemPrompt: string): Promise<string> {
      const model = provider.activeModel ?? defaultModel
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const streaming = !!provider.onStreamText

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
            stream: streaming,
            ...opts.extraBody,
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 500)}`)
        }

        if (!streaming) {
          const data = await response.json() as {
            choices: Array<{ message: { content: string } }>
          }
          return (data.choices[0]?.message?.content ?? '').trim()
        }

        // Streaming: parse SSE chunks
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let result = ''
        let sseBuffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })

          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop()! // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data) as {
                choices: Array<{ delta: { content?: string } }>
              }
              const chunk = parsed.choices[0]?.delta?.content
              if (chunk) {
                result += chunk
                provider.onStreamText?.(chunk)
              }
            } catch { /* skip malformed chunks */ }
          }
        }

        return result.trim()
      } finally {
        clearTimeout(timer)
      }
    },
  }

  return provider
}
