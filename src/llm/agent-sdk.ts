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
  /** Budget in USD (default: 5) — replaces maxTurns */
  maxBudgetUsd?: number
  /** Working directory for file operations */
  cwd?: string
  /** Allowed tools (default: all standard tools) */
  allowedTools?: string[]
  /** Additional directories to access beyond cwd */
  additionalDirectories?: string[]
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
          additionalDirectories: opts?.additionalDirectories ?? ['/Users'],
          allowedTools: opts?.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
          maxBudgetUsd: opts?.maxBudgetUsd ?? 5,
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
