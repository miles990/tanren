/**
 * Tanren — Anthropic Managed Agent Provider
 *
 * Cloud-hosted agentic execution through Anthropic Messages API containers.
 * This provider is opt-in and requires `ANTHROPIC_API_KEY`.
 */

import type { LLMProvider, Prompt } from '../types.js'
import { extractAnthropicOutputs, toAnthropic } from '../content-adapter.js'
import { MANAGED_AGENT_CAPABILITIES } from '../provider-capabilities.js'

export interface ManagedAgentProviderOptions {
  model?: string
  containerId?: string
  skills?: Array<{ skillId: string; type: 'anthropic' | 'custom'; version?: string }>
  tools?: Array<
    | { type: 'code_execution'; version?: string }
    | { type: 'web_search'; version?: string }
    | { type: 'mcp'; name: string; url: string; authorizationToken?: string }
  >
  maxTokens?: number
  apiKey?: string
  baseUrl?: string
  betas?: string[]
}

interface ApiContentBlock {
  type: string
  text?: string
}

interface ApiResponse {
  content: ApiContentBlock[]
  usage?: { input_tokens: number; output_tokens: number }
  container?: { id: string; expires_at?: string }
}

export function createManagedAgentProvider(opts?: ManagedAgentProviderOptions): LLMProvider {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY
  const baseUrl = (opts?.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const model = opts?.model ?? 'claude-sonnet-4-6'
  const maxTokens = opts?.maxTokens ?? 16384
  const betas = opts?.betas ?? ['code-execution-2025-05-22', 'skills-2025-10-02']
  let activeContainerId = opts?.containerId

  const tools = (opts?.tools ?? [{ type: 'code_execution' as const }, { type: 'web_search' as const }])
    .map(tool => {
      if (tool.type === 'code_execution') return { name: 'code_execution', type: tool.version ?? 'code_execution_20260120' }
      if (tool.type === 'web_search') return { name: 'web_search', type: tool.version ?? 'web_search_20250305' }
      return {
        type: 'url',
        name: tool.name,
        url: tool.url,
        ...(tool.authorizationToken ? { authorization_token: tool.authorizationToken } : {}),
      }
    })

  return {
    capabilities: MANAGED_AGENT_CAPABILITIES,

    async think(context: string, systemPrompt: string): Promise<string> {
      return (await this.thinkStructured!(context, systemPrompt)).text
    },

    async thinkStructured(prompt: Prompt, systemPrompt: string) {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set for Managed Agent provider')

      const container = activeContainerId || opts?.skills
        ? {
            ...(activeContainerId ? { id: activeContainerId } : {}),
            ...(opts?.skills ? {
              skills: opts.skills.map(skill => ({
                skill_id: skill.skillId,
                type: skill.type,
                ...(skill.version ? { version: skill.version } : {}),
              })),
            } : {}),
          }
        : undefined

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...(betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: typeof prompt === 'string' ? prompt : toAnthropic(prompt) }],
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(container ? { container } : {}),
        }),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Managed Agent API ${response.status}: ${text.slice(0, 300)}`)
      }

      const data = await response.json() as ApiResponse
      if (data.container?.id) activeContainerId = data.container.id
      return {
        text: data.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n'),
        outputs: extractAnthropicOutputs(data.content as unknown as Array<Record<string, unknown>>),
        metadata: { model, usage: data.usage, containerId: activeContainerId },
      }
    },

    async *thinkStream(prompt: Prompt, systemPrompt: string) {
      if (!apiKey) {
        yield { type: 'error', error: 'ANTHROPIC_API_KEY not set for Managed Agent provider' }
        return
      }
      try {
        const response = await this.thinkStructured!(prompt, systemPrompt)
        if (response.text) yield { type: 'text_delta', text: response.text }
        for (const output of response.outputs ?? []) yield { type: 'content_block', content: output }
        yield { type: 'done', metadata: response.metadata }
      } catch (err) {
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
