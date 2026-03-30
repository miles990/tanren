/**
 * Tanren — Anthropic API Provider
 *
 * Direct API calls to Anthropic with native tool use support.
 * Requires API key. For headless/server deployments where CLI isn't available.
 */

import type { LLMProvider, ToolUseLLMProvider, ToolDefinition, ConversationMessage, ToolUseResponse } from '../types.js'

export interface AnthropicProviderOptions {
  apiKey: string
  model?: string             // default: claude-sonnet-4-20250514
  maxTokens?: number         // default: 8192
  baseUrl?: string           // default: https://api.anthropic.com
  timeoutMs?: number         // default: 1_500_000
}

export interface CostTracker {
  totalInputTokens: number
  totalOutputTokens: number
  totalCalls: number
  getCost(inputPricePer1M?: number, outputPricePer1M?: number): number
  reset(): void
}

interface AnthropicApiResponse {
  content: Array<{
    type: string
    text?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
  }>
  usage: { input_tokens: number; output_tokens: number }
  stop_reason: string
}

/** Callback for streaming text chunks during generation */
export type OnStreamText = (text: string) => void

export function createAnthropicProvider(opts: AnthropicProviderOptions): ToolUseLLMProvider & { cost: CostTracker; onStreamText?: OnStreamText } {
  const model = opts.model ?? 'claude-sonnet-4-20250514'
  const maxTokens = opts.maxTokens ?? 8192
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 1_500_000

  // Cost tracking
  const cost: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCalls: 0,
    getCost(inputPricePer1M = 3, outputPricePer1M = 15) {
      return (this.totalInputTokens / 1_000_000) * inputPricePer1M
        + (this.totalOutputTokens / 1_000_000) * outputPricePer1M
    },
    reset() {
      this.totalInputTokens = 0
      this.totalOutputTokens = 0
      this.totalCalls = 0
    },
  }

  function trackUsage(usage: { input_tokens: number; output_tokens: number }): void {
    cost.totalInputTokens += usage.input_tokens
    cost.totalOutputTokens += usage.output_tokens
    cost.totalCalls++
  }

  async function callApi(body: Record<string, unknown>): Promise<AnthropicApiResponse> {
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
        body: JSON.stringify({ model, max_tokens: maxTokens, ...body }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 500)}`)
      }

      const data = await response.json() as AnthropicApiResponse
      trackUsage(data.usage)
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    cost,

    // Legacy text-only interface (LLMProvider compatibility)
    async think(context: string, systemPrompt: string): Promise<string> {
      const data = await callApi({
        system: systemPrompt || undefined,
        messages: [{ role: 'user', content: context }],
      })

      return data.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
    },

    // Settable stream callback — set by serve mode to push live thinking
    onStreamText: undefined as OnStreamText | undefined,

    // Native tool use interface (streaming — emits text chunks via onStreamText)
    async thinkWithTools(
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ): Promise<ToolUseResponse> {
      const body: Record<string, unknown> = {
        system: systemPrompt || undefined,
        messages,
        stream: true,
      }

      if (tools.length > 0) {
        body.tools = tools
      }

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
          body: JSON.stringify({ model, max_tokens: maxTokens, ...body }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 500)}`)
        }

        // Parse SSE stream
        const contentBlocks: ToolUseResponse['content'] = []
        let currentTextIdx = -1
        let currentToolIdx = -1
        let inputJsonBuf = ''
        let usage = { input_tokens: 0, output_tokens: 0 }
        let stopReason: string = 'end_turn'

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
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

            let event: Record<string, unknown>
            try { event = JSON.parse(data) } catch { continue }

            switch (event.type) {
              case 'content_block_start': {
                const block = (event as { content_block: { type: string; id?: string; name?: string } }).content_block
                if (block.type === 'text') {
                  contentBlocks.push({ type: 'text', text: '' })
                  currentTextIdx = contentBlocks.length - 1
                  currentToolIdx = -1
                } else if (block.type === 'tool_use') {
                  contentBlocks.push({ type: 'tool_use', id: block.id!, name: block.name!, input: {} })
                  currentToolIdx = contentBlocks.length - 1
                  currentTextIdx = -1
                  inputJsonBuf = ''
                }
                break
              }
              case 'content_block_delta': {
                const delta = (event as { delta: { type: string; text?: string; partial_json?: string } }).delta
                if (delta.type === 'text_delta' && delta.text && currentTextIdx >= 0) {
                  const block = contentBlocks[currentTextIdx] as { type: 'text'; text: string }
                  block.text += delta.text
                  // Stream text chunk to listener
                  if (this.onStreamText) this.onStreamText(delta.text)
                } else if (delta.type === 'input_json_delta' && delta.partial_json && currentToolIdx >= 0) {
                  inputJsonBuf += delta.partial_json
                }
                break
              }
              case 'content_block_stop': {
                if (currentToolIdx >= 0 && inputJsonBuf) {
                  try {
                    (contentBlocks[currentToolIdx] as { input: Record<string, unknown> }).input = JSON.parse(inputJsonBuf)
                  } catch { /* malformed JSON — leave empty */ }
                  inputJsonBuf = ''
                }
                currentTextIdx = -1
                currentToolIdx = -1
                break
              }
              case 'message_delta': {
                const md = event as { delta?: { stop_reason?: string }; usage?: { output_tokens: number } }
                if (md.delta?.stop_reason) stopReason = md.delta.stop_reason
                if (md.usage) usage.output_tokens = md.usage.output_tokens
                break
              }
              case 'message_start': {
                const ms = event as { message?: { usage?: { input_tokens: number } } }
                if (ms.message?.usage) usage.input_tokens = ms.message.usage.input_tokens
                break
              }
            }
          }
        }

        trackUsage(usage)

        return {
          content: contentBlocks,
          usage,
          stop_reason: stopReason as ToolUseResponse['stop_reason'],
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
