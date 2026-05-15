import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ArtifactJob, ArtifactKind, ArtifactRef } from './artifact-types.js'
import type { LongTaskEvent, LongTaskRecord } from './long-task.js'
import type { PolicyEvent } from './provider-policy.js'

export const ANUP_PROTOCOL = 'anup'
export const ANUP_VERSION = '0.1.0'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type ImpactLevel = 'low' | 'medium' | 'high'

export interface AgentUIEnvelope {
  protocol: typeof ANUP_PROTOCOL
  version: string
  run_id: string
  agent_id: string
  timestamp: string
  blocks: AgentUIBlock[]
  metadata?: Record<string, unknown>
}

export type AgentUIBlock =
  | TaskContractBlock
  | AgentStateBlock
  | ContextSummaryBlock
  | ConstraintPanelBlock
  | DecisionCardBlock
  | ApprovalRequestBlock
  | ToolTraceBlock
  | ArtifactBlock
  | MediaRefBlock

export interface TaskContractBlock {
  type: 'task_contract'
  id: string
  title: string
  goal: string
  inputs: string[]
  success_criteria: string[]
  constraints: string[]
}

export interface AgentStateBlock {
  type: 'agent_state'
  id: string
  phase: 'planning' | 'retrieving_context' | 'analysis' | 'executing' | 'waiting_approval' | 'completed' | 'failed'
  status: 'idle' | 'running' | 'blocked' | 'done' | 'error'
  current_step: string
  completed_steps: string[]
  next_steps: string[]
  confidence?: number
}

export interface ContextSummaryBlock {
  type: 'context_summary'
  id: string
  source: 'kg' | 'memory' | 'runtime' | 'provider' | 'artifact' | 'user'
  title: string
  items: Array<{
    id: string
    summary: string
    relevance?: number
    content_ref?: string
    metadata?: Record<string, unknown>
  }>
}

export interface ConstraintPanelBlock {
  type: 'constraint_panel'
  id: string
  title: string
  constraints: Array<{
    id: string
    name: string
    description: string
    severity?: RiskLevel
    active?: boolean
  }>
}

export interface DecisionCardBlock {
  type: 'decision_card'
  id: string
  title: string
  summary: string
  options: DecisionOption[]
  rationale: string[]
}

export interface DecisionOption {
  id: string
  label: string
  pros: string[]
  cons: string[]
  risk: RiskLevel
  impact: ImpactLevel
  recommended?: boolean
}

export interface ApprovalRequestBlock {
  type: 'approval_request'
  id: string
  title: string
  action: {
    kind: 'create_file' | 'modify_file' | 'delete_file' | 'run_command' | 'send_message' | 'deploy' | 'artifact_generate' | 'provider_call'
    target: string
    description: string
  }
  risk_level: RiskLevel
  requires_confirmation: boolean
  available_actions: Array<{
    id: 'approve' | 'reject' | 'modify'
    label: string
  }>
}

export interface ToolTraceBlock {
  type: 'tool_trace'
  id: string
  events: ToolTraceEvent[]
}

export interface ToolTraceEvent {
  time: string
  tool: string
  input_summary: string
  status: 'started' | 'success' | 'failed'
  output_summary?: string
  metadata?: Record<string, unknown>
}

export interface ArtifactBlock {
  type: 'artifact'
  id: string
  artifact_type: ArtifactKind | 'markdown' | 'code' | 'diff' | 'architecture_plan' | 'report'
  title: string
  format: 'markdown' | 'json' | 'typescript' | 'diff' | 'html' | 'image' | 'audio' | 'video' | 'file' | 'data'
  content_ref: string
  summary: string
  media_refs?: string[]
  metadata?: Record<string, unknown>
}

export interface MediaRefBlock {
  type: 'media_ref'
  id: string
  title: string
  source: 'input' | 'output' | 'artifact' | 'context'
  kind: 'image' | 'audio' | 'video' | 'file' | 'stream'
  media_type: string
  uri: string
  label?: string
  metadata?: Record<string, unknown>
}

export interface HumanAction {
  type: 'human_action'
  run_id: string
  source_block_id: string
  action_id: 'approve' | 'reject' | 'modify' | string
  payload?: Record<string, unknown>
  timestamp: string
}

export type AgentUIEvent =
  | { event: 'run.started'; run_id: string; timestamp: string }
  | { event: 'block.created'; run_id: string; timestamp: string; block: AgentUIBlock }
  | { event: 'approval.responded'; run_id: string; timestamp: string; action: HumanAction }
  | { event: 'run.completed' | 'run.failed'; run_id: string; timestamp: string; summary?: string; error?: string }

export interface StoredAgentUIRun {
  run: AgentUIEnvelope
  events: AgentUIEvent[]
  actions: HumanAction[]
}

