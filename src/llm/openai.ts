/**
 * Tanren — OpenAI-Compatible Provider
 *
 * Works with any OpenAI-compatible API (OpenAI, Ollama, omlx, vLLM, LiteLLM, etc).
 * Supports: streaming, native tool_use, tool_choice, parallel_tool_calls,
 * response_format, cost tracking, provider fallback.
 */

import type { LLMProvider, ToolUseLLMProvider, ToolDefinition, ConversationMessage, ContentBlock, ToolUseResponse } from '../types.js'

export type OnStreamText = (text: string) => void

export interface CostTracker {
  totalInputTokens: number
  totalOutputTokens: number
  totalCalls: number
  getCost(inputPricePer1M?: number, outputPricePer1M?: number): number
  reset(): void
}

export interface OpenAIProviderOptions {
  apiKey: string
  model?: string
  maxTokens?: number
  baseUrl?: string
  timeoutMs?: number
  extraBody?: Record<string, unknown>
}

export interface ToolCallOptions {
  /** Force a specific tool, allow auto, or disable tools */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  /** Allow model to call multiple tools in one response */
  parallelToolCalls?: boolean
  /** Force JSON response format */
  responseFormat?: 'text' | 'json_object'
}

export function createOpenAIProvider(opts: OpenAIProviderOptions): ToolUseLLMProvider & {
  activeModel?: string
  onStreamText?: OnStreamText
  cost: CostTracker
  toolCallOptions?: ToolCallOptions
} {
  const defaultModel = opts.model ?? 'gpt-4o'
  const maxTokens = opts.maxTokens ?? 8192
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 1_500_000

  // Cost tracking
  const cost: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCalls: 0,
    getCost(inputPricePer1M = 0, outputPricePer1M = 0) {
      return (this.totalInputTokens / 1_000_000) * inputPricePer1M
        + (this.totalOutputTokens / 1_000_000) * outputPricePer1M
    },
    reset() {
      this.totalInputTokens = 0
      this.totalOutputTokens = 0
      this.totalCalls = 0
    },
  }

  function trackUsage(usage?: { prompt_tokens?: number; completion_tokens?: number }) {
    if (!usage) return
    cost.totalInputTokens += usage.prompt_tokens ?? 0
    cost.totalOutputTokens += usage.completion_tokens ?? 0
    cost.totalCalls++
  }

  function toOpenAITools(tools: ToolDefinition[]) {
    return tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }

  function toOpenAIMessages(messages: ConversationMessage[]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = []
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content })
      } else if (msg.role === 'assistant') {
        const textParts = msg.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        const toolCalls = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        const assistantMsg: Record<string, unknown> = { role: 'assistant' }
        if (textParts.length > 0) assistantMsg.content = textParts.map(t => t.text).join('\n')
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }))
        }
        result.push(assistantMsg)
      } else {
        const toolResults = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content })
          }
        } else {
          const text = msg.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(t => t.text).join('\n')
          result.push({ role: 'user', content: text })
        }
      }
    }
    return result
  }

  const provider: ToolUseLLMProvider & {
    activeModel?: string
    onStreamText?: OnStreamText
    cost: CostTracker
    toolCallOptions?: ToolCallOptions
  } = {
    activeModel: undefined,
    onStreamText: undefined,
    cost,
    toolCallOptions: undefined,

    async think(context: string, systemPrompt: string): Promise<string> {
      const model = provider.activeModel ?? defaultModel
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const streaming = !!provider.onStreamText

      try {
        const messages: Array<{ role: string; content: string }> = []
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
        messages.push({ role: 'user', content: context })

        const body: Record<string, unknown> = {
          model, max_tokens: maxTokens, messages, stream: streaming,
          ...opts.extraBody,
        }
        if (provider.toolCallOptions?.responseFormat === 'json_object') {
          body.response_format = { type: 'json_object' }
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 500)}`)
        }

        if (!streaming) {
          const data = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }
          trackUsage(data.usage)
          return (data.choices[0]?.message?.content ?? '').trim()
        }

        return await parseSSEStream(response, provider.onStreamText, trackUsage)
      } finally {
        clearTimeout(timer)
      }
    },

    async thinkWithTools(
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ): Promise<ToolUseResponse> {
      const model = provider.activeModel ?? defaultModel
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const tcOpts = provider.toolCallOptions

      try {
        const openAIMessages = toOpenAIMessages(messages)
        if (systemPrompt) openAIMessages.unshift({ role: 'system', content: systemPrompt })

        const body: Record<string, unknown> = {
          model, max_tokens: maxTokens, messages: openAIMessages,
          ...opts.extraBody,
        }
        if (tools.length > 0) {
          body.tools = toOpenAITools(tools)
          // tool_choice
          if (tcOpts?.toolChoice) body.tool_choice = tcOpts.toolChoice
          // parallel_tool_calls
          if (tcOpts?.parallelToolCalls !== undefined) body.parallel_tool_calls = tcOpts.parallelToolCalls
        }
        // response_format
        if (tcOpts?.responseFormat === 'json_object') {
          body.response_format = { type: 'json_object' }
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 500)}`)
        }

        const data = await response.json() as {
          choices: Array<{
            message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
            finish_reason: string
          }>
          usage?: { prompt_tokens: number; completion_tokens: number }
        }

        trackUsage(data.usage)
        const choice = data.choices[0]
        const content: ContentBlock[] = []

        if (choice.message.content) {
          content.push({ type: 'text', text: choice.message.content })
        }
        if (choice.message.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tc.function.arguments) } catch { /* malformed */ }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
          }
        }

        const stopReason = choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call'
          ? 'tool_use' as const
          : choice.finish_reason === 'length' ? 'max_tokens' as const
          : 'end_turn' as const

        return {
          content,
          usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
          stop_reason: stopReason,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }

  return provider
}

