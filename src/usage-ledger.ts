/**
 * Tanren — LLM Usage Ledger
 *
 * Lightweight provider wrapper that records every LLM call to disk. This is
 * intentionally outside individual providers so Agent SDK, Claude CLI,
 * Anthropic API, and OpenAI-compatible providers can share one audit path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider, ToolUseLLMProvider, ToolUseResponse } from './types.js'

export interface UsageLedgerOptions {
  stateDir: string
  provider: string
  model?: string
  cloud?: boolean
}

export interface UsageRecord {
  ts: string
  provider: string
  model?: string
  cloud: boolean
  method: 'think' | 'thinkWithTools'
  ok: boolean
  durationMs: number
  inputTokens: number
  outputTokens: number
  error?: string
}

interface CostLike {
  totalInputTokens: number
  totalOutputTokens: number
  totalCalls: number
}

function readCost(provider: unknown): CostLike | null {
  const cost = (provider as { cost?: CostLike }).cost
  if (!cost) return null
  return {
    totalInputTokens: cost.totalInputTokens ?? 0,
    totalOutputTokens: cost.totalOutputTokens ?? 0,
    totalCalls: cost.totalCalls ?? 0,
  }
}

function tokenDelta(before: CostLike | null, after: CostLike | null): { inputTokens: number; outputTokens: number } {
  if (!before || !after) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: Math.max(0, after.totalInputTokens - before.totalInputTokens),
    outputTokens: Math.max(0, after.totalOutputTokens - before.totalOutputTokens),
  }
}

function writeUsageRecord(opts: UsageLedgerOptions, record: UsageRecord): void {
  try {
    mkdirSync(opts.stateDir, { recursive: true })
    appendFileSync(join(opts.stateDir, 'llm-usage.jsonl'), JSON.stringify(record) + '\n', 'utf-8')

    const summaryPath = join(opts.stateDir, 'llm-usage-summary.json')
    const today = record.ts.slice(0, 10)
    let summary: Record<string, {
      date: string
      calls: number
      failed: number
      inputTokens: number
      outputTokens: number
      durationMs: number
      cloudCalls: number
    }> = {}
    if (existsSync(summaryPath)) {
      try { summary = JSON.parse(readFileSync(summaryPath, 'utf-8')) } catch { summary = {} }
    }

    const key = `${today}:${record.provider}`
    const current = summary[key] ?? {
      date: today,
      calls: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      cloudCalls: 0,
    }
    current.calls++
    if (!record.ok) current.failed++
    current.inputTokens += record.inputTokens
    current.outputTokens += record.outputTokens
    current.durationMs += record.durationMs
    if (record.cloud) current.cloudCalls++
    summary[key] = current

    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')
  } catch {
    // Usage telemetry must never break the agent loop.
  }
}

function inferModel(provider: unknown, fallback?: string): string | undefined {
  const activeModel = (provider as { activeModel?: string }).activeModel
  return activeModel || fallback
}

export function wrapProviderWithUsageLedger<T extends LLMProvider>(provider: T, opts: UsageLedgerOptions): T {
  const target = provider as T & Partial<ToolUseLLMProvider>

  const wrappedThink = async (context: string, systemPrompt: string): Promise<string> => {
    const start = Date.now()
    const before = readCost(target)
    try {
      const result = await target.think(context, systemPrompt)
      const tokens = tokenDelta(before, readCost(target))
      writeUsageRecord(opts, {
        ts: new Date().toISOString(),
        provider: opts.provider,
        model: inferModel(target, opts.model),
        cloud: opts.cloud ?? true,
        method: 'think',
        ok: true,
        durationMs: Date.now() - start,
        ...tokens,
      })
      return result
    } catch (err) {
      const tokens = tokenDelta(before, readCost(target))
      writeUsageRecord(opts, {
        ts: new Date().toISOString(),
        provider: opts.provider,
        model: inferModel(target, opts.model),
        cloud: opts.cloud ?? true,
        method: 'think',
        ok: false,
        durationMs: Date.now() - start,
        ...tokens,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      })
      throw err
    }
  }

  const wrappedThinkWithTools = async (
    messages: Parameters<ToolUseLLMProvider['thinkWithTools']>[0],
    systemPrompt: string,
    tools: Parameters<ToolUseLLMProvider['thinkWithTools']>[2],
  ): Promise<ToolUseResponse> => {
    const start = Date.now()
    const before = readCost(target)
    try {
      const result = await target.thinkWithTools!(messages, systemPrompt, tools)
      const tokens = result.usage
        ? { inputTokens: result.usage.input_tokens ?? 0, outputTokens: result.usage.output_tokens ?? 0 }
        : tokenDelta(before, readCost(target))
      writeUsageRecord(opts, {
        ts: new Date().toISOString(),
        provider: opts.provider,
        model: inferModel(target, opts.model),
        cloud: opts.cloud ?? true,
        method: 'thinkWithTools',
        ok: true,
        durationMs: Date.now() - start,
        ...tokens,
      })
      return result
    } catch (err) {
      const tokens = tokenDelta(before, readCost(target))
      writeUsageRecord(opts, {
        ts: new Date().toISOString(),
        provider: opts.provider,
        model: inferModel(target, opts.model),
        cloud: opts.cloud ?? true,
        method: 'thinkWithTools',
        ok: false,
        durationMs: Date.now() - start,
        ...tokens,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      })
      throw err
    }
  }

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'think') return wrappedThink
      if (prop === 'thinkWithTools' && typeof obj.thinkWithTools === 'function') return wrappedThinkWithTools
      return Reflect.get(obj, prop, receiver)
    },
    set(obj, prop, value, receiver) {
      return Reflect.set(obj, prop, value, receiver)
    },
  }) as T
}
