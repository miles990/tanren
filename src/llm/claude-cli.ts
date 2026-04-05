/**
 * Tanren — Claude CLI Provider
 *
 * Uses the local `claude` CLI installation. No API key needed.
 * Supports native tool_use via --output-format stream-json.
 * Forged from Claude Code's agent.ts pattern (proven in 5000+ cycles).
 */

import { spawn } from 'node:child_process'
import type { LLMProvider, ToolUseLLMProvider, ToolDefinition, ConversationMessage, ToolUseResponse, ContentBlock } from '../types.js'

export interface ClaudeCliOptions {
  model?: string
  timeoutMs?: number       // default: 1_500_000 (25 min)
  cwd?: string             // working directory for claude process
}

export function createClaudeCliProvider(opts?: ClaudeCliOptions): ToolUseLLMProvider {
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

    // Native tool_use via stream-json — makes CLI behave identically to API
    async thinkWithTools(
      messages: ConversationMessage[],
      systemPrompt: string,
      tools: ToolDefinition[],
    ): Promise<ToolUseResponse> {
      // Build prompt: system + conversation history
      // CLI doesn't have native multi-turn, so we flatten into a single prompt
      const conversationParts: string[] = []
      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          conversationParts.push(msg.content)
        } else {
          // Flatten content blocks (tool_results from previous rounds)
          for (const block of msg.content) {
            if (block.type === 'text') {
              conversationParts.push(block.text)
            } else if (block.type === 'tool_result') {
              conversationParts.push(`<tool-result tool_use_id="${block.tool_use_id}">\n${block.content}\n</tool-result>`)
            }
          }
        }
      }

      // Inject tool definitions into system prompt (CLI doesn't have native tool schema)
      const toolDescriptions = tools.map(t => {
        const params = Object.entries(t.input_schema.properties || {})
          .map(([k, v]) => `  - ${k}: ${(v as { description?: string }).description || ''}`)
          .join('\n')
        const required = t.input_schema.required?.join(', ') || ''
        return `### ${t.name}\n${t.description}\nParameters:\n${params}${required ? `\nRequired: ${required}` : ''}`
      }).join('\n\n')

      const fullSystemPrompt = `${systemPrompt}\n\n## Available Tools\n\nCall tools using JSON: {"tool": "name", "input": {...}}\nYou may call multiple tools. Output each on its own line.\n\n${toolDescriptions}`
      const prompt = `${fullSystemPrompt}\n\n---\n\n${conversationParts.join('\n\n')}`

      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (opts?.model) args.push('--model', opts.model)

      const raw = await runClaude(prompt, args)

      // Parse stream-json events → extract text + tool_use blocks
      const content: ContentBlock[] = []
      const textParts: string[] = []

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                textParts.push(block.text)
              } else if (block.type === 'tool_use') {
                content.push({
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                })
              }
            }
          }
          // Also handle content_block_delta for streaming text
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            textParts.push(event.delta.text)
          }
        } catch {
          // Non-JSON line — skip
        }
      }

      // If no structured tool_use found, parse text for action tags (fallback)
      if (content.length === 0 || textParts.length > 0) {
        const fullText = textParts.join('')
        if (fullText.trim()) {
          content.unshift({ type: 'text', text: fullText })
        }
      }

      return {
        content,
        usage: { input_tokens: 0, output_tokens: 0 }, // CLI doesn't report usage
        stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      }
    },
  }
}
