/**
 * Tanren — Claude CLI Provider
 *
 * Uses the local `claude` CLI installation. No API key needed.
 * This is the default provider — proven in 195 cycles of mini-agent.
 */

import { spawn } from 'node:child_process'
import type { LLMProvider } from '../types.js'

export interface ClaudeCliOptions {
  model?: string
  timeoutMs?: number       // default: 300_000 (5 min)
  cwd?: string             // working directory for claude process
}

export function createClaudeCliProvider(opts?: ClaudeCliOptions): LLMProvider {
  const timeoutMs = opts?.timeoutMs ?? 300_000

  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const prompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\n${context}`
        : context

      const args = ['-p', '--output-format', 'text']
      if (opts?.model) {
        args.push('--model', opts.model)
      }

      return new Promise<string>((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let settled = false

        const child = spawn('claude', args, {
          cwd: opts?.cwd ?? process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // Filter ANTHROPIC_API_KEY — use subscription, not API credits
            ANTHROPIC_API_KEY: undefined,
          },
        })

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            child.kill('SIGTERM')
            reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`))
          }
        }, timeoutMs)

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })

        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })

        child.on('close', (code: number | null) => {
          clearTimeout(timer)
          if (settled) return
          settled = true

          if (code === 0) {
            resolve(stdout.trim())
          } else {
            reject(new Error(
              `Claude CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
            ))
          }
        })

        child.on('error', (err: Error) => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          reject(new Error(`Claude CLI spawn error: ${err.message}`))
        })

        // Write prompt to stdin
        child.stdin.write(prompt)
        child.stdin.end()
      })
    },
  }
}
