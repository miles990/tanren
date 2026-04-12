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
  /** Budget in USD per tick (default: 5). Controls token spend. */
  maxBudgetUsd?: number
  /** Max assistant turns (Agent SDK's soft hint). Default: 20. */
  maxTurns?: number
  /** Max tool calls hard limit via PreToolUse hook. Default: maxTurns * 2.
   *  This is the REAL enforced limit — Agent SDK's maxTurns is unreliable,
   *  and canUseTool only fires for "dangerous" ops in default mode. */
  maxToolCalls?: number
  /** Wall-clock timeout in ms (default: 300000 = 5min). Hard stop safety net. */
  timeoutMs?: number
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
  const timeoutMs = opts?.timeoutMs ?? 300_000 // 5 min wall-clock safety net

  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')

      const systemPromptOption = systemPrompt
        ? (identityMode === 'inherit-claude-code'
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt } }
          : { systemPrompt })
        : {}

      let result = ''
      const maxTurns = opts?.maxTurns ?? 20
      const maxToolCalls = opts?.maxToolCalls ?? (maxTurns * 2)  // hard limit: ~2 tool calls per turn

      // Wall-clock timeout: hard stop regardless of what Agent SDK is doing.
      const abortController = new AbortController()
      const timer = setTimeout(() => {
        console.error(`[agent-sdk] TIMEOUT: ${timeoutMs}ms exceeded — aborting query`)
        abortController.abort()
      }, timeoutMs)

      // PreToolUse hook: fires on EVERY tool call regardless of permissionMode.
      // canUseTool only fires for "dangerous" ops in default mode (e.g. Bash `ls` is
      // auto-allowed and never hits the callback). PreToolUse is the real chokepoint.
      let toolCallCount = 0
      const preToolUseHook = async (input: { tool_name: string; tool_input: unknown }) => {
        toolCallCount++
        const preview = JSON.stringify(input.tool_input).slice(0, 100)
        console.error(`[agent-sdk] tool[${toolCallCount}/${maxToolCalls}] ${input.tool_name} — ${preview}`)
        if (toolCallCount > maxToolCalls) {
          console.error(`[agent-sdk] HARD LIMIT: tool call ${toolCallCount} > ${maxToolCalls} — denying`)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Tool call limit reached (${maxToolCalls}). Wrap up and respond with current findings.`,
            },
          }
        }
        return {}
      }

      try {
        let turns = 0
        const start = Date.now()

        for await (const message of query({
          prompt: context,
          options: {
            cwd: opts?.cwd ?? process.cwd(),
            additionalDirectories: opts?.additionalDirectories ?? ['/Users'],
            allowedTools: opts?.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
            maxTurns,
            maxBudgetUsd: opts?.maxBudgetUsd ?? 5,
            permissionMode: 'bypassPermissions',  // hooks fire regardless; bypass removes friction on allowed tools
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            hooks: { PreToolUse: [{ hooks: [preToolUseHook as any] }] },
            abortController,
            ...systemPromptOption,
            ...(opts?.model ? { model: opts.model } : {}),
            ...(opts?.mcpServers ? { mcpServers: opts.mcpServers } : {}),
          },
        })) {
          if ('result' in message) {
            result = message.result
          } else if (typeof message === 'object' && message !== null && 'type' in message) {
            const msgType = (message as Record<string, unknown>).type as string
            // Count only actual LLM turns (assistant messages), not every internal message
            if (msgType === 'assistant') turns++
          }
        }

        const totalMs = Date.now() - start
        console.error(`[agent-sdk] completed: ${turns} turns, ${toolCallCount} tool calls in ${Math.round(totalMs / 1000)}s`)
      } finally {
        clearTimeout(timer)
      }

      return result
    },
  }
}
