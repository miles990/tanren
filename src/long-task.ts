import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActionHandler } from './types.js'
import {
  PlanEngine,
  type ActionPlan,
  type PlanEvent,
  type PlanResult,
  type PlanStep,
  type StepResult,
} from './orchestration/plan-engine.js'
import { createWorkerRuntime, type WorkerRuntime, type WorkerRuntimeOptions } from './orchestration/worker-runtime.js'

export type LongTaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled'
export type LongTaskKind = 'generic' | 'review'

export interface LongTaskRecord {
  id: string
  kind: LongTaskKind
  goal: string
  acceptance?: string
  plan: ActionPlan
  status: LongTaskStatus
  caller?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  summary?: string
  resultPath?: string
  checkpointCount: number
}

export interface LongTaskEvent {
  timestamp: string
  taskId: string
  type: string
  data?: unknown
}

export interface LongTaskCreateInput {
  kind?: LongTaskKind
  goal?: string
  acceptance?: string
  prompt?: string
  context?: string
  caller?: string
  plan?: ActionPlan
  start?: boolean
}

export interface LongTaskStore {
  create(input: { kind: LongTaskKind; goal: string; acceptance?: string; plan: ActionPlan; caller?: string }): LongTaskRecord
  put(record: LongTaskRecord): void
  get(id: string): LongTaskRecord | null
  list(filter?: { status?: LongTaskStatus; limit?: number }): LongTaskRecord[]
  appendEvent(taskId: string, type: string, data?: unknown): void
  listEvents(taskId: string, limit?: number): LongTaskEvent[]
  putCheckpoint(taskId: string, result: StepResult): void
  listCheckpoints(taskId: string): StepResult[]
  putResult(taskId: string, result: PlanResult): string
}

export class FileLongTaskStore implements LongTaskStore {
  constructor(private rootDir: string) {
    mkdirSync(rootDir, { recursive: true })
  }

  create(input: { kind: LongTaskKind; goal: string; acceptance?: string; plan: ActionPlan; caller?: string }): LongTaskRecord {
    const now = new Date().toISOString()
    const id = `task-${Date.now()}-${randomUUID().slice(0, 8)}`
    const record: LongTaskRecord = {
      id,
      kind: input.kind,
      goal: input.goal,
      acceptance: input.acceptance,
      plan: input.plan,
      status: 'queued',
      caller: input.caller,
      createdAt: now,
      updatedAt: now,
      checkpointCount: 0,
    }
    this.put(record)
    this.appendEvent(id, 'task.created', { goal: input.goal, kind: input.kind })
    return record
  }