export class FileAgentUIStore {
  constructor(private rootDir: string) {
    mkdirSync(rootDir, { recursive: true })
  }

  list(limit = 50): AgentUIEnvelope[] {
    if (!existsSync(this.rootDir)) return []
    return readdirSync(this.rootDir)
      .map(name => this.get(name)?.run)
      .filter((run): run is AgentUIEnvelope => run != null)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
  }

  get(runId: string): StoredAgentUIRun | null {
    const dir = this.runDir(runId)
    const path = join(dir, 'run.json')
    if (!existsSync(path)) return null
    const run = JSON.parse(readFileSync(path, 'utf-8')) as AgentUIEnvelope
    return {
      run,
      events: readJsonl<AgentUIEvent>(join(dir, 'events.jsonl')),
      actions: readJsonl<HumanAction>(join(dir, 'actions.jsonl')),
    }
  }

  put(run: AgentUIEnvelope): AgentUIEnvelope {
    assertAgentUIEnvelope(run)
    const dir = this.runDir(run.run_id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2), 'utf-8')
    return run
  }

  appendBlock(runId: string, block: AgentUIBlock): AgentUIEnvelope {
    assertAgentUIBlock(block)
    const stored = this.get(runId)
    if (!stored) throw new Error(`ANUP run not found: ${runId}`)
    const run: AgentUIEnvelope = {
      ...stored.run,
      timestamp: new Date().toISOString(),
      blocks: [...stored.run.blocks.filter(existing => existing.id !== block.id), block],
    }
    this.put(run)
    this.appendEvent({ event: 'block.created', run_id: runId, timestamp: run.timestamp, block })
    return run
  }

  appendEvent(event: AgentUIEvent): void {
    const dir = this.runDir(event.run_id)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8')
  }

  appendHumanAction(action: HumanAction): void {
    const dir = this.runDir(action.run_id)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'actions.jsonl'), `${JSON.stringify(action)}\n`, 'utf-8')
    this.appendEvent({ event: 'approval.responded', run_id: action.run_id, timestamp: action.timestamp, action })
  }

  pendingApprovals(): Array<{ run_id: string; block: ApprovalRequestBlock }> {
    return this.list(100).flatMap(run => {
      const actions = this.get(run.run_id)?.actions ?? []
      return run.blocks
        .filter((block): block is ApprovalRequestBlock => block.type === 'approval_request' && block.requires_confirmation)
        .filter(block => !actions.some(action => action.source_block_id === block.id))
        .map(block => ({ run_id: run.run_id, block }))
    })
  }

  private runDir(runId: string): string {
    return join(this.rootDir, safeFileSegment(runId))
  }
}

