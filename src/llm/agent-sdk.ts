/**
 * Tanren — Claude Agent SDK Provider
 *
 * Uses Claude Agent SDK (subscription auth, no API key).
 * Native tool_use + built-in tools (Read/Write/Edit/Bash/Grep/Glob).
 * Same auth as Claude Code — runs on subscription, not API credits.
 *
 * **Identity philosophy:** Tanren's mission is for its agents to eventually
 * surpass Claude Code, not wear its skin. By default, the agent's `systemPrompt`
 * (its soul) fully replaces Claude Code's default persona — the agent IS itself,
 * not Claude Code with extra text appended. Agents that still want to lean on
 * Claude Code's tool-use RLHF tuning can opt in via `identityMode: 'inherit-claude-code'`.
 */

import type { LLMProvider } from '../types.js'

export interface AgentSdkOptions {
  /** Model override (default: determined by Claude Code) */
  model?: string
  /** Budget in USD (default: 30) — replaces maxTurns */
  maxBudgetUsd?: number
  /** Working directory for file operations */
  cwd?: string
  /** Allowed tools (default: all standard tools) */
  allowedTools?: string[]
  /** Additional directories to access beyond cwd */
  additionalDirectories?: string[]
  /**
   * MCP servers to expose to the Agent SDK subprocess. Object format matches
   * Claude Agent SDK's `options.mcpServers` field — each entry is an
   * McpStdioServerConfig / McpSSEServerConfig / McpHttpServerConfig. Use this
   * to give the agent cross-agent communication tools (e.g. pointing at
   * mini-agent's `mcp-agent.json` lets the agent call `agent_chat` /
   * `agent_ask` / `agent_discuss` to talk to Kuro).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers?: Record<string, any>
  /**
   * How the agent's `systemPrompt` (soul) maps onto Claude Agent SDK's preset.
   *
   * - `'override'` (default): the agent's systemPrompt fully replaces Claude Code's
   *   default persona. Use this when your agent has its own identity — research
   *   partner, creative writer, perception-driven agent, anything that isn't a
   *   coding assistant. The agent loses Claude Code's opinionated tool-use
   *   preferences but gains a clean identity layer. Recommended for most tanren agents.
   *
   * - `'inherit-claude-code'`: preserve Claude Code's preset and append the
   *   agent's systemPrompt to it. Use this only when you explicitly want your
   *   agent to inherit Claude Code's "interactive CLI tool for software engineering"
   *   persona and tool-use RLHF tuning (e.g., a coding assistant variant). Note:
   *   this means "You are Claude Code" stays in the system prompt — the agent's
   *   identity is layered on top, not in place of.
   */
  identityMode?: 'override' | 'inherit-claude-code'
}

export function createAgentSdkProvider(opts?: AgentSdkOptions): LLMProvider {
  const identityMode = opts?.identityMode ?? 'override'

  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')

      // Identity layer → options.systemPrompt (NEVER concatenated into prompt).
      // See LLMProvider JSDoc in types.ts for the semantic contract.
      //
      // - 'override' (default): pass systemPrompt as a plain string — this fully
      //   replaces Claude Code's preset. The agent's soul becomes the real system prompt.
      // - 'inherit-claude-code': wrap in preset+append so Claude Code's persona
      //   and tool-tuning are preserved and the agent's soul is appended.
      const systemPromptOption = systemPrompt
        ? (identityMode === 'inherit-claude-code'
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt } }
          : { systemPrompt })
        : {}

      let result = ''

      for await (const message of query({
        prompt: context,
        options: {
          cwd: opts?.cwd ?? process.cwd(),
          additionalDirectories: opts?.additionalDirectories ?? ['/Users'],
          allowedTools: opts?.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
          maxBudgetUsd: opts?.maxBudgetUsd ?? 30,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          ...systemPromptOption,
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.mcpServers ? { mcpServers: opts.mcpServers } : {}),
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
