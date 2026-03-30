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

export function createAnthropicProvider(opts: AnthropicProviderOptions): ToolUseLLMProvider & { cost: CostTracker } {
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

    // Native tool use interface
    async thinkWithTools(
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ): Promise<ToolUseResponse> {
      const body: Record<string, unknown> = {
        system: systemPrompt || undefined,
        messages,
      }

      if (tools.length > 0) {
        body.tools = tools
      }

      const data = await callApi(body)

      return {
        content: data.content.map(block => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text! }
          }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: block.id!,
              name: block.name!,
              input: block.input ?? {},
            }
          }
          // Shouldn't happen, but handle gracefully
          return { type: 'text' as const, text: JSON.stringify(block) }
        }),
        usage: data.usage,
        stop_reason: data.stop_reason as ToolUseResponse['stop_reason'],
      }
    },
  }
}