export function createAgentUIEnvelope(input: {
  runId?: string
  agentId: string
  blocks: AgentUIBlock[]
  metadata?: Record<string, unknown>
}): AgentUIEnvelope {
  const run: AgentUIEnvelope = {
    protocol: ANUP_PROTOCOL,
    version: ANUP_VERSION,
    run_id: input.runId ?? createRunId(),
    agent_id: input.agentId,
    timestamp: new Date().toISOString(),
    blocks: input.blocks,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
  assertAgentUIEnvelope(run)
  return run
}

export function createRunId(prefix = 'run'): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function assertAgentUIEnvelope(envelope: AgentUIEnvelope): void {
  if (envelope.protocol !== ANUP_PROTOCOL) throw new Error(`Unsupported ANUP protocol: ${String(envelope.protocol)}`)
  if (!Array.isArray(envelope.blocks)) throw new Error('ANUP envelope blocks must be an array')
  for (const block of envelope.blocks) assertAgentUIBlock(block)
}

export function assertAgentUIBlock(block: AgentUIBlock): void {
  if (!block || typeof block !== 'object') throw new Error('ANUP block must be an object')
  if (!('type' in block) || !('id' in block)) throw new Error('ANUP block requires type and id')
  const allowed = new Set<AgentUIBlock['type']>([
    'task_contract',
    'agent_state',
    'context_summary',
    'constraint_panel',
    'decision_card',
    'approval_request',
    'tool_trace',
    'artifact',
    'media_ref',
  ])
  if (!allowed.has(block.type)) throw new Error(`Unsupported ANUP block type: ${String(block.type)}`)
  if (block.type === 'approval_request' && block.requires_confirmation !== requiresApproval(block)) {
    throw new Error(`Approval block ${block.id} has inconsistent requires_confirmation`)
  }
}

export function requiresApproval(block: ApprovalRequestBlock): boolean {
  if (block.risk_level === 'high' || block.risk_level === 'critical') return true
  if (block.action.kind === 'delete_file' || block.action.kind === 'deploy' || block.action.kind === 'send_message') return true
  return block.requires_confirmation
}

export function longTaskToAnupEnvelope(
  task: LongTaskRecord,
  events: LongTaskEvent[] = [],
  opts: { agentId?: string; result?: string | null } = {},
): AgentUIEnvelope {
  const blocks: AgentUIBlock[] = [
    {
      type: 'task_contract',
      id: `${task.id}:contract`,
      title: task.kind === 'review' ? 'Review task' : 'Long task',
      goal: task.goal,
      inputs: compactStrings([task.caller ? `caller:${task.caller}` : '', task.plan.goal]),
      success_criteria: compactStrings([task.acceptance ?? task.plan.acceptance ?? 'Task reaches completed status']),
      constraints: ['Record plan events', 'Expose progress as ANUP blocks', 'Keep artifacts as refs instead of raw HTML'],
    },
    {
      type: 'agent_state',
      id: `${task.id}:state`,
      phase: taskStatusToPhase(task.status),
      status: taskStatusToAgentStatus(task.status),
      current_step: currentTaskStep(task),
      completed_steps: completedTaskSteps(task),
      next_steps: nextTaskSteps(task),
      confidence: task.status === 'failed' ? 0.2 : task.status === 'completed' ? 0.95 : 0.7,
    },
    {
      type: 'tool_trace',
      id: `${task.id}:trace`,
      events: events.map(event => ({
        time: event.timestamp,
        tool: event.type,
        input_summary: summarizeUnknown(event.data),
        status: event.type.includes('failed') ? 'failed' : event.type.includes('started') || event.type.includes('created') ? 'started' : 'success',
        metadata: { taskId: event.taskId },
      })),
    },
  ]
  if (opts.result) {
    blocks.push({
      type: 'artifact',
      id: `${task.id}:result`,
      artifact_type: 'report',
      title: 'Task result',
      format: 'markdown',
      content_ref: `/tasks/${encodeURIComponent(task.id)}/result`,
      summary: opts.result.slice(0, 280),
    })
  }
  return createAgentUIEnvelope({
    runId: `task:${task.id}`,
    agentId: opts.agentId ?? 'tanren',
    blocks,
    metadata: { projection: 'long_task', taskId: task.id },
  })
}

export function artifactJobToAnupBlocks(job: ArtifactJob): AgentUIBlock[] {
  const mediaRefs = artifactJobToMediaRefBlocks(job)
  return [
    {
      type: 'artifact',
      id: `${job.id}:artifact`,
      artifact_type: job.request.type,
      title: `${job.request.type} artifact job`,
      format: artifactKindToFormat(job.request.type),
      content_ref: `/artifacts/${encodeURIComponent(job.id)}`,
      summary: job.status === 'completed'
        ? `${job.artifacts.length} artifact(s) generated by ${job.provider}`
        : job.error ?? `Artifact job is ${job.status}`,
      media_refs: mediaRefs.map(ref => ref.id),
      metadata: { provider: job.provider, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt },
    },
    ...mediaRefs,
  ]
}

export function artifactJobToMediaRefBlocks(job: ArtifactJob): MediaRefBlock[] {
  return job.artifacts.map((artifact, index) => artifactRefToMediaRefBlock(artifact, job.id, index))
}

export function artifactRefToMediaRefBlock(ref: ArtifactRef, jobId: string, index = 0): MediaRefBlock {
  return {
    type: 'media_ref',
    id: `${jobId}:media:${index}`,
    title: ref.label ?? `${ref.kind} artifact`,
    source: 'artifact',
    kind: artifactKindToMediaKind(ref.kind),
    media_type: ref.mediaType,
    uri: browserSafeArtifactUri(ref, jobId, index),
    label: ref.label,
    metadata: { artifactId: ref.id, originalUri: ref.uri, ...ref.metadata },
  }
}

export function policyEventsToConstraintPanel(events: PolicyEvent[]): ConstraintPanelBlock {
  return {
    type: 'constraint_panel',
    id: 'policy:constraints',
    title: 'Provider and artifact policy constraints',
    constraints: events.slice(0, 20).map((event, index) => ({
      id: `policy:${index}:${event.timestamp}`,
      name: `${event.domain}:${event.provider}`,
      description: `${event.allowed ? 'Allowed' : 'Blocked'} - ${event.reason}`,
      severity: event.allowed ? 'low' : 'medium',
      active: !event.allowed,
    })),
  }
}

export function capabilitiesToContextSummary(capabilities: unknown): ContextSummaryBlock {
  return {
    type: 'context_summary',
    id: 'runtime:capabilities',
    source: 'provider',
    title: 'Runtime capabilities',
    items: flattenCapabilities(capabilities).map(([id, value]) => ({
      id,
      summary: `${id}: ${String(value)}`,
      metadata: { value },
    })),
  }
}

export function buildAnupOverview(input: {
  agentId: string
  tasks?: LongTaskRecord[]
  artifacts?: ArtifactJob[]
  policyEvents?: PolicyEvent[]
  capabilities?: unknown
}): AgentUIEnvelope {
  const blocks: AgentUIBlock[] = [
    {
      type: 'agent_state',
      id: 'overview:state',
      phase: 'analysis',
      status: 'idle',
      current_step: 'Runtime state projected into Agent Native UI Protocol',
      completed_steps: [
        `${input.tasks?.length ?? 0} long task(s) visible`,
        `${input.artifacts?.length ?? 0} artifact job(s) visible`,
        `${input.policyEvents?.length ?? 0} policy event(s) visible`,
      ],
      next_steps: ['Open a task, inspect artifacts, or respond to pending approvals'],
      confidence: 0.9,
    },
  ]
  if (input.capabilities) blocks.push(capabilitiesToContextSummary(input.capabilities))
  if (input.policyEvents?.length) blocks.push(policyEventsToConstraintPanel(input.policyEvents))
  for (const task of input.tasks ?? []) {
    blocks.push({
      type: 'context_summary',
      id: `overview:task:${task.id}`,
      source: 'runtime',
      title: `Task ${task.id}`,
      items: [{
        id: task.id,
        summary: `${task.status}: ${task.goal}`,
        content_ref: `/anup/tasks/${encodeURIComponent(task.id)}`,
        metadata: { status: task.status, updatedAt: task.updatedAt },
      }],
    })
  }
  for (const job of input.artifacts ?? []) blocks.push(...artifactJobToAnupBlocks(job))
  return createAgentUIEnvelope({
    runId: 'overview',
    agentId: input.agentId,
    blocks,
    metadata: { projection: 'overview' },
  })
}

function taskStatusToPhase(status: LongTaskRecord['status']): AgentStateBlock['phase'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'paused') return 'waiting_approval'
  if (status === 'running') return 'executing'
  return 'planning'
}