/** Create a fallback provider: tries primary, falls back to secondary on failure */
export function createFallbackProvider(
  primary: ReturnType<typeof createOpenAIProvider>,
  secondary: LLMProvider,
  label = 'fallback',
): ToolUseLLMProvider & { activeModel?: string; onStreamText?: OnStreamText; cost: CostTracker; toolCallOptions?: ToolCallOptions } {
  return {
    get activeModel() { return primary.activeModel },
    set activeModel(v) { primary.activeModel = v },
    get onStreamText() { return primary.onStreamText },
    set onStreamText(v) { primary.onStreamText = v },
    get cost() { return primary.cost },
    get toolCallOptions() { return primary.toolCallOptions },
    set toolCallOptions(v) { primary.toolCallOptions = v },

    async think(context: string, systemPrompt: string): Promise<string> {
      try {
        return await primary.think(context, systemPrompt)
      } catch (err) {
        console.warn(`[${label}] Primary failed (${err instanceof Error ? err.message : err}), falling back`)
        return secondary.think(context, systemPrompt)
      }
    },

    async thinkWithTools(
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ): Promise<ToolUseResponse> {
      try {
        return await primary.thinkWithTools(messages, systemPrompt, tools)
      } catch (err) {
        console.warn(`[${label}] Primary thinkWithTools failed (${err instanceof Error ? err.message : err}), falling back to text mode`)
        // Fallback to text-only think — caller will parse text tags
        const text = await secondary.think(
          messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n'),
          systemPrompt,
        )
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
        }
      }
    },
  }
}

async function parseSSEStream(
  response: Response,
  onChunk?: OnStreamText,
  onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number }) => void,
): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ''
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
      if (data === '[DONE]') continue

      try {
        const parsed = JSON.parse(data)
        const chunk = parsed.choices?.[0]?.delta?.content
        if (chunk) {
          result += chunk
          onChunk?.(chunk)
        }
        if (parsed.usage) onUsage?.(parsed.usage)
      } catch { /* skip malformed */ }
    }
  }

  return result.trim()
}
