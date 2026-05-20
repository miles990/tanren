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
import type { TanrenConfig, TickResult, ChatResult, TickPathConfig } from './types.js'

export interface TanrenAgent {
  /** Run one perceive→think→act cycle */
  tick(): Promise<TickResult>
  /** Send a message and get a response — injects message, runs tick, extracts response.
   *  Optional onStream callback receives text chunks during LLM think phase. */
  chat(message: string, options?: { from?: string; onStream?: (text: string) => void }): Promise<ChatResult>
  /** Run a self-paced chain — agent decides when to stop.
   *  `wallClockMs`: wall-clock cap across all ticks. `onTick`: per-tick callback (for streaming).
   *  `pathConfig`: per-request override for reactive/deep path (mode-switch — KG 620bae11). */
  runChain(message?: string, options?: { from?: string; wallClockMs?: number; onTick?: (result: TickResult, tickNum: number) => void | Promise<void>; pathConfig?: TickPathConfig }): Promise<TickResult[]>
  /** Start the autonomous loop */
  start(interval?: number): void
  /** Stop the loop gracefully */
  stop(): void
  /** Is the loop running? */
  isRunning(): boolean
  /** Recent tick history */
  getRecentTicks(): TickResult[]
  /** Set session ID for resume (Agent SDK session continuity) */
  setSessionId(id: string | null): void
  /** Get current session ID (Agent SDK session continuity) */
  getSessionId(): string | null
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
      // Extract response: LATEST respond action content wins (not first).
      // Rationale: feedback loop can produce multiple respond actions across rounds.
      // The LLM's last word is the canonical answer — earlier ones are stale
      // intentions ("I'll do X") written before the work was done.
      const respondActions = result.actions.filter(a => a.type === 'respond')
      const respondAction = respondActions[respondActions.length - 1]
      const response = respondAction?.content ?? ''
      // Extract structured metadata for cross-agent/human transparency
      const actionTypes = result.actions.map(a => a.type)
      const filesRead = result.actions
        .filter(a => a.type === 'read' || a.type === 'grep')
        .map(a => (a.input?.path as string) ?? '').filter(Boolean)
      const filesWritten = result.actions
        .filter(a => a.type === 'write' || a.type === 'edit')
        .map(a => (a.input?.path as string) ?? '').filter(Boolean)

