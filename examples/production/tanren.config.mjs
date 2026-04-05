/**
 * Production Tanren config — full capabilities.
 * Anthropic API with learning, skills, hooks, and quality enforcement.
 *
 * Prerequisites:
 *   cp ../../.env.example .env
 *   # Set ANTHROPIC_API_KEY in .env
 *
 * Usage:
 *   npx tanren serve --port 3002
 *   npx tanren health --port 3002
 */

// Load .env
import { readFileSync, existsSync } from 'node:fs'
const envPath = '.env'
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
}

// LLM Provider — auto-detect from environment
const { createAnthropicProvider, createClaudeCliProvider, createOpenAIProvider, createFallbackProvider,
        createOutputGate, createAnalysisWithoutActionGate, createProductivityGate, createSymptomFixGate,
        createAutoVerifyHook,
} = await import('../../dist/index.js')

let llm = undefined
const apiKey = process.env.ANTHROPIC_API_KEY
const llmProvider = process.env.LLM_PROVIDER

if (apiKey) {
  llm = createAnthropicProvider({ apiKey, model: 'claude-sonnet-4-6', maxTokens: 32768 })
} else if (llmProvider === 'omlx') {
  const primary = createOpenAIProvider({
    apiKey: process.env.LOCAL_LLM_KEY || 'local',
    baseUrl: `${process.env.LOCAL_LLM_URL || 'http://localhost:8000'}/v1`,
    model: process.env.LOCAL_LLM_MODEL || 'Qwen3.5-4B-MLX-4bit',
    maxTokens: 4096,
  })
  llm = createFallbackProvider(primary, createClaudeCliProvider(), 'omlx→cli')
}
// else: undefined → default Claude CLI

export default {
  identity: './soul.md',
  memoryDir: './memory',
  skillsDir: './skills',
  llm,

  gates: [
    createOutputGate(3),
    createAnalysisWithoutActionGate(2),
    createProductivityGate(3),
    createSymptomFixGate(5),
  ],

  hooks: [
    // Auto-verify TypeScript after edits
    createAutoVerifyHook('npx tsc --noEmit 2>&1 | head -20'),
  ],

  feedbackRounds: 25,
  toolDegradation: false,  // capable models self-regulate

  learning: {
    enabled: true,
    selfPerception: true,
    crystallization: true,
    antiGoodhart: true,
  },
}