  put(record: LongTaskRecord): void {
    const dir = this.taskDir(record.id)
    mkdirSync(join(dir, 'checkpoints'), { recursive: true })
    writeFileSync(join(dir, 'task.json'), JSON.stringify(record, null, 2), 'utf-8')
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(record.plan, null, 2), 'utf-8')
  }

  get(id: string): LongTaskRecord | null {
    const path = join(this.taskDir(id), 'task.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as LongTaskRecord
  }

  list(filter: { status?: LongTaskStatus; limit?: number } = {}): LongTaskRecord[] {
    if (!existsSync(this.rootDir)) return []
    let records = readdirSync(this.rootDir)
      .map(name => this.get(name))
      .filter((record): record is LongTaskRecord => record != null)
    if (filter.status) records = records.filter(record => record.status === filter.status)
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return filter.limit ? records.slice(0, filter.limit) : records
  }

  appendEvent(taskId: string, type: string, data?: unknown): void {
    const dir = this.taskDir(taskId)
    mkdirSync(dir, { recursive: true })
    const event: LongTaskEvent = { timestamp: new Date().toISOString(), taskId, type, data }
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8')
  }

  listEvents(taskId: string, limit = 100): LongTaskEvent[] {
    const path = join(this.taskDir(taskId), 'events.jsonl')
    if (!existsSync(path)) return []
    const events = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as LongTaskEvent)
    return events.slice(-limit)
  }

  putCheckpoint(taskId: string, result: StepResult): void {
    const dir = join(this.taskDir(taskId), 'checkpoints')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${safeFileName(result.id)}.json`), JSON.stringify(result, null, 2), 'utf-8')
  }

  listCheckpoints(taskId: string): StepResult[] {
    const dir = join(this.taskDir(taskId), 'checkpoints')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(join(dir, file), 'utf-8')) as StepResult)
      .sort((a, b) => a.dispatchOrder - b.dispatchOrder)
  }

  putResult(taskId: string, result: PlanResult): string {
    const path = join(this.taskDir(taskId), 'result.md')
    writeFileSync(path, result.digestContext, 'utf-8')
    writeFileSync(join(this.taskDir(taskId), 'result.json'), JSON.stringify(result, null, 2), 'utf-8')
    return path
  }

  private taskDir(id: string): string {
    return resolve(this.rootDir, safeFileName(id))
  }
}

export interface LongTaskControllerOptions extends WorkerRuntimeOptions {
  memoryDir: string
  store?: LongTaskStore
  autoStart?: boolean
}

export class LongTaskController {
  readonly store: LongTaskStore
  readonly runtime: WorkerRuntime
  private active = new Map<string, PlanEngine>()

  constructor(private opts: LongTaskControllerOptions) {
    this.store = opts.store ?? new FileLongTaskStore(join(opts.memoryDir, 'tasks'))
    this.runtime = createWorkerRuntime(opts)
  }

  list(filter: { status?: LongTaskStatus; limit?: number } = {}): LongTaskRecord[] {
    return this.store.list(filter)
  }

  get(id: string): LongTaskRecord | null {
    return this.store.get(id)
  }

  events(id: string, limit?: number): LongTaskEvent[] {
    return this.store.listEvents(id, limit)
  }

  result(id: string): string | null {
    const record = this.store.get(id)
    if (!record?.resultPath || !existsSync(record.resultPath)) return null
    return readFileSync(record.resultPath, 'utf-8')
  }

  create(input: LongTaskCreateInput): LongTaskRecord {
    const plan = input.plan ?? createLongTaskPlan(input)
    const kind = input.kind ?? 'generic'
    const goal = input.goal ?? plan.goal
    const record = this.store.create({ kind, goal, acceptance: input.acceptance ?? plan.acceptance, plan, caller: input.caller })
    if (input.start ?? this.opts.autoStart ?? true) void this.start(record.id)
    return record
  }

  async start(id: string, opts: { resume?: boolean } = {}): Promise<void> {
    const record = this.store.get(id)
    if (!record) throw new Error(`Long task not found: ${id}`)
    if (this.active.has(id)) return
    if (record.status === 'completed') return

    const engine = new PlanEngine(this.runtime.executeWorker, {
      getWorkerTimeoutSeconds: workerName => this.runtime.allWorkers()[workerName]?.defaultTimeoutSeconds ?? 120,
      onEvent: event => this.handlePlanEvent(id, event),
    })
    this.active.set(id, engine)
    const now = new Date().toISOString()
    this.update(id, { status: 'running', startedAt: record.startedAt ?? now, error: undefined })

    try {
      const checkpoints = opts.resume
        ? this.store.listCheckpoints(id).filter(result => result.status === 'completed')
        : []
      const result = await engine.execute(record.plan, checkpoints)
      const resultPath = this.store.putResult(id, result)
      const failed = result.summary.failed > 0
      this.update(id, {
        status: failed ? 'failed' : 'completed',
        completedAt: new Date().toISOString(),
        summary: result.digestInput.completedSteps.at(-1)?.summary ?? result.digestContext.slice(0, 500),
        resultPath,
        error: failed ? result.digestInput.failedSteps.map(step => `${step.id}: ${step.error}`).join('\n') : undefined,
      })
      this.store.appendEvent(id, failed ? 'task.failed' : 'task.completed', { summary: result.summary, resultPath })
    } catch (err) {
      this.update(id, { status: 'failed', completedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) })
      this.store.appendEvent(id, 'task.failed', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.active.delete(id)
    }
  }

  resume(id: string): LongTaskRecord {
    const record = this.store.get(id)
    if (!record) throw new Error(`Long task not found: ${id}`)
    if (record.status === 'running') return record
    this.update(id, { status: 'queued', completedAt: undefined, error: undefined })
    this.store.appendEvent(id, 'task.resume_requested')
    void this.start(id, { resume: true })
    return this.store.get(id)!
  }

  cancel(id: string): LongTaskRecord | null {
    const record = this.store.get(id)
    if (!record) return null
    const cancelled = this.active.get(id)?.cancelAll() ?? 0
    this.update(id, { status: 'cancelled', completedAt: new Date().toISOString(), error: undefined })
    this.store.appendEvent(id, 'task.cancelled', { runningStepsCancelled: cancelled })
    return this.store.get(id)
  }

  private handlePlanEvent(taskId: string, event: PlanEvent): void {
    this.store.appendEvent(taskId, event.type, event)
    if (event.type === 'step.completed' || event.type === 'step.failed') {
      this.store.putCheckpoint(taskId, event.result)
      const record = this.store.get(taskId)
      if (record) this.update(taskId, { checkpointCount: this.store.listCheckpoints(taskId).length })
    }
  }

  private update(id: string, patch: Partial<LongTaskRecord>): void {
    const record = this.store.get(id)
    if (!record) return
    this.store.put({ ...record, ...patch, updatedAt: new Date().toISOString() })
  }
}

export function createLongTaskActions(controller: LongTaskController): ActionHandler[] {
  return [
    {
      type: 'long_task_create',
      description: 'Create and start a resumable background long task from an explicit ActionPlan or goal.',
      toolSchema: {
        properties: {
          goal: { type: 'string', description: 'Task goal' },
          acceptance: { type: 'string', description: 'Acceptance criteria' },
          prompt: { type: 'string', description: 'Task input prompt' },
          context: { type: 'string', description: 'Additional context' },
          plan: { type: 'object', description: 'Optional ActionPlan' },
          start: { type: 'boolean', description: 'Start immediately' },
        },
        required: ['goal'],
      },
      async execute(action) {
        return JSON.stringify(controller.create(action.input ?? { goal: action.content }), null, 2)
      },
    },
    {
      type: 'review_task_create',
      description: 'Create and start a resumable review task split into intake, focused reviews, and synthesis.',
      toolSchema: {
        properties: {
          goal: { type: 'string', description: 'Review goal' },
          prompt: { type: 'string', description: 'Review target or instructions' },
          context: { type: 'string', description: 'Review context' },
          acceptance: { type: 'string', description: 'Acceptance criteria' },
        },
        required: ['prompt'],
      },
      async execute(action) {
        return JSON.stringify(controller.create({ kind: 'review', ...(action.input ?? { prompt: action.content }) }), null, 2)
      },
    },
    {
      type: 'long_task_status',
      description: 'Read status for a long task.',
      toolSchema: { properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(action) {
        const id = String(action.input?.id ?? action.content).trim()
        return JSON.stringify(controller.get(id), null, 2)
      },
    },
    {
      type: 'long_task_resume',
      description: 'Resume a failed, paused, or cancelled long task from completed checkpoints.',
      toolSchema: { properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(action) {
        const id = String(action.input?.id ?? action.content).trim()
        return JSON.stringify(controller.resume(id), null, 2)
      },
    },
    {
      type: 'long_task_cancel',
      description: 'Cancel a running long task.',
      toolSchema: { properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(action) {
        const id = String(action.input?.id ?? action.content).trim()
        return JSON.stringify(controller.cancel(id), null, 2)
      },
    },
  ]
}

export function createLongTaskPlan(input: LongTaskCreateInput): ActionPlan {
  if (input.kind === 'review') return createReviewPlan(input)
  const goal = input.goal ?? 'Run long task'
  const prompt = input.prompt ?? input.context ?? goal
  return {
    goal,
    acceptance: input.acceptance ?? 'Task completes with a structured summary and clear next steps.',
    steps: [
      { id: 'analyze', worker: 'analyst', label: 'Analyze request', task: `${prompt}\n\nReturn JSON with summary, findings, confidence.`, dependsOn: [], timeoutSeconds: 300, retry: { maxRetries: 1, onExhausted: 'fail' } },
      { id: 'synthesize', worker: 'analyst', label: 'Synthesize result', task: `Goal: ${goal}\nAnalysis: {{analyze.summary}}\nFindings: {{analyze.findings}}\nReturn JSON: { "accepted": true, "summary": "...", "findings": [...], "recommendations": [...], "deliverable": "..." }`, dependsOn: ['analyze'], timeoutSeconds: 300 },
    ],
  }
}

function createReviewPlan(input: LongTaskCreateInput): ActionPlan {
  const goal = input.goal ?? 'Review long-form input'
  const target = [input.prompt, input.context].filter(Boolean).join('\n\n')
  const reviewTask = `Review target:\n${target}\n\nGoal: ${goal}`
  return {
    goal,
    acceptance: input.acceptance ?? 'Review identifies concrete risks, gaps, and actionable recommendations.',
    steps: [
      { id: 'intake', worker: 'analyst', label: 'Intake and scope', task: `${reviewTask}\n\nExtract scope, documents to inspect, assumptions, and review criteria. Return JSON: { "summary": "...", "findings": [...], "confidence": 0.8 }.`, dependsOn: [], timeoutSeconds: 300, retry: { maxRetries: 1, onExhausted: 'fail' } },
      { id: 'risk-review', worker: 'reviewer', label: 'Risk review', task: `Review for hidden risks and failure modes. Intake: {{intake.summary}}. Target: ${target}. Return JSON with summary/findings/confidence.`, dependsOn: ['intake'], timeoutSeconds: 240, retry: { maxRetries: 1, onExhausted: 'skip' } },
      { id: 'feasibility-review', worker: 'reviewer', label: 'Feasibility review', task: `Review feasibility and sequencing. Intake: {{intake.summary}}. Target: ${target}. Return JSON with summary/findings/confidence.`, dependsOn: ['intake'], timeoutSeconds: 240, retry: { maxRetries: 1, onExhausted: 'skip' } },
      { id: 'implementation-review', worker: 'reviewer', label: 'Implementation review', task: `Review implementation details, missing interfaces, and verification. Intake: {{intake.summary}}. Target: ${target}. Return JSON with summary/findings/confidence.`, dependsOn: ['intake'], timeoutSeconds: 240, retry: { maxRetries: 1, onExhausted: 'skip' } },
      { id: 'synthesize', worker: 'analyst', label: 'Synthesize review', task: `Write final review.\nRisk: {{risk-review.findings}}\nFeasibility: {{feasibility-review.findings}}\nImplementation: {{implementation-review.findings}}\nReturn JSON: { "accepted": true, "summary": "...", "findings": [...], "recommendations": [...], "deliverable": "final review" }.`, dependsOn: ['risk-review', 'feasibility-review', 'implementation-review'], timeoutSeconds: 300 },
    ],
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}
