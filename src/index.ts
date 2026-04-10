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
  /** Send a message and get a response — injects message, runs tick, extracts response.
   *  Optional onStream callback receives text chunks during LLM think phase. */
  chat(message: string, options?: { from?: string; onStream?: (text: string) => void }): Promise<ChatResult>
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
    async chat(message: string, options?: { from?: string; onStream?: (text: string) => void }): Promise<ChatResult> {
      const from = options?.from ?? 'user'
      loop.injectMessage(from, message)
      // Wire streaming callback for this chat — cleared after tick completes
      if (options?.onStream) loop.setStreamCallback(options.onStream)
      let result: TickResult
      try {
        result = await loop.tick()
      } finally {
        if (options?.onStream) loop.setStreamCallback(null)
      }
      // Extract response: prefer action:respond content, fallback to thought
      const respondAction = result.actions.find(a => a.type === 'respond')
      const response = respondAction?.content ?? ''
      // Extract structured metadata for cross-agent/human transparency
      const actionTypes = result.actions.map(a => a.type)
      const filesRead = result.actions
        .filter(a => a.type === 'read' || a.type === 'grep')
        .map(a => (a.input?.path as string) ?? '').filter(Boolean)
      const filesWritten = result.actions
        .filter(a => a.type === 'write' || a.type === 'edit')
        .map(a => (a.input?.path as string) ?? '').filter(Boolean)

      return {
        response,
        thought: result.thought,
        actions: actionTypes,
        duration: result.observation.duration,
        quality: result.observation.outputQuality,
        meta: {
          mode: loop.getCurrentMode?.() ?? 'unknown',
          filesRead: [...new Set(filesRead)],
          filesWritten: [...new Set(filesWritten)],
          toolsUsed: [...new Set(actionTypes)],
          hypotheses: 0, // populated if working memory available
          contextChars: result.perception.length,
        },
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
export { loadSkills, selectSkills, formatSkillsForPrompt, clearSkillCache, type Skill } from './skills.js'
export { createHookSystem, builtinHooks, createAutoVerifyHook, type Hook, type HookPhase, type HookContext } from './hooks.js'
export { classifyError, formatErrorForAgent, type ClassifiedError, type ErrorType } from './error-classification.js'
export { writeHandoff, readPendingHandoffs, updateHandoffStatus, formatHandoffsForContext, type Handoff } from './handoff.js'
export { serve, type ServeOptions, type ServeHandle } from './serve.js'
export { createAgentSdkProvider, type AgentSdkOptions } from './llm/agent-sdk.js'
export { safeJsonLoad, safeReadFile, safeJsonlLoad } from './safe-io.js'
export { saveSession, loadSession, listSessions, forkSession, formatSessionsForContext, type SessionSnapshot } from './session.js'

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
