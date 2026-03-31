/**
 * Tanren — OpenAI-Compatible Provider
 *
 * Works with any OpenAI-compatible API (OpenAI, Ollama, omlx, vLLM, LiteLLM, etc).
 * Supports streaming and native tool_use.
 */

import type { LLMProvider, ToolUseLLMProvider, ToolDefinition, ConversationMessage, ContentBlock, ToolUseResponse } from '../types.js'

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

export function createOpenAIProvider(opts: OpenAIProviderOptions): ToolUseLLMProvider & { activeModel?: string; onStreamText?: OnStreamText } {
  const defaultModel = opts.model ?? 'gpt-4o'
  const maxTokens = opts.maxTokens ?? 8192
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 1_500_000

  /** Convert Anthropic-style ToolDefinition to OpenAI tools format */
  function toOpenAITools(tools: ToolDefinition[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  /** Convert Anthropic ConversationMessage to OpenAI messages format */
  function toOpenAIMessages(messages: ConversationMessage[]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = []
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content })
      } else {
        // Convert content blocks
        if (msg.role === 'assistant') {
          // Assistant message with tool calls
          const textParts = msg.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          const toolCalls = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
          const assistantMsg: Record<string, unknown> = { role: 'assistant' }
          if (textParts.length > 0) assistantMsg.content = textParts.map(t => t.text).join('\n')
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
          }
          result.push(assistantMsg)
        } else {
          // User message — could have tool_results
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
    }
    return result
  }

  const provider: ToolUseLLMProvider & { activeModel?: string; onStreamText?: OnStreamText } = {
    activeModel: undefined,
    onStreamText: undefined,

    async think(context: string, systemPrompt: string): Promise<string> {
      const model = provider.activeModel ?? defaultModel
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const streaming = !!provider.onStreamText

      try {
        const messages: Array<{ role: string; content: string }> = []
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
        messages.push({ role: 'user', content: context })

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model, max_tokens: maxTokens, messages, stream: streaming,
            ...opts.extraBody,
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 500)}`)
        }

        if (!streaming) {
          const data = await response.json() as { choices: Array<{ message: { content: string } }> }
          return (data.choices[0]?.message?.content ?? '').trim()
        }

        // Streaming SSE
        return await parseSSEStream(response, provider.onStreamText)
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

      try {
        const openAIMessages = toOpenAIMessages(messages)
        if (systemPrompt) openAIMessages.unshift({ role: 'system', content: systemPrompt })

        const body: Record<string, unknown> = {
          model,
          max_tokens: maxTokens,
          messages: openAIMessages,
          ...opts.extraBody,
        }
        if (tools.length > 0) {
          body.tools = toOpenAITools(tools)
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 500)}`)
        }

        const data = await response.json() as {
          choices: Array<{
            message: {
              content?: string
              tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
            }
            finish_reason: string
          }>
          usage?: { prompt_tokens: number; completion_tokens: number }
        }

        const choice = data.choices[0]
        const content: ContentBlock[] = []

        // Text content
        if (choice.message.content) {
          content.push({ type: 'text', text: choice.message.content })
        }

        // Tool calls → convert to Anthropic format
        if (choice.message.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tc.function.arguments) } catch { /* malformed */ }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            })
          }
        }

        // Map finish_reason
        const stopReason = choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call'
          ? 'tool_use' as const
          : choice.finish_reason === 'length' ? 'max_tokens' as const
          : 'end_turn' as const

        return {
          content,
          usage: {
            input_tokens: data.usage?.prompt_tokens ?? 0,
            output_tokens: data.usage?.completion_tokens ?? 0,
          },
          stop_reason: stopReason,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }

  return provider
}

/** Parse OpenAI SSE stream, return full text */
async function parseSSEStream(response: Response, onChunk?: OnStreamText): Promise<string> {
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
        const parsed = JSON.parse(data) as {
          choices: Array<{ delta: { content?: string } }>
        }
        const chunk = parsed.choices[0]?.delta?.content
        if (chunk) {
          result += chunk
          onChunk?.(chunk)
        }
      } catch { /* skip malformed */ }
    }
  }

  return result.trim()
}
