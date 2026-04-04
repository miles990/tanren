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
import type { TanrenConfig, TickResult, ChatResult } from './types.js'

export interface TanrenAgent {
  /** Run one perceive→think→act cycle */
  tick(): Promise<TickResult>
  /** Send a message and get a response — injects message, runs tick, extracts response */
  chat(message: string, options?: { from?: string }): Promise<ChatResult>
  /** Run a self-paced chain — agent decides when to stop */
  runChain(message?: string, options?: { from?: string }): Promise<TickResult[]>
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
    async chat(message: string, options?: { from?: string }): Promise<ChatResult> {
      const from = options?.from ?? 'user'
      loop.injectMessage(from, message)
      const result = await loop.tick()
      // Extract response: prefer action:respond content, fallback to thought
      const respondAction = result.actions.find(a => a.type === 'respond')
      const response = respondAction?.content ?? ''
      return {
        response,
        thought: result.thought,
        actions: result.actions.map(a => a.type),
        duration: result.observation.duration,
        quality: result.observation.outputQuality,
      }
    },
    async runChain(message?: string, options?: { from?: string }): Promise<TickResult[]> {
      if (message) {
        loop.injectMessage(options?.from ?? 'user', message)
      }
      return loop.runChain()
    },
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
  ChatResult,
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
export { createGateSystem, defineGate, createOutputGate, createAnalysisWithoutActionGate, createProductivityGate, createSymptomFixGate, type GateSystem, type GateSpec } from './gates.js'
export { createActionRegistry, builtinActions, getRiskTier, getRoundRiskTier, type ActionRegistry } from './actions.js'
export { createLoop, type AgentLoop } from './loop.js'

// Multi-task
export { createTaskGraph, type TaskGraph, type Task, type TaskResult } from './task-graph.js'
export { createThreadContext, type ThreadContext } from './thread-context.js'
export { executeBatch, type BatchResult } from './action-batch.js'

// Causal Context
export { createContextMesh, createMeshPerception, createMeshAction, type ContextMesh, type ContextNode, type ContextEdge } from './context-mesh.js'

// LLM Providers
export { createClaudeCliProvider, type ClaudeCliOptions } from './llm/claude-cli.js'
export { createAnthropicProvider, type AnthropicProviderOptions } from './llm/anthropic.js'
export { createOpenAIProvider, createFallbackProvider, type OpenAIProviderOptions, type ToolCallOptions, type CostTracker } from './llm/openai.js'

// Working Memory
export { createWorkingMemory, type WorkingMemorySystem } from './working-memory.js'

// Plan System
export { createPlanSystem, loadPlans, parsePlan, type Plan, type PlanStep } from './plans.js'

// Action Health
export { createActionHealthTracker } from './action-health.js'

// Metacognitive Perception Layer
export { createMPL } from './metacognitive.js'

// Self-Paced Continuation
export { createContinuationSystem, type ChainState } from './continuation.js'

// Context Modes
export { detectContextMode, getModeConfig, type ContextMode, type ContextModeConfig } from './context-modes.js'

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
