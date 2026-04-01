/**
 * Tanren（鍛錬）— Minimal AI Agent Framework
 *
 * An agent built on Tanren can:
 * 1. Perceive its environment
 * 2. Think and act in a loop
 * 3. Remember across sessions
 * 4. Learn from its own experience
 *
 * 10 lines to configure. <5000 lines total.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLoop, type AgentLoop } from './loop.js'
import type { TanrenConfig, TickResult } from './types.js'

export interface TanrenAgent {
  /** Run one perceive→think→act cycle */
  tick(): Promise<TickResult>
  /** Start the autonomous loop */
  start(interval?: number): void
  /** Stop the loop gracefully */
  stop(): void
  /** Is the loop running? */
  isRunning(): boolean
  /** Recent tick history */
  getRecentTicks(): TickResult[]
}

export function createAgent(config: TanrenConfig): TanrenAgent {
  // Resolve paths relative to workDir
  const workDir = config.workDir ?? process.cwd()
  const memoryDir = resolve(workDir, config.memoryDir)

  // Ensure memory directory structure exists
  ensureDir(memoryDir)
  ensureDir(resolve(memoryDir, 'topics'))
  ensureDir(resolve(memoryDir, 'daily'))
  ensureDir(resolve(memoryDir, 'state'))

  // Resolve identity path
  const identity = config.identity.includes('/')
    ? resolve(workDir, config.identity)
    : config.identity

  // Create the loop with resolved config
  const loop = createLoop({
    ...config,
    workDir,
    memoryDir,
    identity,
  })

  return {
    tick: () => loop.tick(),
    start: (interval) => loop.start(interval ?? config.tickInterval),
    stop: () => loop.stop(),
    isRunning: () => loop.isRunning(),
    getRecentTicks: () => loop.getRecentTicks(),
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// === Re-exports ===

// Core types
export type {
  TanrenConfig,
  TickResult,
  Action,
  Observation,
  Gate,
  GateContext,
  GateResult,
  MemorySystem,
  MemoryReader,
  SearchResult,
  LLMProvider,
  ToolUseLLMProvider,
  ToolDefinition,
  ConversationMessage,
  ContentBlock,
  ToolUseResponse,
  PerceptionPlugin,
  ActionHandler,
  ActionContext,
  RiskTier,
} from './types.js'

// Modules
export { createMemorySystem, listMemoryFiles } from './memory.js'
export { createPerception, type PerceptionSystem } from './perception.js'
export { createGateSystem, defineGate, createOutputGate, createAnalysisWithoutActionGate, createSymptomFixGate, type GateSystem, type GateSpec } from './gates.js'
export { createActionRegistry, builtinActions, getRiskTier, getRoundRiskTier, type ActionRegistry } from './actions.js'
export { createLoop, type AgentLoop } from './loop.js'

// LLM Providers
export { createClaudeCliProvider, type ClaudeCliOptions } from './llm/claude-cli.js'
export { createAnthropicProvider, type AnthropicProviderOptions } from './llm/anthropic.js'
export { createOpenAIProvider, createFallbackProvider, type OpenAIProviderOptions, type ToolCallOptions, type CostTracker } from './llm/openai.js'

// Working Memory
export { createWorkingMemory, type WorkingMemorySystem } from './working-memory.js'

// Learning System
export {
  createLearningSystem,
  createCrystallization,
  createSelfPerception,
  type LearningSystem,
  type LearningResult,
  type CrystallizationEngine,
  type Pattern,
  type PatternType,
  type SelfPerceptionEngine,
  type ObservationAssessment,
  type QualityTrend,
} from './learning/index.js'
