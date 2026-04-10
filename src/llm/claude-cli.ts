/**
 * Tanren — Claude CLI Provider
 *
 * Uses the local `claude` CLI installation. No API key needed.
 * Supports native tool_use via --output-format stream-json.
 * Forged from Claude Code's agent.ts pattern (proven in 5000+ cycles).
 */

import { spawn } from 'node:child_process'
import type { LLMProvider } from '../types.js'

export interface ClaudeCliOptions {
  model?: string
  timeoutMs?: number       // default: 1_500_000 (25 min)
  cwd?: string             // working directory for claude process
  /**
   * How the agent's `systemPrompt` (soul) maps onto Claude CLI's flags.
   *
   * - `'override'` (default): use `--system-prompt` to fully replace Claude Code's
   *   default persona. The agent's soul IS the system prompt. Use this when your
   *   agent has its own identity (research, creative, perception-driven, etc.).
   *   Recommended for most tanren agents — aligns with tanren's mission that
   *   agents should surpass Claude Code, not wear its skin.
   *
   * - `'inherit-claude-code'`: use `--append-system-prompt` to preserve Claude
   *   Code's persona and tool-use tuning, with the agent's soul appended. Use
   *   this only when your agent explicitly wants to inherit Claude Code's
   *   "interactive CLI tool for software engineering" framing.
   */
  identityMode?: 'override' | 'inherit-claude-code'
}

export function createClaudeCliProvider(opts?: ClaudeCliOptions): LLMProvider {
  // CLI provider is text-only (no native tool_use without MCP server).
  // Loop's text-based feedback path handles action parsing from <action:type> tags.
  const timeoutMs = opts?.timeoutMs ?? 1_500_000
  const identityMode = opts?.identityMode ?? 'override'

  // Shared subprocess runner
  function runClaude(prompt: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false

      const child = spawn('claude', args, {
        cwd: opts?.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined, // use subscription, not API credits
        },
      })

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGTERM')
          reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Claude CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`))
        }
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(new Error(`Claude CLI spawn error: ${err.message}`))
      })

      child.stdin.write(prompt)
      child.stdin.end()
    })
  }

  return {
    // Legacy text-only interface
    async think(context: string, systemPrompt: string): Promise<string> {
      // Identity layer → --system-prompt (override) or --append-system-prompt (inherit).
      // NEVER concatenated into the prompt/stdin body — that would demote identity
      // to user input. See LLMProvider JSDoc in types.ts for the semantic contract.
      const args = ['-p', '--output-format', 'text']
      if (systemPrompt) {
        const flag = identityMode === 'inherit-claude-code'
          ? '--append-system-prompt'
          : '--system-prompt'
        args.push(flag, systemPrompt)
      }
      if (opts?.model) args.push('--model', opts.model)
      return runClaude(context, args)
    },

    // CLI is text-only — loop.ts handles action parsing via text-based feedback path.
    // Native tool_use requires MCP server or Anthropic API, not available in bare CLI.
  }
}
