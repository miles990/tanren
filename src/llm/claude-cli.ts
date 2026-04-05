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
}

export function createClaudeCliProvider(opts?: ClaudeCliOptions): LLMProvider {
  // CLI provider is text-only (no native tool_use without MCP server).
  // Loop's text-based feedback path handles action parsing from <action:type> tags.
  const timeoutMs = opts?.timeoutMs ?? 1_500_000

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
      const prompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${context}` : context
      const args = ['-p', '--output-format', 'text']
      if (opts?.model) args.push('--model', opts.model)
      return runClaude(prompt, args)
    },

    // CLI is text-only — loop.ts handles action parsing via text-based feedback path.
    // Native tool_use requires MCP server or Anthropic API, not available in bare CLI.
  }
}