      const sessionId = loop.getSessionId() ?? undefined
      return {
        response,
        thought: result.thought,
        actions: actionTypes,
        duration: result.observation.duration,
        quality: result.observation.outputQuality,
        ...(sessionId ? { sessionId } : {}),
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
    async runChain(message?: string, options?: { from?: string; wallClockMs?: number; onTick?: (result: TickResult, tickNum: number) => void | Promise<void>; pathConfig?: TickPathConfig }): Promise<TickResult[]> {
      if (message) {
        loop.injectMessage(options?.from ?? 'user', message)
      }
      return loop.runChain({ wallClockMs: options?.wallClockMs, onTick: options?.onTick, pathConfig: options?.pathConfig })
    },
    start: (interval) => loop.start(interval ?? config.tickInterval),
    stop: () => loop.stop(),
    isRunning: () => loop.isRunning(),
    getRecentTicks: () => loop.getRecentTicks(),
    setSessionId: (id) => loop.setSessionId(id),
    getSessionId: () => loop.getSessionId(),
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
  ActionApprovalDecision,
  ActionApprovalGuard,
  Observation,
  Gate,
  GateContext,
  GateResult,
  MemorySystem,
  MemoryReader,
  SearchResult,
  LLMProvider,
  ToolUseLLMProvider,
  SessionAwareLLMProvider,
  ToolDefinition,
  ConversationMessage,
  ContentBlock,
  ToolUseResponse,
  PerceptionPlugin,
  PerceptionTier,
  ActionHandler,
  ActionContext,
  RiskTier,
  ProviderCapabilities,
} from './types.js'

// Modules
export { createMemorySystem, listMemoryFiles } from './memory.js'
export { createPerception, type PerceptionSystem } from './perception.js'
export { createGateSystem, defineGate, defaultGates, createOutputGate, createAnalysisWithoutActionGate, createProductivityGate, createSymptomFixGate, createGroundBeforeOpineGate, createWriteThroughGate, createCommitmentGate, type GateSystem, type GateSpec } from './gates.js'
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
export { createCodexCliProvider, type CodexCliOptions } from './llm/codex-cli.js'
export { createAnthropicProvider, type AnthropicProviderOptions } from './llm/anthropic.js'
export { createOpenAIProvider, createFallbackProvider, type OpenAIProviderOptions, type ToolCallOptions, type CostTracker } from './llm/openai.js'
export { createGoogleProvider, type GoogleProviderOptions } from './llm/google.js'
export { createManagedAgentProvider, type ManagedAgentProviderOptions } from './llm/managed-agent.js'
export { createProvider, createProviderFromEnv, listProviders, readScopedEnv, registerProviderFactory, type BuiltinProviderKey, type ProviderConfig, type ProviderFactory, type ProviderFactoryContext, type ProviderKey, type ProviderSelection, type ProviderFromEnvOptions } from './provider-registry.js'
export { decideProviderUse, readPolicyEvents, writePolicyEvent, type ProviderPolicy, type ProviderPolicyDecision, type PolicyEvent, type TaskRisk } from './provider-policy.js'
export { promptToText, toAnthropic, toOpenAI, toGemini, extractOpenAIOutputs, extractAnthropicOutputs, extractGeminiOutputs } from './content-adapter.js'
export { createGenerationIO, createModelIO, collectStream, routeModelRequest, supportsModelRequest, type GenerationIO, type GenerationRequest, type GenerationResponse, type ModelIO, type ModelRequest, type ModelResponse, type ModelRouteDecision, type ModelRouteRequirement } from './model-io.js'
export { TEXT_ONLY_CAPABILITIES, ANTHROPIC_CAPABILITIES, OPENAI_COMPAT_CAPABILITIES, GEMINI_CAPABILITIES, MANAGED_AGENT_CAPABILITIES, AGENT_SDK_CAPABILITIES } from './provider-capabilities.js'
export {
  FileArtifactStore,
  FileArtifactJobStore,
  createOpenAIArtifactProvider,
  createArtifactGraphExecutor,
  createArtifactActions,
  createArtifactProviderFromEnv,
  createArtifactActionsFromEnv,
  createArtifactRequestFromInput,
  decideArtifactProviderUse,
  wrapArtifactProviderWithPolicy,
  type ArtifactKind,
  type ArtifactStatus,
  type ArtifactRef,
  type ArtifactBlob,
  type ArtifactRequest,
  type ArtifactJob,
  type ArtifactEvent,
  type ArtifactCapabilities,
  type ArtifactProvider,
  type ArtifactPolicy,
  type ArtifactPolicyDecision,
  type ArtifactProviderFromEnvOptions,
  type ArtifactProviderSelection,
  type ArtifactStore,
  type ArtifactJobStore,
  type ArtifactGraphNode,
  type ArtifactGraph,
  type ArtifactGraphResult,
  type FetchLike,
} from './artifact-io.js'
export { routeArtifactRequest, supportsArtifactRequest, type ArtifactRouteDecision, type ArtifactRouterOptions } from './artifact-router.js'
export { handleArtifactHttpRoute, type ArtifactHttpOptions } from './artifact-http.js'
export { ArtifactController, ArtifactFileServer, PolicyEventController } from './artifact-controller.js'
export { parseArtifactJob, parseArtifactRequest } from './artifact-schema.js'
export type * from './artifact-types.js'
export {
  createInboxPlugin,
  createOutboxHistoryPlugin,
  createPeerMessagePlugin,
  createPeerMessageActions,
  type InboxPluginOptions,
  type OutboxHistoryPluginOptions,
  type PeerMessageOptions,
} from './memory-plugins.js'

// Working Memory
export { createWorkingMemory, type WorkingMemorySystem } from './working-memory.js'

// Plan System
export { createPlanSystem, loadPlans, parsePlan, type Plan, type PlanStep } from './plans.js'
export { PlanEngine, parsePlan as parseActionPlan, type ActionPlan, type PlanStep as OrchestrationPlanStep, type PlanResult, type StepResult, type WorkerExecutor, type PlanEngineOptions, type StructuredOutput as PlanStructuredOutput, type DigestInput, type StepRisk, type ConfirmationResult, type PlanEvent } from './orchestration/plan-engine.js'
export { ResultBuffer, type TaskRecord, type TaskStatus, type TaskEvent } from './orchestration/result-buffer.js'
export { WORKERS, allWorkers, getSdkAgentDefinitions, getWorkerNames, addCustomWorker, removeCustomWorker, type WorkerBackend, type WorkerDefinition } from './orchestration/workers.js'
export { extractStepLessons, learningEventsPath, readStepLearningEvents, recordStepLearningEvent, type StepLearningEvent } from './orchestration/learning-events.js'
export { auditBranchHygiene, cleanupMergedCycleBranches, type BranchHygieneBranch, type BranchHygienePolicy, type BranchHygieneReport } from './orchestration/branch-hygiene.js'
export { createWorkerRuntime, type WorkerRuntime, type WorkerRuntimeOptions } from './orchestration/worker-runtime.js'
export { ACPGateway, createGateway, DEFAULT_BACKENDS, type CLIBackend, type ACPSession, type GatewayStats } from './orchestration/acp-gateway.js'
export { PLAN_TEMPLATES, type PlanTemplate } from './orchestration/templates.js'
export { PresetManager, type WorkerPreset } from './orchestration/presets.js'
export { createPlanningBrain, createBrain, brainPlan, brainDigest, type BrainConfig, type WorkerInfo } from './orchestration/brain.js'
export { createOrchestrationMiddleware, createOrchestrationRouter, type OrchestrationMiddleware, type OrchestrationMiddlewareConfig } from './orchestration/router.js'
export { evaluateExecutionHarnessFailure, evaluatePlanStepApproval, toTaskEnvelope, type ApprovalEvaluation, type ExecutionHarnessEvaluation, type ExecutionHarnessInput } from './orchestration/execution-harness.js'
export { PlanEventLog, type PlanLogEvent } from './orchestration/plan-events.js'
export { RepoSchedulerLock, SchedulerLockError, type SchedulerLockRecord, type SchedulerLockHandle, type SchedulerLockConflict } from './orchestration/scheduler-lock.js'
export { buildSmallestProductSlicePlan, classifySupervisorFailure, evaluateSupervisor, selectSmallestProductSliceWorkers, type SmallestProductSliceInput, type SupervisorAction, type SupervisorDecision, type SupervisorFailureType, type SupervisorInput, type SupervisorObjectiveSnapshot, type SupervisorPlanSnapshot, type SupervisorStepSnapshot, type SupervisorTickInput, type SupervisorTickResult } from './orchestration/supervisor.js'
export { formatSupervisorLoopResult, runSupervisorHttpLoop, runSupervisorLoop, type SupervisorHttpLoopOptions, type SupervisorLoopOptions, type SupervisorLoopSummary } from './orchestration/supervisor-loop.js'
export { createOrchestrationMcpServer, startOrchestrationMcpServer, type OrchestrationMcpOptions } from './orchestration/mcp-server.js'
export {
  FileLongTaskStore,
  LongTaskController,
  createLongTaskActions,
  createLongTaskPlan,
  type LongTaskControllerOptions,
  type LongTaskCreateInput,
  type LongTaskEvent,
  type LongTaskKind,
  type LongTaskRecord,
  type LongTaskStatus,
  type LongTaskStore,
} from './long-task.js'
export { handleLongTaskHttpRoute, type LongTaskHttpOptions } from './long-task-http.js'
export {
  ANUP_PROTOCOL,
  ANUP_VERSION,
  FileAgentUIStore,
  assertAgentUIBlock,
  assertAgentUIEnvelope,
  artifactJobToAnupBlocks,
  artifactJobToMediaRefBlocks,
  artifactRefToMediaRefBlock,
  buildAnupOverview,
  capabilitiesToContextSummary,
  chatResultToAnupEnvelope,
  createAnupApprovalGuard,
  createAgentUIEnvelope,
  createDemoAnupEnvelope,
  createRunId,
  longTaskToAnupEnvelope,
  policyEventsToConstraintPanel,
  requiresApproval,
  type AgentUIBlock,
  type AgentUIEnvelope,
  type AgentUIEvent,
  type AgentStateBlock,
  type ApprovalRequestBlock,
  type ArtifactBlock,
  type ConstraintPanelBlock,
  type ContextSummaryBlock,
  type DecisionCardBlock,
  type DecisionOption,
  type HumanAction,
  type ImpactLevel,
  type MediaRefBlock,
  type RiskLevel,
  type StoredAgentUIRun,
  type TaskContractBlock,
  type ToolTraceBlock,
  type ToolTraceEvent,
} from './anup.js'
export { handleAnupHttpRoute, type AnupHttpOptions } from './anup-http.js'
export { getAnupWorkbenchHtml } from './anup-workbench.js'
export { createKgCollaboration, createKgDiscussionPlugin, createKgNotificationDiscussionPlugin, createKgActions, type KgCollaborationOptions, type KgNotificationDiscussionPluginOptions } from './kg-collaboration.js'
export { createRoleContractPlugin, type RoleContractPluginOptions } from './role-contract.js'

// Action Health
export { createActionHealthTracker } from './action-health.js'

// Metacognitive Perception Layer
export { createMPL } from './metacognitive.js'

// Self-Paced Continuation
export { createContinuationSystem, type ChainState } from './continuation.js'

// Context Modes
export { detectContextMode, getModeConfig, type ContextMode, type ContextModeConfig } from './context-modes.js'
export { loadSkills, selectSkills, formatSkillsForPrompt, clearSkillCache, type Skill } from './skills.js'
export { createHookSystem, builtinHooks, createAutoVerifyHook, createClaimVerificationHook, type Hook, type HookPhase, type HookContext } from './hooks.js'
export { classifyError, formatErrorForAgent, type ClassifiedError, type ErrorType } from './error-classification.js'
export { writeHandoff, readPendingHandoffs, updateHandoffStatus, formatHandoffsForContext, type Handoff } from './handoff.js'
export { serve, type ServeOptions, type ServeHandle, type TanrenHealth } from './serve.js'
export { createAgentSdkProvider, type AgentSdkOptions } from './llm/agent-sdk.js'
export { safeJsonLoad, safeReadFile, safeJsonlLoad } from './safe-io.js'
export { saveSession, loadSession, listSessions, forkSession, formatSessionsForContext, type SessionSnapshot } from './session.js'
export { wrapProviderWithUsageLedger, type UsageLedgerOptions, type UsageRecord } from './usage-ledger.js'
export { createProviderHealthState, createResilientProvider, isTransientProviderError, type ProviderFailure, type ProviderMethod, type ProviderSuccess, type ResilientProviderOptions, type ResilientProviderState } from './resilient-provider.js'
export { BUILTIN_RUNTIME_TASK_PROFILES, mergeTaskProfile, readRuntimeTaskProfileName, resolveRuntimeTaskProfile, type RuntimeTaskProfile, type RuntimeTaskProfileName } from './task-profile.js'
export { loadDotEnvFile, readUsageSummary, type DotEnvLoadOptions } from './env.js'
export { loadMcpServersFromConfig, type McpConfigLoadOptions, type McpConfigSelection } from './mcp-config.js'
export { createPeerBridge, type PeerBridge, type PeerBridgeOptions } from './peer-bridge.js'
export { createAgoraCollaboration, type AgoraCollaboration, type AgoraCollaborationOptions } from './agora-collaboration.js'
export { createAgentRuntimePreset, createArtifactLayer, createLongTaskLayer, createProviderLayer, createRuntimeCapabilities, createRuntimeLayers, createRuntimeModelRouter, type RuntimeCapabilities, type RuntimeLayerPipeline, type RuntimeModelRouter, type RuntimePreset, type RuntimePresetOptions } from './runtime-preset.js'
export { runAgentCli, type RuntimeCliOptions } from './runtime-cli.js'
export { createDiscussionSessionStore, type DiscussionMessage, type DiscussionSession, type DiscussionSessionStoreOptions } from './discussion-session-store.js'
export { chatStream, checkAgentHealth, type AgentChatResult, type ChatStreamOptions } from './chat-client.js'
export {
  createKgDiscussionClient,
  loadLocalSessionMap,
  saveLocalSessionMap,
  type KgDiscussionClientOptions,
  type KgDiscussionClient,
  type KgDiscussion,
  type KgPosition,
} from './kg-discussion-client.js'

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
