/**
 * Tanren — Codex CLI Provider
 *
 * Uses `codex exec` as a non-interactive LLM backend. This is intentionally
 * text-only: Tanren still owns action parsing, gates, memory, and feedback.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { LLMProvider, Prompt } from '../types.js'
import { promptToText } from '../content-adapter.js'

export interface CodexCliOptions {
  model?: string
  profile?: string
  timeoutMs?: number
  cwd?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  oss?: boolean
  localProvider?: 'lmstudio' | 'ollama'
}

export function createCodexCliProvider(opts?: CodexCliOptions): LLMProvider {
  const timeoutMs = opts?.timeoutMs ?? 300_000

  function runCodex(prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'tanren-codex-'))
      const outputPath = join(tempDir, 'last-message.txt')
      const args = [
        'exec',
        '--cd', opts?.cwd ?? process.cwd(),
        '--sandbox', opts?.sandbox ?? 'read-only',
        '--ask-for-approval', 'never',
        '--output-last-message', outputPath,
        '--color', 'never',
      ]
      if (opts?.model) args.push('--model', opts.model)
      if (opts?.profile) args.push('--profile', opts.profile)
      if (opts?.oss) args.push('--oss')
      if (opts?.localProvider) args.push('--local-provider', opts.localProvider)
      args.push('-')

      let stdout = ''
      let stderr = ''
      let settled = false
      const child = spawn('codex', args, {
        cwd: opts?.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      })

      const cleanup = () => {
        try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGTERM')
          cleanup()
          reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        try {
          const final = readFileSync(outputPath, 'utf-8').trim()
          cleanup()
          if (code === 0) {
            resolve(final || stdout.trim())
          } else {
            reject(new Error(`Codex CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`))
          }
        } catch (err) {
          cleanup()
          if (code === 0 && stdout.trim()) {
            resolve(stdout.trim())
          } else {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`Codex CLI spawn error: ${err.message}`))
      })

      child.stdin.write(prompt)
      child.stdin.end()
    })
  }

  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      const prompt = systemPrompt
        ? `<system>\n${systemPrompt}\n</system>\n\n<context>\n${context}\n</context>`
        : context
      return runCodex(prompt)
    },
    async thinkStructured(prompt: Prompt, systemPrompt: string) {
      return { text: await this.think(promptToText(prompt), systemPrompt), metadata: { degradedToText: true } }
    },
  }
}
