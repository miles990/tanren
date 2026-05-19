import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProvider } from '../provider-registry.js'
import type { PromptContentBlock } from '../types.js'
import { createGateway, type CLIBackend } from './acp-gateway.js'
import { PlanEngine, type ActionPlan, type PlanEngineOptions, type PlanResult, type StepResult } from './plan-engine.js'
import { PresetManager } from './presets.js'
import { ResultBuffer, type TaskEvent, type TaskStatus } from './result-buffer.js'
import { PLAN_TEMPLATES } from './templates.js'
import { cleanupCycleWorktree, createCycleWorktree, type WorktreeContext, type WorktreeIsolationConfig } from './worktree.js'
import { createWorkerRuntime } from './worker-runtime.js'
import { WORKERS, type WorkerDefinition } from './workers.js'

export interface OrchestrationMiddlewareConfig {
  cwd?: string
}

export function createOrchestrationMiddleware(config: OrchestrationMiddlewareConfig = {}) {
  const cwd = config.cwd ?? process.cwd()
  const buffer = new ResultBuffer()
  buffer.enablePersistence(cwd)
  const customWorkers = new Map<string, WorkerDefinition>()
  const customWorkersPath = join(cwd, 'workers.json')

  try {
    const saved = JSON.parse(readFileSync(customWorkersPath, 'utf-8')) as Record<string, WorkerDefinition>
    for (const [name, def] of Object.entries(saved)) customWorkers.set(name, def)
  } catch { /* first run */ }

  const acpGateway = createGateway()
  const runtime = createWorkerRuntime({ cwd, workers: Object.fromEntries(customWorkers), acpGateway })
  const presetManager = new PresetManager(cwd)
  type PlanStatus = 'executing' | 'completed' | 'failed' | 'abandoned'
  type PlanEntry = {
    plan: ActionPlan
    resultPromise?: Promise<PlanResult>
    worktree?: WorktreeContext
    boundaryStatus?: string[]
    status: PlanStatus
    createdAt: string
    completedAt?: string
    repairOf?: string
    repairAttempt?: number
  }
  const plans = new Map<string, PlanEntry>()
  let planCounter = 0
  const plansPath = join(cwd, 'plans-state.json')

  const allWorkers = () => ({ ...WORKERS, ...Object.fromEntries(customWorkers) })
  const persistCustomWorkers = () => {
    try { writeFileSync(customWorkersPath, JSON.stringify(Object.fromEntries(customWorkers), null, 2), 'utf-8') } catch { /* fail-open */ }
  }
  const nextPlanId = () => `plan-${Date.now()}-${(planCounter++).toString(36)}`

  const persistPlans = () => {
    try {
      writeFileSync(plansPath, JSON.stringify([...plans.entries()].map(([planId, entry]) => ({
        planId,
        plan: entry.plan,
        worktree: entry.worktree,
        status: entry.status,
        createdAt: entry.createdAt,
        completedAt: entry.completedAt,
        repairOf: entry.repairOf,
        repairAttempt: entry.repairAttempt,
        boundaryStatus: entry.boundaryStatus,
      })), null, 2), 'utf-8')
    } catch { /* fail-open */ }
  }

  const planEngineOptions = (planId?: string, planCwd = cwd): PlanEngineOptions => ({
    cwd: planCwd,
    getWorkerTimeoutSeconds: workerName => allWorkers()[workerName]?.defaultTimeoutSeconds ?? 120,
    onEvent: event => {
      switch (event.type) {
        case 'step.dispatched':
          buffer.start(event.step.id, planId)
          break
        case 'step.completed':
          buffer.complete(event.result.id, event.result.output, planId)
          break
        case 'step.failed':
          buffer.fail(event.result.id, event.result.output, planId)
          break
        default:
          buffer.broadcast({ type: event.type, data: event })
          break
      }
    },
  })
  const createPlanEngine = (planRuntime = runtime, planId?: string, planCwd = cwd) => new PlanEngine(planRuntime.executeWorker, planEngineOptions(planId, planCwd))
  const planEngine = createPlanEngine()

  const activePlans = () => [...plans.entries()].filter(([, entry]) => entry.status === 'executing')
  const hasActivePlan = () => activePlans().length > 0

  const gitStatus = (repoPath: string): string[] => {
    try {
      return execFileSync('git', ['-C', repoPath, 'status', '--porcelain'], { encoding: 'utf-8' })
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  const verifyWorktreeBoundary = (entry: PlanEntry): string | null => {
    if (!entry.worktree?.repoRoot || !entry.boundaryStatus) return null
    const before = new Set(entry.boundaryStatus)
    const after = gitStatus(entry.worktree.repoRoot)
    const unexpected = after.filter(line => !before.has(line))
    return unexpected.length
      ? `Plan wrote outside isolated worktree. Main repo changed: ${unexpected.join(', ')}`
      : null
  }

  const failSyntheticStep = (planId: string, id: string, message: string) => {
    if (!buffer.get(id, planId)) buffer.submit({ id, planId, worker: 'scheduler', task: message, label: 'Scheduler verification' })
    buffer.start(id, planId)
    buffer.fail(id, message, planId)
  }

  const initialResultsFor = (planId: string): StepResult[] => buffer.list({ planId })
    .filter(task => task.status === 'completed' || task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled')
    .map((task, index) => ({
      id: task.id,
      worker: task.worker,
      status: (task.status === 'cancelled' ? 'skipped' : task.status) as StepResult['status'],
      output: String(task.result ?? task.error ?? ''),
      durationMs: task.durationMs ?? 0,
      dispatchOrder: index,
    }))

  const ensurePlanTasksSubmitted = (planId: string, plan: ActionPlan, caller?: string) => {
    for (const step of plan.steps) {
      if (!buffer.get(step.id, planId)) buffer.submit({ id: step.id, planId, worker: step.worker, task: step.task, label: step.label, caller })
    }
  }

  const startPlanExecution = (planId: string, entry: PlanEntry, planRuntime = runtime, planCwd = cwd, caller?: string, repair?: PlanRequest['repair']) => {
    ensurePlanTasksSubmitted(planId, entry.plan, caller)
    const engine = createPlanEngine(planRuntime, planId, planCwd)
    const resultPromise = engine.execute(entry.plan, initialResultsFor(planId))
    entry.resultPromise = resultPromise
    entry.status = 'executing'
    persistPlans()
    resultPromise.then(result => {
      entry.completedAt = new Date().toISOString()
      const boundaryError = verifyWorktreeBoundary(entry)
      if (boundaryError) failSyntheticStep(planId, 'worktree-boundary', boundaryError)
      const shouldRepair = result.summary.failed > 0 || !!boundaryError
      entry.status = shouldRepair ? 'failed' : 'completed'
      if (!shouldRepair && entry.worktree && shouldCleanupWorktree(entry.worktree, result)) cleanupCycleWorktree(entry.worktree)
      persistPlans()
      maybeStartRepair(planId, entry, result, repair, boundaryError ?? undefined).catch(() => {})
    }).catch(() => {
      entry.completedAt = new Date().toISOString()
      entry.status = 'failed'
      persistPlans()
    })
    return resultPromise
  }

  const maybeStartRepair = async (failedPlanId: string, entry: PlanEntry, result: PlanResult, repair?: PlanRequest['repair'], boundaryError?: string) => {
    if (repair?.enabled === false || (result.summary.failed === 0 && !boundaryError)) return
    const attempt = (entry.repairAttempt ?? 0) + 1
    const maxAttempts = repair?.maxAttempts ?? 1
    if (attempt > maxAttempts) return
    const failedSteps = result.steps.filter(step => step.status === 'failed' || step.status === 'timeout')
    if (boundaryError) {
      failedSteps.push({
        id: 'worktree-boundary',
        worker: 'scheduler',
        status: 'failed',
        output: boundaryError,
        durationMs: 0,
        dispatchOrder: failedSteps.length,
      })
    }
    if (failedSteps.length === 0) return
    const repairWorker = repair?.worker ?? 'autopilot-producer'
    if (!allWorkers()[repairWorker]) return
    const repairPlan: ActionPlan = {
      goal: `Repair failed plan ${failedPlanId}: ${entry.plan.goal}`,
      acceptance: 'Repair only the failed steps, keep scope minimal, and produce a clear handoff.',
      steps: failedSteps.map(step => ({
        id: `repair-${step.id}`,
        worker: repairWorker,
        label: `Repair ${step.id}`,
        dependsOn: [],
        task: [
          `Repair failed step ${step.id} from plan ${failedPlanId}.`,
          `Original worker: ${step.worker}`,
          `Failure: ${step.output}`,
          'Read the relevant repo files and create the smallest safe fix or a concrete repair brief. Do not expand product scope.',
        ].join('\n\n'),
      })),
    }
    const repairPlanId = nextPlanId()
    const repairEntry: PlanEntry = {
      plan: repairPlan,
      status: 'executing',
      createdAt: new Date().toISOString(),
      repairOf: failedPlanId,
      repairAttempt: attempt,
      worktree: entry.worktree,
      boundaryStatus: entry.boundaryStatus,
    }
    plans.set(repairPlanId, repairEntry)
    const repairCwd = entry.worktree?.cwd ?? cwd
    const repairRuntime = entry.worktree
      ? createWorkerRuntime({ cwd: repairCwd, workers: Object.fromEntries(customWorkers), acpGateway })
      : runtime
    startPlanExecution(repairPlanId, repairEntry, repairRuntime, repairCwd, 'repair-cycle', { enabled: false })
  }

  function loadPersistedPlans() {
    try {
      const saved = JSON.parse(readFileSync(plansPath, 'utf-8')) as Array<Omit<PlanEntry, 'resultPromise'> & { planId: string }>
      for (const savedEntry of saved) {
        const { planId, ...entry } = savedEntry
        plans.set(planId, entry)
      }
    } catch { /* no persisted plans */ }
  }

  function resumePersistedPlans() {
    for (const [planId, entry] of plans) {
      if (entry.status !== 'executing') continue
      const planCwd = entry.worktree?.cwd ?? cwd
      const planRuntime = entry.worktree
        ? createWorkerRuntime({ cwd: planCwd, workers: Object.fromEntries(customWorkers), acpGateway })
        : runtime
      startPlanExecution(planId, entry, planRuntime, planCwd)
    }
  }

  const refreshProvider = (name: string, def: WorkerDefinition) => {
    runtime.workerProviders.delete(name)
    if (def.backend !== 'sdk' && def.backend !== 'acp') return
    if ((def.vendor ?? 'agent-sdk') === 'agent-sdk') {
      const next = createWorkerRuntime({ cwd, workers: { [name]: def }, acpGateway })
      const provider = next.workerProviders.get(name)
      if (provider) runtime.workerProviders.set(name, provider)
    } else {
      runtime.workerProviders.set(name, createProvider({ provider: def.vendor ?? 'agent-sdk', model: def.agent.model, options: def.providerOptions, cwd }))
    }
  }

  loadPersistedPlans()
  resumePersistedPlans()

  return {
    buffer,
    planEngine,
    createPlanEngine,
    runtime,
    executeWorker: runtime.executeWorker,
    workerProviders: runtime.workerProviders,
    customWorkers,
    persistCustomWorkers,
    acpGateway,
    presetManager,
    plans,
    get planCounter() { return planCounter },
    nextPlanId,
    allWorkers,
    refreshProvider,
    activePlans,
    hasActivePlan,
    startPlanExecution,
    gitStatus,
  }
}

export type OrchestrationMiddleware = ReturnType<typeof createOrchestrationMiddleware>

type PlanRequest = ActionPlan & {
  caller?: string
  isolation?: WorktreeIsolationConfig
  /** Default true: reject new plans while one is active for this repo. */
  schedulerLock?: boolean
  repair?: {
    enabled?: boolean
    worker?: string
    maxAttempts?: number
  }
}

type TemplatePlanRequest = {
  template: string
  params: Record<string, string>
  caller?: string
  isolation?: WorktreeIsolationConfig
  schedulerLock?: boolean
}

function shouldCleanupWorktree(worktree: WorktreeContext, result: PlanResult): boolean {
  if (worktree.cleanup === 'always') return true
  if (worktree.cleanup === 'on-success') return result.summary.failed === 0
  return false
}

function worktreeJson(worktree?: WorktreeContext) {
  if (!worktree) return undefined
  return {
    mode: worktree.mode,
    cwd: worktree.cwd,
    worktreePath: worktree.worktreePath,
    branchName: worktree.branchName,
    baseRef: worktree.baseRef,
    cleanup: worktree.cleanup,
  }
}

export function createOrchestrationRouter(config: OrchestrationMiddlewareConfig = {}): Hono {
  const mw = createOrchestrationMiddleware(config)
  const app = new Hono()

  app.get('/health', c => c.json({
    status: 'ok',
    service: 'tanren-orchestration',
    workers: Object.keys(mw.allWorkers()),
    tasks: mw.buffer.list({ limit: 1 }).length,
  }))

  app.post('/dispatch', async c => {
    const body = await c.req.json<{ worker: string; task: string | PromptContentBlock[]; timeout?: number; caller?: string }>()
    if (!body.worker || !body.task) return c.json({ error: 'worker and task required' }, 400)
    const worker = mw.allWorkers()[body.worker]
    if (!worker) return c.json({ error: `Unknown worker: ${body.worker}` }, 400)

    const timeoutMs = (body.timeout ?? worker.defaultTimeoutSeconds) * 1000
    const taskId = mw.buffer.submit({
      worker: body.worker,
      task: typeof body.task === 'string' ? body.task : `[multimodal: ${body.task.length} blocks]`,
      caller: body.caller,
    })
    mw.buffer.start(taskId)
    mw.executeWorker(body.worker, body.task, timeoutMs)
      .then(result => mw.buffer.complete(taskId, result))
      .catch(err => mw.buffer.fail(taskId, err instanceof Error ? err.message : String(err)))

    return c.json({ taskId, status: 'running' })
  })

  app.post('/plan', async c => {
    const body = await c.req.json<PlanRequest>()
    if (body.schedulerLock !== false && mw.hasActivePlan()) {
      return c.json({
        error: 'scheduler_locked',
        message: 'Another plan is already executing for this repo.',
        activePlans: mw.activePlans().map(([planId, entry]) => ({ planId, goal: entry.plan.goal, status: entry.status })),
      }, 409)
    }
    const plan: ActionPlan = { goal: body.goal, acceptance: body.acceptance, steps: body.steps, convergence: body.convergence }
    const errors = mw.planEngine.validate(plan, new Set(Object.keys(mw.allWorkers())))
    if (errors.length > 0) return c.json({ error: 'validation_failed', errors }, 400)

    const planId = mw.nextPlanId()
    let worktree: WorktreeContext | undefined
    let planRuntime = mw.runtime
    let planCwd = config.cwd ?? process.cwd()
    let boundaryStatus: string[] | undefined
    try {
      if (body.isolation?.mode === 'cycle-worktree') {
        worktree = createCycleWorktree(config.cwd ?? process.cwd(), planId, body.isolation)
        boundaryStatus = mw.gitStatus(worktree.repoRoot)
        const isolatedRuntime = createWorkerRuntime({
          cwd: worktree.cwd,
          workers: Object.fromEntries(mw.customWorkers),
          acpGateway: mw.acpGateway,
        })
        planRuntime = isolatedRuntime
        planCwd = worktree.cwd
      }
    } catch (err) {
      if (worktree) cleanupCycleWorktree(worktree)
      return c.json({ error: 'worktree_creation_failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }

    const entry = { plan, worktree, boundaryStatus, status: 'executing' as const, createdAt: new Date().toISOString() }
    mw.plans.set(planId, entry)
    mw.startPlanExecution(planId, entry, planRuntime, planCwd, body.caller, body.repair)

    return c.json({ planId, status: 'executing', steps: plan.steps.length, worktree: worktreeJson(worktree) })
  })

  app.get('/status/:id', c => {
    const task = mw.buffer.get(c.req.param('id'), c.req.query('planId'))
    return task ? c.json(task) : c.json({ error: 'not found' }, 404)
  })

  app.get('/plan/:id', c => {
    const planId = c.req.param('id')
    const entry = mw.plans.get(planId)
    if (!entry) return c.json({ error: 'not found' }, 404)
    const steps = mw.buffer.list({ planId })
    const completed = steps.filter(s => s.status === 'completed').length
    const failed = steps.filter(s => s.status === 'failed').length
    const running = steps.filter(s => s.status === 'running').length
    return c.json({
      planId,
      goal: entry.plan.goal,
      totalSteps: entry.plan.steps.length,
      completed,
      failed,
      running,
      pending: entry.plan.steps.length - completed - failed - running,
      steps,
      worktree: worktreeJson(entry.worktree),
    })
  })

  app.delete('/task/:id', c => mw.buffer.cancel(c.req.param('id'), c.req.query('planId')) ? c.json({ ok: true }) : c.json({ error: 'cannot cancel' }, 400))

  app.get('/pool', c => c.json({
    workers: Object.entries(mw.allWorkers()).map(([name, def]) => ({
      name, backend: def.backend, model: def.agent.model, timeout: def.defaultTimeoutSeconds,
      providerOptions: def.providerOptions,
    })),
    gateway: mw.acpGateway.getStats(),
  }))

  app.get('/events', c => streamSSE(c, async stream => {
    const unsubscribe = mw.buffer.subscribe((event: TaskEvent) => {
      stream.writeSSE({ event: event.type, data: JSON.stringify(event.task) }).catch(() => {})
    })
    const interval = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: new Date().toISOString() }).catch(() => {})
    }, 30_000)
    stream.onAbort(() => {
      unsubscribe()
      clearInterval(interval)
    })
    await new Promise(() => {})
  }))

  app.get('/tasks', c => {
    const status = c.req.query('status') as TaskStatus | undefined
    const limit = Number.parseInt(c.req.query('limit') ?? '50')
    const tasks = mw.buffer.list({ status, limit })
    return c.json({ tasks, total: tasks.length })
  })

  app.get('/workers', c => c.json({
    workers: Object.entries(mw.allWorkers()).map(([name, def]) => ({
      name,
      backend: def.backend,
      vendor: def.vendor,
      providerOptions: def.providerOptions,
      model: def.agent.model,
      description: def.agent.description,
      prompt: def.agent.prompt,
      tools: def.agent.tools,
      maxTurns: def.agent.maxTurns,
      timeout: def.defaultTimeoutSeconds,
      builtin: !!WORKERS[name],
    })),
  }))

  app.post('/workers', async c => {
    const body = await c.req.json<Partial<WorkerDefinition> & {
      name?: string
      backend?: WorkerDefinition['backend']
      model?: string
      description?: string
      prompt?: string
      tools?: string[]
      timeout?: number
      maxTurns?: number
      providerOptions?: Record<string, unknown>
    }>()
    if (!body.name) return c.json({ error: 'name required' }, 400)
    if (WORKERS[body.name]) return c.json({ error: 'cannot override built-in worker' }, 400)
    const def: WorkerDefinition = {
      agent: {
        description: body.description ?? `Custom worker: ${body.name}`,
        tools: body.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
        prompt: body.prompt ?? 'You are a helpful assistant.',
        model: body.model ?? 'sonnet',
        maxTurns: body.maxTurns ?? 10,
      },
      backend: body.backend ?? 'sdk',
      vendor: body.vendor,
      providerOptions: body.providerOptions,
      defaultTimeoutSeconds: body.timeout ?? body.defaultTimeoutSeconds ?? 120,
      webhook: body.webhook,
      logicFn: body.logicFn,
      mcpServers: body.mcpServers,
      skills: body.skills,
    }
    mw.customWorkers.set(body.name, def)
    mw.refreshProvider(body.name, def)
    mw.persistCustomWorkers()
    return c.json({ ok: true, name: body.name })
  })

  app.put('/workers/:name', async c => {
    const name = c.req.param('name')
    if (WORKERS[name]) return c.json({ error: 'cannot modify built-in worker' }, 400)
    const existing = mw.customWorkers.get(name)
    if (!existing) return c.json({ error: 'worker not found' }, 404)
    const body = await c.req.json<Partial<WorkerDefinition> & { model?: string; timeout?: number; maxTurns?: number }>()
    const updated: WorkerDefinition = {
      ...existing,
      ...body,
      agent: {
        ...existing.agent,
        ...body.agent,
        model: body.model ?? body.agent?.model ?? existing.agent.model,
        maxTurns: body.maxTurns ?? body.agent?.maxTurns ?? existing.agent.maxTurns,
      },
      defaultTimeoutSeconds: body.timeout ?? body.defaultTimeoutSeconds ?? existing.defaultTimeoutSeconds,
    }
    mw.customWorkers.set(name, updated)
    mw.refreshProvider(name, updated)
    mw.persistCustomWorkers()
    return c.json({ ok: true, name })
  })

  app.delete('/workers/:name', c => {
    const name = c.req.param('name')
    if (WORKERS[name]) return c.json({ error: 'cannot delete built-in worker' }, 400)
    if (!mw.customWorkers.has(name)) return c.json({ error: 'worker not found' }, 404)
    mw.customWorkers.delete(name)
    mw.workerProviders.delete(name)
    mw.persistCustomWorkers()
    return c.json({ ok: true })
  })

  app.get('/plans', c => c.json({
    plans: [...mw.plans.entries()].map(([planId, entry]) => {
      const steps = mw.buffer.list({ planId })
      return {
        planId,
        goal: entry.plan.goal,
        totalSteps: entry.plan.steps.length,
        completed: steps.filter(s => s.status === 'completed').length,
        failed: steps.filter(s => s.status === 'failed' || s.status === 'timeout').length,
        running: steps.filter(s => s.status === 'running').length,
        worktree: worktreeJson(entry.worktree),
        steps: entry.plan.steps.map(s => ({
          id: s.id,
          worker: s.worker,
          label: s.label,
          dependsOn: s.dependsOn,
          status: steps.find(t => t.id === s.id)?.status ?? 'pending',
          durationMs: steps.find(t => t.id === s.id)?.durationMs,
        })),
      }
    }),
  }))

  app.post('/plan/validate', async c => {
    const body = await c.req.json<PlanRequest>()
    const errors = mw.planEngine.validate(body, new Set(Object.keys(mw.allWorkers())))
    return c.json({ valid: errors.length === 0, errors })
  })

  app.get('/templates', c => c.json({ templates: PLAN_TEMPLATES }))
  app.post('/plan/from-template', async c => {
    const body = await c.req.json<TemplatePlanRequest>()
    if (body.schedulerLock !== false && mw.hasActivePlan()) {
      return c.json({
        error: 'scheduler_locked',
        message: 'Another plan is already executing for this repo.',
        activePlans: mw.activePlans().map(([planId, entry]) => ({ planId, goal: entry.plan.goal, status: entry.status })),
      }, 409)
    }
    const tpl = PLAN_TEMPLATES.find(t => t.name === body.template)
    if (!tpl) return c.json({ error: `Unknown template: ${body.template}` }, 400)
    const missing = tpl.params.filter(p => p.required && !body.params[p.name])
    if (missing.length > 0) return c.json({ error: 'missing_params', missing: missing.map(p => p.name) }, 400)
    let planJson = JSON.stringify(tpl.plan)
    for (const param of tpl.params) planJson = planJson.replaceAll(`{{${param.name}}}`, body.params[param.name] ?? '')
    const plan = JSON.parse(planJson) as ActionPlan
    const errors = mw.planEngine.validate(plan, new Set(Object.keys(mw.allWorkers())))
    if (errors.length > 0) return c.json({ error: 'template_validation_failed', errors }, 400)
    const planId = mw.nextPlanId()
    let worktree: WorktreeContext | undefined
    let planRuntime = mw.runtime
    let planCwd = config.cwd ?? process.cwd()
    let boundaryStatus: string[] | undefined
    try {
      if (body.isolation?.mode === 'cycle-worktree') {
        worktree = createCycleWorktree(config.cwd ?? process.cwd(), planId, body.isolation)
        boundaryStatus = mw.gitStatus(worktree.repoRoot)
        const isolatedRuntime = createWorkerRuntime({
          cwd: worktree.cwd,
          workers: Object.fromEntries(mw.customWorkers),
          acpGateway: mw.acpGateway,
        })
        planRuntime = isolatedRuntime
        planCwd = worktree.cwd
      }
    } catch (err) {
      if (worktree) cleanupCycleWorktree(worktree)
      return c.json({ error: 'worktree_creation_failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
    const entry = { plan, worktree, boundaryStatus, status: 'executing' as const, createdAt: new Date().toISOString() }
    mw.plans.set(planId, entry)
    mw.startPlanExecution(planId, entry, planRuntime, planCwd, body.caller)
    return c.json({ planId, status: 'executing', steps: plan.steps.length, template: body.template, worktree: worktreeJson(worktree) })
  })

  app.get('/archived', c => c.json({ tasks: mw.buffer.getArchived(Number.parseInt(c.req.query('limit') ?? '50')) }))
  app.get('/presets', c => c.json({ presets: mw.presetManager.list() }))
  app.post('/presets', async c => {
    const body = await c.req.json<{ name?: string; description?: string; tools?: string[]; model?: string; vendor?: string; backend?: string; timeout?: number; maxTurns?: number }>()
    if (!body.name) return c.json({ error: 'name required' }, 400)
    try {
      mw.presetManager.set({
        name: body.name,
        description: body.description ?? `Custom preset: ${body.name}`,
        tools: body.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
        model: body.model ?? 'sonnet',
        vendor: body.vendor ?? 'anthropic',
        backend: body.backend ?? 'sdk',
        timeout: body.timeout ?? 120,
        maxTurns: body.maxTurns ?? 10,
      })
      return c.json({ ok: true, name: body.name })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })
  app.delete('/presets/:name', c => {
    try {
      const ok = mw.presetManager.delete(c.req.param('name'))
      return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get('/gateway', c => c.json(mw.acpGateway.getStats()))
  app.post('/gateway/backends', async c => {
    const body = await c.req.json<CLIBackend>()
    if (!body.name || !body.command) return c.json({ error: 'name and command required' }, 400)
    body.maxSessions ??= 2
    body.args ??= []
    mw.acpGateway.register(body)
    return c.json({ ok: true, name: body.name })
  })
  app.delete('/gateway/backends/:name', c => {
    mw.acpGateway.unregister(c.req.param('name'))
    return c.json({ ok: true })
  })
  app.post('/gateway/dispatch', async c => {
    const body = await c.req.json<{ backend: string; task: string; timeout?: number }>()
    if (!body.backend || !body.task) return c.json({ error: 'backend and task required' }, 400)
    const taskId = mw.buffer.submit({ worker: `acp:${body.backend}`, task: body.task })
    mw.buffer.start(taskId)
    mw.acpGateway.dispatch(body.backend, body.task, (body.timeout ?? 120) * 1000)
      .then(result => mw.buffer.complete(taskId, result))
      .catch(err => mw.buffer.fail(taskId, err instanceof Error ? err.message : String(err)))
    return c.json({ taskId, status: 'running', backend: body.backend })
  })

  app.get('/', c => c.json({ service: 'tanren-orchestration', dashboard: false, health: '/health' }))
  return app
}
