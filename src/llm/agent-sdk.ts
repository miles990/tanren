/**
 * Tanren — Claude Agent SDK Provider
 *
 * Uses Claude Agent SDK (subscription auth, no API key).
 * Native tool_use + built-in tools (Read/Write/Edit/Bash/Grep/Glob).
 * Same auth as Claude Code — runs on subscription, not API credits.
 *
 * This gives Tanren the best of both worlds:
 * - Tanren's harness (perception, gates, learning, modes)
 * - Agent SDK's execution engine (native tool_use, subscription auth)
 */

import type { LLMProvider } from '../types.js'

export interface AgentSdkOptions {
  /** Model override (default: determined by Claude Code) */
  model?: string
  /** Maximum agent turns (default: 10) */
  maxTurns?: number
  /** Working directory for file operations */
  cwd?: string
  /** Allowed tools (default: ['Read', 'Grep', 'Glob']) */
  allowedTools?: string[]
}

export function createAgentSdkProvider(opts?: AgentSdkOptions): LLMProvider {
  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')

      const prompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\n${context}`
        : context

      let result = ''

      for await (const message of query({
        prompt,
        options: {
          cwd: opts?.cwd ?? process.cwd(),
          allowedTools: opts?.allowedTools ?? ['Read', 'Grep', 'Glob', 'Bash'],
          maxTurns: opts?.maxTurns ?? 10,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          ...(opts?.model ? { model: opts.model } : {}),
        },
      })) {
        if ('result' in message) {
          result = message.result
        }
      }

      return result
    },
  }
}