function taskStatusToAgentStatus(status: LongTaskRecord['status']): AgentStateBlock['status'] {
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'error'
  if (status === 'paused') return 'blocked'
  if (status === 'running' || status === 'queued') return 'running'
  return 'idle'
}

function currentTaskStep(task: LongTaskRecord): string {
  if (task.status === 'completed') return task.summary ?? 'Task completed'
  if (task.status === 'failed') return task.error ?? 'Task failed'
  const next = task.plan.steps[task.checkpointCount] ?? task.plan.steps[0]
  return next ? stepSummary(next) : task.goal
}

function completedTaskSteps(task: LongTaskRecord): string[] {
  return task.plan.steps
    .slice(0, task.checkpointCount)
    .map(step => stepSummary(step))
}

function nextTaskSteps(task: LongTaskRecord): string[] {
  return task.plan.steps
    .slice(task.checkpointCount)
    .slice(0, 5)
    .map(step => stepSummary(step))
}

function stepSummary(step: LongTaskRecord['plan']['steps'][number]): string {
  return step.label ?? step.task
}

function artifactKindToFormat(kind: ArtifactKind): ArtifactBlock['format'] {
  if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'file' || kind === 'data') return kind
  return 'file'
}

function artifactKindToMediaKind(kind: ArtifactKind): MediaRefBlock['kind'] {
  if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'file') return kind
  return 'file'
}

function browserSafeArtifactUri(ref: ArtifactRef, jobId: string, index: number): string {
  if (/^https?:\/\//.test(ref.uri) || ref.uri.startsWith('data:')) return ref.uri
  return `/artifacts/${encodeURIComponent(jobId)}/file?index=${index}`
}

function flattenCapabilities(value: unknown, prefix = 'capabilities'): Array<[string, unknown]> {
  if (value == null || typeof value !== 'object') return [[prefix, value]]
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return [[prefix, '{}']]
  const flattened = entries.flatMap<[string, unknown]>(([key, nested]) => {
    const path = `${prefix}.${key}`
    if (nested != null && typeof nested === 'object' && !Array.isArray(nested)) return flattenCapabilities(nested, path)
    return [[path, Array.isArray(nested) ? nested.join(',') : nested]]
  })
  return flattened.slice(0, 80)
}

function summarizeUnknown(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, 240)
  try {
    return JSON.stringify(value).slice(0, 240)
  } catch {
    return String(value).slice(0, 240)
  }
}

function compactStrings(values: string[]): string[] {
  return values.map(value => value.trim()).filter(Boolean)
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)
}
