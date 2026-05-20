import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createProvider } from '../provider-registry.js'
import type { PromptContentBlock } from '../types.js'
import { createGateway, type CLIBackend } from './acp-gateway.js'
import { auditBranchHygiene, cleanupMergedCycleBranches, type BranchHygienePolicy } from './branch-hygiene.js'
import { evaluateExecutionHarnessFailure, evaluatePlanStepApproval, type ApprovalEvaluation } from './execution-harness.js'
import { readStepLearningEvents, recordStepLearningEvent, type StepLearningEvent } from './learning-events.js'
import { PlanEventLog } from './plan-events.js'
import { PlanEngine, type ActionPlan, type PlanEngineOptions, type PlanResult, type PlanStep, type StepResult } from './plan-engine.js'
import { writeProductionReports, type ProductionReportConfig } from './production-reports.js'
import { PresetManager } from './presets.js'
import { ResultBuffer, type TaskEvent, type TaskStatus } from './result-buffer.js'
import { RepoSchedulerLock, SchedulerLockError, type SchedulerLockHandle } from './scheduler-lock.js'
import { buildSmallestProductSlicePlan, evaluateSupervisor, selectSmallestProductSliceWorkers, type SupervisorPlanSnapshot, type SupervisorStepSnapshot, type SupervisorTickInput, type SupervisorTickResult } from './supervisor.js'
import { PLAN_TEMPLATES } from './templates.js'
import { cleanupCycleWorktree, createCycleWorktree, type WorktreeContext, type WorktreeIsolationConfig } from './worktree.js'
import { createWorkerRuntime } from './worker-runtime.js'
import { WORKERS, type WorkerDefinition, type WorkerGate } from './workers.js'

export interface OrchestrationMiddlewareConfig {
  cwd?: string
  branchHygiene?: BranchHygienePolicy
  productionReports?: ProductionReportConfig
  maxInternalRepairAttempts?: number
}

type WorkerQualificationStatus = 'unverified' | 'running' | 'passed' | 'failed' | 'blocked'

type WorkerQualificationSpec = {
  worker: string
  title?: string
  task: string
  acceptance?: string
  mode?: PlanStep['mode']
  timeoutSeconds?: number
  verifyCommand?: string
  artifactContract?: PlanStep['artifactContract']
  requiredForProduction?: boolean
}

type WorkerQualificationResult = {
  worker: string
  status: WorkerQualificationStatus
  planId?: string
  stepId?: string
  updatedAt: string
  summary?: string
}

const QUALIFICATION_GOAL_PREFIX = 'Worker qualification'

export function createOrchestrationMiddleware(config: OrchestrationMiddlewareConfig = {}) {
  const cwd = config.cwd ?? process.cwd()
  const buffer = new ResultBuffer()
  buffer.enablePersistence(cwd)
  const customWorkers = new Map<string, WorkerDefinition>()
  const customWorkersPath = join(cwd, 'workers.json')
  const workerQualificationsPath = join(cwd, 'worker-qualifications.json')
  const workerQualificationResultsPath = join(cwd, 'worker-qualification-results.json')
  const knowledgeGraphNamespace = process.env.TANREN_KG_NAMESPACE || basename(cwd)

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
    schedulerLock?: boolean
    lockPlanId?: string
    lockHandle?: SchedulerLockHandle
  }
  const plans = new Map<string, PlanEntry>()
  let planCounter = 0
  const plansPath = join(cwd, 'plans-state.json')
  const planEvents = new PlanEventLog(cwd)
  const schedulerLock = new RepoSchedulerLock(cwd)
  const heartbeatTimers = new Map<string, NodeJS.Timeout>()
  const activeEngines = new Map<string, PlanEngine>()
  const approvalDecisions: ApprovalEvaluation[] = []
  const runtimeTrace: Array<{ type: string; timestamp: string; data: unknown }> = []
  const learningTrace: StepLearningEvent[] = readStepLearningEvents(cwd, 100)

  const allWorkers = () => ({ ...WORKERS, ...Object.fromEntries(customWorkers) })
  const workerQualificationSpecs = (): WorkerQualificationSpec[] => {
    try {
      const parsed = JSON.parse(readFileSync(workerQualificationsPath, 'utf-8')) as { workers?: WorkerQualificationSpec[] } | WorkerQualificationSpec[]
      return (Array.isArray(parsed) ? parsed : parsed.workers ?? []).filter(spec => spec?.worker && spec?.task)
    } catch {
      return []
    }
  }
  const readQualificationResults = (): Record<string, WorkerQualificationResult> => {
    try {
      return JSON.parse(readFileSync(workerQualificationResultsPath, 'utf-8')) as Record<string, WorkerQualificationResult>
    } catch {
      return {}
    }
  }
  const writeQualificationResults = (results: Record<string, WorkerQualificationResult>) => {
    try { writeFileSync(workerQualificationResultsPath, JSON.stringify(results, null, 2), 'utf-8') } catch { /* fail-open */ }
  }
  const writeQualificationContextToKg = (result: WorkerQualificationResult) => {
    const kgApi = (process.env.TANREN_KG_API || process.env.KG_API || 'http://localhost:3310').replace(/\/$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const apiKey = process.env.TANREN_KG_API_KEY || process.env.KG_API_KEY
    if (apiKey) headers['x-api-key'] = apiKey
    fetch(`${kgApi}/api/write/triple`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subject: result.worker,
        subject_type: 'worker',
        predicate: 'has_qualification_status',
        object: result.status,
        object_type: 'qualification_status',
        confidence: result.status === 'passed' ? 0.9 : 0.75,
        source_agent: 'tanren',
        namespace: knowledgeGraphNamespace,
        description: result.summary ?? `Worker ${result.worker} qualification status is ${result.status}.`,
        properties: {
          planId: result.planId,
          stepId: result.stepId,
          updatedAt: result.updatedAt,
        },
      }),
    }).catch(() => undefined)
  }
  const qualificationStatusFor = (worker: string): WorkerQualificationResult => {
    return readQualificationResults()[worker] ?? { worker, status: 'unverified', updatedAt: new Date(0).toISOString() }
  }
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
        schedulerLock: entry.schedulerLock,
        lockPlanId: entry.lockPlanId,
      })), null, 2), 'utf-8')
    } catch { /* fail-open */ }
  }

  const planEngineOptions = (planId?: string, planCwd = cwd): PlanEngineOptions => ({
    cwd: planCwd,
    getWorkerTimeoutSeconds: workerName => allWorkers()[workerName]?.defaultTimeoutSeconds ?? 120,
    getWorkerMaxConcurrency: workerName => allWorkers()[workerName]?.maxConcurrency,
    onEvent: event => {
      switch (event.type) {
        case 'step.dispatched':
          buffer.start(event.step.id, planId)
          if (planId) planEvents.appendEngineEvent(planId, event)
          break
        case 'step.completed':
          buffer.complete(event.result.id, event.result.output, planId)
          if (planId) {
            const plan = plans.get(planId)?.plan
            const step = plan?.steps.find(candidate => candidate.id === event.result.id)
            const worker = step ? allWorkers()[step.worker] : allWorkers()[event.result.worker]
            const learned = recordStepLearningEvent({ cwd, planId, step, result: event.result, worker })
            if (learned) {
              learningTrace.unshift(learned)
              learningTrace.splice(100)
              runtimeTrace.unshift({ type: 'learning.extracted', timestamp: learned.timestamp, data: learned })
              runtimeTrace.splice(200)
            }
          }
          if (planId) planEvents.appendEngineEvent(planId, event)
          break
        case 'step.failed':
          buffer.fail(event.result.id, event.result.output, planId)
          if (planId) planEvents.appendEngineEvent(planId, event)
          break
        case 'plan.completed':
          if (planId) recordQualificationResults(planId, event.result)
          buffer.broadcast({ type: event.type, data: event })
          if (planId) planEvents.appendEngineEvent(planId, event)
          break
        default:
          buffer.broadcast({ type: event.type, data: event })
          if (planId) planEvents.appendEngineEvent(planId, event)
          break
      }
    },
  })
  const createPlanEngine = (planRuntime = runtime, planId?: string, planCwd = cwd) => new PlanEngine(planRuntime.executeWorker, planEngineOptions(planId, planCwd))
  const planEngine = createPlanEngine()

  const activePlans = () => [...plans.entries()].filter(([, entry]) => entry.status === 'executing')
  const hasActivePlan = () => activePlans().length > 0
  const activeCycleBranches = () => activePlans()
    .map(([, entry]) => entry.worktree?.branchName)
    .filter((branch): branch is string => Boolean(branch))
  const branchHygieneStatus = () => auditBranchHygiene(cwd, activeCycleBranches(), config.branchHygiene)
  const cleanupBranchHygiene = (opts?: { dryRun?: boolean }) => cleanupMergedCycleBranches(cwd, activeCycleBranches(), config.branchHygiene, opts)
  const isQualificationPlan = (plan?: ActionPlan) => Boolean(plan?.goal?.startsWith(QUALIFICATION_GOAL_PREFIX))
  const qualificationStepId = (worker: string) => `qualify-${worker.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
  const qualificationStatusFromOutput = (output: string): WorkerQualificationStatus => {
    const text = String(output ?? '')
    if (/\bPASS(?:ED)?\b|通過/i.test(text)) return 'passed'
    if (/\bBLOCKED\b|卡住|需要人工|NEED HUMAN/i.test(text)) return 'blocked'
    return 'failed'
  }
  const recordQualificationResults = (planId: string, result: PlanResult) => {
    const entry = plans.get(planId)
    if (!isQualificationPlan(entry?.plan)) return
    const specs = workerQualificationSpecs()
    const results = readQualificationResults()
    for (const spec of specs) {
      const step = result.steps.find(candidate => candidate.id === qualificationStepId(spec.worker))
      if (!step) continue
      const status: WorkerQualificationStatus = step.status === 'completed'
        ? qualificationStatusFromOutput(step.output)
        : step.status === 'skipped' || step.status === 'condition_skipped'
          ? 'blocked'
          : 'failed'
      results[spec.worker] = {
        worker: spec.worker,
        status,
        planId,
        stepId: step.id,
        updatedAt: new Date().toISOString(),
        summary: step.output.slice(0, 1000),
      }
      writeQualificationContextToKg(results[spec.worker])
    }
    writeQualificationResults(results)
  }
  const writeProductionSnapshot = (trigger?: { type: string; planId?: string; status?: string }) => {
    if (!config.productionReports) return
    try {
      writeProductionReports(cwd, config.productionReports, {
        timestamp: new Date().toISOString(),
        objective: objectiveStatus(),
        branchHygiene: branchHygieneStatus(),
        trigger,
      })
    } catch (err) {
      runtimeTrace.unshift({ type: 'production_reports.failed', timestamp: new Date().toISOString(), data: { error: err instanceof Error ? err.message : String(err), trigger } })
      runtimeTrace.splice(200)
    }
  }
  const latestPlan = () => [...plans.entries()]
    .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))[0]

  const writerWorkers = () => new Set(Object.entries(allWorkers())
    .filter(([, def]) => def.backend === 'shell' || def.backend === 'docker' || def.backend === 'swarm' || (def.agent.tools ?? []).some(tool => ['Write', 'Edit'].includes(String(tool))))
    .map(([name]) => name))

  const inferStepMode = (step: PlanStep, def: WorkerDefinition): NonNullable<PlanStep['mode']> => {
    if (step.mode) return step.mode
    if (def.policy?.defaultMode) return def.policy.defaultMode
    if (def.backend === 'shell' || def.backend === 'docker' || def.backend === 'swarm') return 'verify'
    if ((def.agent.tools ?? []).some(tool => ['Write', 'Edit'].includes(String(tool)))) return 'write'
    return 'read'
  }

  const hasDownstreamGate = (plan: ActionPlan, stepId: string, gate: WorkerGate): boolean => {
    const byDependency = new Map<string, PlanStep[]>()
    for (const candidate of plan.steps) {
      for (const dep of candidate.dependsOn) {
        const next = byDependency.get(dep) ?? []
        next.push(candidate)
        byDependency.set(dep, next)
      }
    }
    const seen = new Set<string>()
    const queue = [...(byDependency.get(stepId) ?? [])]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (seen.has(current.id)) continue
      seen.add(current.id)
      if (current.gate === gate) return true
      queue.push(...(byDependency.get(current.id) ?? []))
    }
    return false
  }

  const validateExecutionPolicy = (plan: ActionPlan, opts?: { enforceContracts?: boolean }): string[] => {
    if (opts?.enforceContracts === false) return []
    const writers = writerWorkers()
    const errors: string[] = []
    const qualificationSpecs = workerQualificationSpecs()
    const requiredQualifications = new Map(qualificationSpecs.filter(spec => spec.requiredForProduction).map(spec => [spec.worker, spec]))
    const qualificationResults = readQualificationResults()
    for (const step of plan.steps) {
      const worker = allWorkers()[step.worker]
      if (!worker) continue
      const requiredQualification = requiredQualifications.get(step.worker)
      const qualified = qualificationResults[step.worker]?.status === 'passed'
      if (requiredQualification && !qualified && !isQualificationPlan(plan)) {
        errors.push(`Step ${step.id}: worker '${step.worker}' must pass worker qualification before production use`)
      }
      const policy = worker.policy
      const mode = inferStepMode(step, worker)
      if (policy?.allowedBackends?.length && !policy.allowedBackends.includes(worker.backend)) {
        errors.push(`Step ${step.id}: worker '${step.worker}' backend '${worker.backend}' is not allowed by worker policy`)
      }
      if (policy?.capabilities?.length && !policy.capabilities.includes(mode)) {
        errors.push(`Step ${step.id}: worker '${step.worker}' does not allow mode '${mode}'`)
      }
      const writes = mode === 'write' || mode === 'report'
      const contractRequired = writes && (writers.has(step.worker) || policy?.requiresArtifactContract === true)
      if (contractRequired) {
        if (!step.verifyCommand) errors.push(`Step ${step.id}: writer worker '${step.worker}' requires verifyCommand`)
        if (!step.artifactContract?.allowedPaths?.length) errors.push(`Step ${step.id}: writer worker '${step.worker}' requires artifactContract.allowedPaths`)
        if (!step.artifactContract?.expectedPaths?.length) errors.push(`Step ${step.id}: writer worker '${step.worker}' requires artifactContract.expectedPaths`)
      }
      if (writes && policy?.gates?.length) {
        for (const gate of policy.gates) {
          if (!hasDownstreamGate(plan, step.id, gate)) {
            errors.push(`Step ${step.id}: worker '${step.worker}' policy requires downstream '${gate}' gate`)
          }
        }
      }
    }
    return errors
  }

  const startHeartbeat = (entry: PlanEntry) => {
    if (!entry.schedulerLock || !entry.lockHandle) return
    const key = entry.lockPlanId ?? entry.lockHandle.record.planId
    if (heartbeatTimers.has(key)) return
    entry.lockHandle.heartbeat()
    const timer = setInterval(() => entry.lockHandle?.heartbeat(), 15_000)
    timer.unref?.()
    heartbeatTimers.set(key, timer)
  }

  const releaseSchedulerLock = (entry: PlanEntry) => {
    if (!entry.schedulerLock || !entry.lockHandle) return
    const key = entry.lockPlanId ?? entry.lockHandle.record.planId
    const timer = heartbeatTimers.get(key)
    if (timer) clearInterval(timer)
    heartbeatTimers.delete(key)
    entry.lockHandle.release()
    planEvents.append({ type: 'lock.released', planId: key })
  }

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

  const normalizeRepairStepTimeouts = (entry: PlanEntry) => {
    if (!entry.repairOf) return
    for (const step of entry.plan.steps) {
      if (step.timeoutSeconds) continue
      if (step.id.startsWith('classify-')) step.timeoutSeconds = 180
      else if (step.id.startsWith('fix-')) step.timeoutSeconds = 300
      else if (step.id === 'repair-verify') step.timeoutSeconds = 180
      else if (step.id === 'repair-report') step.timeoutSeconds = 180
    }
  }

  const startPlanExecution = (planId: string, entry: PlanEntry, planRuntime = runtime, planCwd = cwd, caller?: string, repair?: PlanRequest['repair']) => {
    normalizeRepairStepTimeouts(entry)
    if (entry.schedulerLock && !entry.lockHandle) {
      entry.lockHandle = schedulerLock.adopt({ planId: entry.lockPlanId ?? planId, goal: entry.plan.goal })
      planEvents.append({ type: 'lock.acquired', planId: entry.lockPlanId ?? planId })
    }
    startHeartbeat(entry)
    ensurePlanTasksSubmitted(planId, entry.plan, caller)
    const engine = createPlanEngine(planRuntime, planId, planCwd)
    activeEngines.set(planId, engine)
    const resultPromise = engine.execute(entry.plan, initialResultsFor(planId))
    entry.resultPromise = resultPromise
    entry.status = 'executing'
    planEvents.append({ type: 'plan.started', planId, attempt: entry.repairAttempt ?? 0 })
    persistPlans()
    resultPromise.then(async result => {
      activeEngines.delete(planId)
      entry.completedAt = new Date().toISOString()
      const boundaryError = verifyWorktreeBoundary(entry)
      if (boundaryError) failSyntheticStep(planId, 'worktree-boundary', boundaryError)
      const shouldRepair = result.summary.failed > 0 || !!boundaryError
      entry.status = shouldRepair ? 'failed' : 'completed'
      let repairStarted = false
      let downstreamResumed = false
      if (shouldRepair) repairStarted = await maybeStartRepair(planId, entry, result, repair, boundaryError ?? undefined)
      planEvents.append({ type: 'plan.completed', planId, status: entry.status })
      if (!shouldRepair && entry.repairOf) {
        downstreamResumed = resumeDownstreamAfterRepair(planId, entry).status === 'executing'
      }
      if (!shouldRepair && !downstreamResumed && entry.worktree && shouldCleanupWorktree(entry.worktree, result)) cleanupCycleWorktree(entry.worktree)
      if (!repairStarted && !downstreamResumed) releaseSchedulerLock(entry)
      persistPlans()
      writeProductionSnapshot({ type: 'plan.completed', planId, status: entry.status })
    }).catch(() => {
      activeEngines.delete(planId)
      entry.completedAt = new Date().toISOString()
      entry.status = 'failed'
      releaseSchedulerLock(entry)
      planEvents.append({ type: 'plan.failed', planId, error: 'Plan execution promise rejected' })
      persistPlans()
      writeProductionSnapshot({ type: 'plan.failed', planId, status: entry.status })
    })
    return resultPromise
  }

  const blockingFailedSteps = (planId: string, entry: PlanEntry) => {
    const stepById = new Map(entry.plan.steps.map(step => [step.id, step]))
    return buffer.list({ planId }).filter(step =>
      (step.status === 'failed' || step.status === 'timeout')
      && stepById.get(step.id)?.blocking !== false,
    )
  }

  const planMerged = (planId: string) => planEvents.readAll().some(event => event.type === 'merge.completed' && event.planId === planId)

  const stepTimeoutMs = (step: PlanStep) => {
    const timeoutSeconds = step.timeoutSeconds ?? allWorkers()[step.worker]?.defaultTimeoutSeconds ?? 120
    return Math.max(1_000, timeoutSeconds * 1000)
  }

  const syntheticPlanResult = (planId: string, entry: PlanEntry): PlanResult => {
    const steps = entry.plan.steps.map((step, index): StepResult => {
      const task = buffer.get(step.id, planId)
      const status = task?.status === 'timeout' || task?.status === 'failed' || task?.status === 'completed'
        ? task.status
        : task?.status === 'cancelled'
          ? 'skipped'
          : 'skipped'
      return {
        id: step.id,
        worker: step.worker,
        status: status as StepResult['status'],
        output: String(task?.result ?? task?.error ?? (task?.status === 'pending' ? 'Pending when plan was reaped' : 'Skipped when plan was reaped')),
        durationMs: task?.durationMs ?? 0,
        dispatchOrder: index,
      }
    })
    const failed = steps.filter(step => step.status === 'failed' || step.status === 'timeout').length
    const skipped = steps.filter(step => step.status === 'skipped').length
    const conditionSkipped = steps.filter(step => step.status === 'condition_skipped').length
    return {
      goal: entry.plan.goal,
      acceptance: entry.plan.acceptance,
      steps,
      totalDurationMs: 0,
      summary: {
        completed: steps.filter(step => step.status === 'completed').length,
        failed,
        skipped,
        conditionSkipped,
      },
      lowConfidenceSteps: [],
      digestContext: '',
      digestInput: {
        goal: entry.plan.goal,
        acceptance: entry.plan.acceptance,
        completedSteps: [],
        failedSteps: steps.filter(step => step.status === 'failed' || step.status === 'timeout').map(step => ({ id: step.id, worker: step.worker, error: step.output })),
        criticalFindings: [],
        replanCandidates: [],
      },
      accepted: failed === 0,
      convergenceIterations: 0,
    }
  }

  const reapStaleRunningTasks = async (opts?: { graceMs?: number; startRepair?: boolean }) => {
    const graceMs = opts?.graceMs ?? 30_000
    const startRepair = opts?.startRepair ?? true
    const reaped: Array<{ planId: string; stepId: string; ageMs: number; timeoutMs: number }> = []
    for (const [planId, entry] of activePlans()) {
      const stepsById = new Map(entry.plan.steps.map(step => [step.id, step]))
      for (const task of buffer.list({ planId, status: 'running' })) {
        const step = stepsById.get(task.id)
        if (!step || !task.startedAt) continue
        const timeoutMs = stepTimeoutMs(step)
        const ageMs = Date.now() - task.startedAt.getTime()
        if (ageMs <= timeoutMs + graceMs) continue
        const message = `Stale running task exceeded timeout: ${task.id} age=${ageMs}ms timeout=${timeoutMs}ms`
        activeEngines.get(planId)?.cancelStep(task.id)
        buffer.timeout(task.id, message, planId)
        planEvents.append({ type: 'step.failed', planId, stepId: task.id, worker: task.worker, status: 'timeout', output: message })
        reaped.push({ planId, stepId: task.id, ageMs, timeoutMs })
      }
      if (reaped.some(item => item.planId === planId)) {
        activeEngines.get(planId)?.cancelAll()
        activeEngines.delete(planId)
        entry.status = 'failed'
        entry.completedAt = new Date().toISOString()
        const result = syntheticPlanResult(planId, entry)
        let repairStarted = false
        if (startRepair) repairStarted = await maybeStartRepair(planId, entry, result, { maxAttempts: config.maxInternalRepairAttempts ?? 2 })
        planEvents.append({ type: 'plan.failed', planId, error: 'stale running task watchdog reaped plan' })
        if (!repairStarted) releaseSchedulerLock(entry)
        persistPlans()
      }
    }
    if (reaped.length > 0) {
      runtimeTrace.unshift({ type: 'watchdog.reaped_stale_tasks', timestamp: new Date().toISOString(), data: { reaped } })
      runtimeTrace.splice(200)
    }
    return reaped
  }

  const closeIneffectiveActiveRepairPlans = () => {
    const closed: Array<{ planId: string; failedStepIds: string[]; runningStepIds: string[] }> = []
    for (const [planId, entry] of activePlans()) {
      if (!entry.repairOf) continue
      const isNestedRepair = Boolean(plans.get(entry.repairOf)?.repairOf)
      const failed = blockingFailedSteps(planId, entry)
      if (failed.length === 0 && !isNestedRepair) continue
      const failedIds = failed.map(step => step.id)
      const shouldClose = failed.length >= 2 || failedIds.some(id => id.startsWith('fix-') || id === 'repair-verify' || id === 'repair-report')
      if (!shouldClose && !isNestedRepair) continue

      const running = buffer.list({ planId, status: 'running' })
      activeEngines.get(planId)?.cancelAll()
      activeEngines.delete(planId)
      for (const task of running) buffer.cancel(task.id, planId)
      entry.status = 'failed'
      entry.completedAt = new Date().toISOString()
      planEvents.append({
        type: 'plan.failed',
        planId,
        error: isNestedRepair
          ? `repair circuit breaker closed nested repair; repairOf=${entry.repairOf}`
          : `repair circuit breaker closed ineffective active repair; failed=${failedIds.join(', ')}`,
      })
      releaseSchedulerLock(entry)
      closed.push({ planId, failedStepIds: failedIds, runningStepIds: running.map(task => task.id) })
    }
    if (closed.length > 0) {
      runtimeTrace.unshift({ type: 'repair.circuit_breaker.closed', timestamp: new Date().toISOString(), data: { closed } })
      runtimeTrace.splice(200)
      persistPlans()
      for (const item of closed) writeProductionSnapshot({ type: 'repair.circuit_breaker.closed', planId: item.planId, status: 'failed' })
    }
    return closed
  }

  const classifyTaskError = (text: unknown): string | undefined => {
    const message = String(text ?? '')
    if (!message) return undefined
    if (/timeout/i.test(message)) return 'timeout'
    if (/max(?:imum)? number of turns|maxTurns/i.test(message)) return 'max_turns'
    if (/ENOENT|no such file or directory|output error/i.test(message)) return 'missing_artifact'
    if (/socket connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|temporar/i.test(message)) return 'transient_infra'
    if (/ARTIFACT CONTRACT FAILED/i.test(message)) return 'artifact_contract'
    if (/VERIFY FAILED/i.test(message)) return 'verification'
    if (/worktree|outside isolated worktree/i.test(message)) return 'worktree_boundary'
    if (/exited with code/i.test(message)) return 'process_exit'
    if (/aborted by user|cancelled/i.test(message)) return 'interrupted'
    return 'worker_error'
  }

  const completedRepairResumeTarget = (repairPlanId: string, repairEntry: PlanEntry) => {
    if (repairEntry.status !== 'completed' || !repairEntry.repairOf) return null
    const originalPlanId = repairEntry.repairOf
    const originalEntry = plans.get(originalPlanId)
    if (!originalEntry) return null
    if (activePlans().some(([planId]) => planId === originalPlanId)) return null
    const originalStepIds = new Set(originalEntry.plan.steps.map(step => step.id))
    const failedSteps = blockingFailedSteps(originalPlanId, originalEntry)
      .filter(task => originalStepIds.has(task.id))
    const hasPendingDownstream = originalEntry.plan.steps.some(step => {
      const task = buffer.get(step.id, originalPlanId)
      return step.dependsOn.length > 0 && (!task || task.status === 'pending')
    })
    const gates = gateSummary(originalEntry, buffer.list({ planId: originalPlanId }))
    if (originalEntry.status === 'failed' && (failedSteps.length > 0 || hasPendingDownstream || gates.nextGate)) {
      return { originalPlanId, originalEntry, failedSteps, gates }
    }
    return null
  }

  const resumeDownstreamAfterRepair = (repairPlanId: string, repairEntry: PlanEntry, opts?: { dryRun?: boolean }): SupervisorTickResult => {
    const target = completedRepairResumeTarget(repairPlanId, repairEntry)
    const decision = {
      action: 'resume_downstream' as const,
      failureType: 'none' as const,
      reason: 'repair completed; resume original product DAG downstream gates',
      targetPlanId: repairEntry.repairOf,
      targetStepId: repairPlanId,
      requiresBoss: false,
    }
    if (!target) return { action: 'resume_downstream', decision, status: 'no_action', error: 'no_repair_resume_target' }
    if (opts?.dryRun) {
      return {
        action: 'resume_downstream',
        decision: { ...decision, targetPlanId: target.originalPlanId },
        status: 'dry_run',
        submittedPlanId: target.originalPlanId,
      }
    }

    if (target.originalEntry.schedulerLock !== false && !target.originalEntry.lockHandle) {
      try {
        target.originalEntry.lockHandle = schedulerLock.acquire({
          planId: target.originalEntry.lockPlanId ?? target.originalPlanId,
          goal: target.originalEntry.plan.goal,
        })
        target.originalEntry.schedulerLock = true
        target.originalEntry.lockPlanId = target.originalEntry.lockPlanId ?? target.originalPlanId
        planEvents.append({ type: 'lock.acquired', planId: target.originalEntry.lockPlanId })
      } catch (err) {
        if (err instanceof SchedulerLockError) {
          return {
            action: 'resume_downstream',
            decision: { ...decision, targetPlanId: target.originalPlanId },
            status: 'blocked',
            error: 'scheduler_locked',
            errors: [`Another plan is already executing for this repo: ${err.conflict.record?.planId ?? 'unknown plan'}`],
          }
        }
        throw err
      }
    } else if (!target.originalEntry.lockHandle && repairEntry.lockHandle) {
      target.originalEntry.lockHandle = repairEntry.lockHandle
      target.originalEntry.schedulerLock = repairEntry.schedulerLock
      target.originalEntry.lockPlanId = repairEntry.lockPlanId ?? target.originalPlanId
    }

    const repairedStepIds: string[] = []
    const retriedStepIds: string[] = []
    const originalStepsById = new Map(target.originalEntry.plan.steps.map(step => [step.id, step]))
    for (const step of target.failedSteps) {
      const originalStep = originalStepsById.get(step.id)
      if (originalStep?.gate || originalStep?.mode === 'verify' || originalStep?.mode === 'read') {
        buffer.submit({
          id: originalStep.id,
          planId: target.originalPlanId,
          worker: originalStep.worker,
          task: originalStep.task,
          label: originalStep.label,
          caller: 'repair-resume',
        })
        retriedStepIds.push(step.id)
      } else {
        buffer.complete(step.id, [
          `REPAIRED by ${repairPlanId}.`,
          'The focused repair plan completed successfully; resuming downstream product gates.',
          `Original failure was: ${String(step.error ?? step.result ?? '').slice(0, 500)}`,
        ].join('\n'), target.originalPlanId)
        repairedStepIds.push(step.id)
      }
    }

    target.originalEntry.completedAt = undefined
    target.originalEntry.status = 'executing'
    planEvents.append({
      type: 'repair.resumed_downstream',
      planId: target.originalPlanId,
      repairPlanId,
      repairedStepIds,
      retriedStepIds,
    })
    runtimeTrace.unshift({
      type: 'repair.resumed_downstream',
      timestamp: new Date().toISOString(),
      data: {
        planId: target.originalPlanId,
        repairPlanId,
        repairedStepIds,
        retriedStepIds,
        nextGate: target.gates.nextGate ?? null,
      },
    })
    runtimeTrace.splice(200)

    const planCwd = target.originalEntry.worktree?.worktreePath ?? cwd
    const runtimeCwd = target.originalEntry.worktree?.cwd ?? cwd
    const planRuntime = target.originalEntry.worktree
      ? createWorkerRuntime({ cwd: runtimeCwd, workers: Object.fromEntries(customWorkers), acpGateway })
      : runtime
    startPlanExecution(target.originalPlanId, target.originalEntry, planRuntime, planCwd, 'repair-resume')
    return {
      action: 'resume_downstream',
      decision: { ...decision, targetPlanId: target.originalPlanId },
      submittedPlanId: target.originalPlanId,
      status: 'executing',
    }
  }

  const objectiveStatus = () => {
    const active = activePlans()[0]
    const latest = active ?? latestPlan()
    if (!latest) {
      return {
        currentObjective: null,
        activeWorktree: null,
        blockedReason: null,
        lifecyclePhase: 'idle',
        productReady: false,
        merged: false,
        repairAttempt: 0,
        nextMergeGate: null,
        mergeReady: false,
        gateStatus: { gates: [], nextGate: undefined, mergeReady: false },
        activePlans: [],
      }
    }

    const [planId, entry] = latest
    const steps = buffer.list({ planId })
    const resumeTarget = completedRepairResumeTarget(planId, entry)
    const statusEntry = resumeTarget?.originalEntry ?? entry
    const statusPlanId = resumeTarget?.originalPlanId ?? planId
    const statusSteps = resumeTarget ? buffer.list({ planId: resumeTarget.originalPlanId }) : steps
    const gates = gateSummary(statusEntry, statusSteps)
    const merged = planMerged(statusPlanId)
    const failed = blockingFailedSteps(planId, entry)
    const blockedGate = gates.gates.find(gate =>
      gate.status === 'completed' && (gate.verdict === 'fail' || gate.verdict === 'blocked' || gate.verdict === 'unknown'),
    )
    const repairPlans = [...plans.values()].filter(candidate => candidate.repairOf === statusPlanId)
    const activeRepair = repairPlans.find(candidate => candidate.status === 'executing')
    const blockedReason =
      resumeTarget ? `repair ${planId} completed; original plan ${resumeTarget.originalPlanId} needs downstream resume`
        : activeRepair ? `repair running: attempt ${activeRepair.repairAttempt ?? 1}`
          : failed[0] ? `blocking step ${failed[0].id} ${failed[0].status}`
            : blockedGate ? `${blockedGate.gate} gate ${blockedGate.verdict}`
              : entry.status === 'failed' ? 'plan failed'
                : null

    return {
      currentObjective: {
        planId,
        goal: entry.plan.goal,
        status: entry.status,
        createdAt: entry.createdAt,
        completedAt: entry.completedAt,
        repairOf: entry.repairOf,
      },
      activeWorktree: worktreeJson(entry.worktree) ?? null,
      blockedReason,
      lifecyclePhase: merged ? 'product_ready'
        : gates.mergeReady && statusEntry.status === 'completed' ? 'merge_ready'
          : activeRepair ? 'repair'
            : entry.status === 'executing' ? 'executing'
              : entry.status === 'failed' ? 'blocked'
                : entry.status,
      productReady: merged,
      merged,
      repairAttempt: Math.max(entry.repairAttempt ?? 0, ...repairPlans.map(candidate => candidate.repairAttempt ?? 0), 0),
      nextMergeGate: merged ? null : (gates.nextGate ?? null),
      mergeReady: !merged && gates.mergeReady,
      gateStatus: gates,
      activePlans: activePlans().map(([activePlanId, activeEntry]) => ({
        planId: activePlanId,
        goal: activeEntry.plan.goal,
        status: activeEntry.status,
        worktree: worktreeJson(activeEntry.worktree) ?? null,
      })),
    }
  }

  const supervisorDecision = () => evaluateSupervisor({
    objective: objectiveStatus(),
    maxInternalRepairAttempts: config.maxInternalRepairAttempts ?? 2,
    plans: [...plans.entries()].map(([planId, entry]) => ({
      planId,
      goal: entry.plan.goal,
      status: entry.status,
      repairOf: entry.repairOf,
      repairAttempt: entry.repairAttempt,
      steps: entry.plan.steps.map((step): SupervisorStepSnapshot => {
        const record = buffer.get(step.id, planId)
        return {
          id: step.id,
          worker: step.worker,
          label: step.label,
          status: record?.status ?? 'pending',
          mode: step.mode,
          gate: step.gate,
          output: String(record?.result ?? record?.error ?? ''),
        }
      }),
    } satisfies SupervisorPlanSnapshot)),
  })

  const autoMergeReadyPlan = (planId?: string, opts?: MergeRequest): { ok: true; planId: string; targetBranch: string; method: 'ff' | 'squash' } | { ok: false; error: string; message?: string } => {
    if (!planId) return { ok: false, error: 'missing_plan_id' }
    const entry = plans.get(planId)
    if (!entry) return { ok: false, error: 'not_found' }
    if (!entry.worktree) return { ok: false, error: 'no_worktree', message: 'Plan has no isolated worktree to merge.' }

    const method = opts?.method ?? 'ff'
    const requiredGates = opts?.requiredGates ?? ['review', 'qa', 'release']
    const steps = buffer.list({ planId })
    const gates = gateSummary(entry, steps)
    const missingGates = requiredGates.filter(required =>
      !gates.gates.some(gate => gate.gate === required && gate.status === 'completed' && gate.verdict === 'pass'),
    )
    const failed = blockingFailedSteps(planId, entry)
    if (entry.status !== 'completed') return { ok: false, error: 'plan_not_completed', message: `status=${entry.status}` }
    if (failed.length > 0) return { ok: false, error: 'plan_has_failed_steps', message: failed.map(step => step.id).join(', ') }
    if (missingGates.length > 0) return { ok: false, error: 'merge_gate_blocked', message: missingGates.join(', ') }

    const dirty = gitStatus(entry.worktree.worktreePath)
    if (dirty.length > 0) return { ok: false, error: 'worktree_has_uncommitted_changes', message: dirty.join(', ') }

    const targetBranch = opts?.targetBranch ?? git(entry.worktree.repoRoot, ['branch', '--show-current'])
    try {
      git(entry.worktree.repoRoot, ['switch', targetBranch])
      if (method === 'squash') {
        git(entry.worktree.repoRoot, ['merge', '--squash', entry.worktree.branchName])
        git(entry.worktree.repoRoot, ['commit', '-m', opts?.commitMessage ?? `Merge ${planId}`])
      } else {
        git(entry.worktree.repoRoot, ['merge', '--ff-only', entry.worktree.branchName])
      }
      if (opts?.cleanupWorktree) cleanupCycleWorktree(entry.worktree)
      planEvents.append({ type: 'merge.completed', planId, targetBranch, method })
      runtimeTrace.unshift({ type: 'merge.completed', timestamp: new Date().toISOString(), data: { planId, targetBranch, method } })
      runtimeTrace.splice(200)
      releaseSchedulerLock(entry)
      persistPlans()
      return { ok: true, planId, targetBranch, method }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      planEvents.append({ type: 'merge.failed', planId, error: message })
      runtimeTrace.unshift({ type: 'merge.failed', timestamp: new Date().toISOString(), data: { planId, targetBranch, method, message } })
      runtimeTrace.splice(200)
      return { ok: false, error: 'merge_failed', message }
    }
  }

  const supervisorTick = async (input: SupervisorTickInput = {}): Promise<SupervisorTickResult> => {
    const closedRepairs = closeIneffectiveActiveRepairPlans()
    const reaped = await reapStaleRunningTasks()
    if (reaped.length > 0) {
      return {
        action: 'repair_workspace',
        decision: {
          action: 'repair_workspace',
          failureType: 'unknown',
          reason: 'stale running task watchdog reaped timed-out work; repair was started when possible',
          targetPlanId: reaped[0]?.planId,
          targetStepId: reaped[0]?.stepId,
          requiresBoss: false,
        },
        status: 'executing',
      }
    }
    const decision = supervisorDecision()
    if (decision.action === 'run_merge_gate') {
      if (input.dryRun) return { action: decision.action, decision, status: 'dry_run', submittedPlanId: decision.targetPlanId }
      const merge = autoMergeReadyPlan(decision.targetPlanId)
      return {
        action: decision.action,
        decision,
        submittedPlanId: decision.targetPlanId,
        status: merge.ok ? 'completed' : 'blocked',
        error: merge.ok ? undefined : merge.error,
        errors: merge.ok ? undefined : [merge.message ?? merge.error ?? 'merge failed'],
      }
    }
    if (decision.action === 'resume_downstream') {
      const repairPlanId = decision.targetStepId
      const repairEntry = repairPlanId ? plans.get(repairPlanId) : undefined
      if (!repairPlanId || !repairEntry) {
        return { action: decision.action, decision, status: 'blocked', error: 'missing_repair_plan' }
      }
      return resumeDownstreamAfterRepair(repairPlanId, repairEntry, { dryRun: input.dryRun })
    }
    const fallbackProductSliceActions = new Set<SupervisorTickResult['action']>([
      'decompose_failed_step',
      'repair_workspace',
      'retry_same_step',
    ])
    const shouldDispatchSmallestSlice = decision.action === 'start_smallest_product_slice'
      || (
        fallbackProductSliceActions.has(decision.action)
        && activePlans().length === 0
        && Boolean(input.smallestProductSlice)
      )
    if (!shouldDispatchSmallestSlice) {
      return { action: decision.action, decision, status: 'no_action' }
    }
    if (closedRepairs.length > 0) {
      runtimeTrace.unshift({ type: 'supervisor.repair_circuit_breaker_fallback', timestamp: new Date().toISOString(), data: { closedRepairs, decision } })
      runtimeTrace.splice(200)
    }
    const hygiene = branchHygieneStatus()
    if (
      hygiene.consolidation.required
      && hygiene.consolidation.mode === 'block-new-cycles'
      && activePlans().length === 0
    ) {
      const consolidationDecision = {
        action: 'consolidate_unmerged_work' as const,
        failureType: 'none' as const,
        reason: hygiene.consolidation.reason ?? 'unmerged work must be consolidated before starting new product cycles',
        requiresBoss: false,
      }
      runtimeTrace.unshift({
        type: 'supervisor.consolidation_required',
        timestamp: new Date().toISOString(),
        data: {
          reason: consolidationDecision.reason,
          candidates: hygiene.consolidation.candidates.map(branch => ({
            name: branch.name,
            aheadCanonical: branch.aheadCanonical,
            latestSubject: branch.latestSubject,
          })),
        },
      })
      runtimeTrace.splice(200)
      writeProductionSnapshot({ type: 'consolidation-required' })
      if (input.consolidationPlan) {
        const plan = input.consolidationPlan
        const errors = [
          ...planEngine.validate(plan, new Set(Object.keys(allWorkers()))),
          ...validateExecutionPolicy(plan),
        ]
        if (errors.length > 0) {
          return { action: 'consolidate_unmerged_work', decision: consolidationDecision, plan, status: 'blocked', error: 'validation_failed', errors, branchHygiene: hygiene }
        }
        const approvalPolicy = input.approval?.policy ?? {
          repoRoot: cwd,
          trustedPaths: ['docs'],
        }
        const approvals = plan.steps
          .filter(step => step.mode === 'write' || step.mode === 'report')
          .map(step => evaluatePlanStepApproval({
            userObjective: plan.goal,
            step,
            policy: approvalPolicy,
            explicitAuthorization: input.approval?.explicitAuthorization,
          }))
        approvalDecisions.unshift(...approvals)
        approvalDecisions.splice(100)
        runtimeTrace.unshift({ type: 'approval.preflight', timestamp: new Date().toISOString(), data: { goal: plan.goal, approvals } })
        runtimeTrace.splice(200)
        const blockedApprovals = approvals.filter(item => item.status !== 'approved')
        if ((input.approval?.enforce ?? true) && blockedApprovals.length > 0) {
          return {
            action: 'consolidate_unmerged_work',
            decision: consolidationDecision,
            plan,
            approvals,
            status: blockedApprovals.some(item => item.status === 'needs_boss') ? 'needs_boss' : 'blocked',
            error: 'approval_blocked',
            errors: blockedApprovals.map(item => `${item.stepId ?? 'unknown'}: ${item.reason}`),
            branchHygiene: hygiene,
          }
        }
        if (input.dryRun) return { action: 'consolidate_unmerged_work', decision: consolidationDecision, plan, approvals, status: 'dry_run', branchHygiene: hygiene }

        const planId = nextPlanId()
        let lockHandle: SchedulerLockHandle | undefined
        try {
          lockHandle = schedulerLock.acquire({ planId, goal: plan.goal })
          planEvents.append({ type: 'lock.acquired', planId })
        } catch (err) {
          if (err instanceof SchedulerLockError) {
            return {
              action: 'consolidate_unmerged_work',
              decision: consolidationDecision,
              plan,
              status: 'blocked',
              error: 'scheduler_locked',
              errors: [`Another plan is already executing for this repo: ${err.conflict.record?.planId ?? 'unknown plan'}`],
              branchHygiene: hygiene,
            }
          }
          throw err
        }

        let worktree: WorktreeContext | undefined
        let planRuntime = runtime
        let planCwd = cwd
        let boundaryStatus: string[] | undefined
        try {
          worktree = createCycleWorktree(cwd, planId, { mode: 'cycle-worktree', branchPrefix: 'tanren/consolidation', cleanup: 'never' })
          boundaryStatus = gitStatus(worktree.repoRoot)
          planRuntime = createWorkerRuntime({
            cwd: worktree.cwd,
            workers: Object.fromEntries(customWorkers),
            acpGateway,
          })
          planCwd = worktree.worktreePath
        } catch (err) {
          lockHandle.release()
          if (worktree) cleanupCycleWorktree(worktree)
          return {
            action: 'consolidate_unmerged_work',
            decision: consolidationDecision,
            plan,
            status: 'blocked',
            error: 'worktree_creation_failed',
            errors: [err instanceof Error ? err.message : String(err)],
            branchHygiene: hygiene,
          }
        }

        const entry = {
          plan,
          worktree,
          boundaryStatus,
          status: 'executing' as const,
          createdAt: new Date().toISOString(),
          schedulerLock: true,
          lockPlanId: planId,
          lockHandle,
        }
        plans.set(planId, entry)
        planEvents.append({ type: 'plan.created', planId, plan, worktree, boundaryStatus, schedulerLock: true, lockPlanId: planId })
        startPlanExecution(planId, entry, planRuntime, planCwd, 'supervisor-consolidation')
        runtimeTrace.unshift({ type: 'supervisor.consolidation_submitted', timestamp: new Date().toISOString(), data: { planId } })
        runtimeTrace.splice(200)
        return { action: 'consolidate_unmerged_work', decision: consolidationDecision, plan, approvals, submittedPlanId: planId, status: 'executing', branchHygiene: hygiene }
      }
      return {
        action: 'consolidate_unmerged_work',
        decision: consolidationDecision,
        status: 'blocked',
        error: 'consolidation_required',
        errors: [
          consolidationDecision.reason,
          ...hygiene.consolidation.candidates.map(branch => `${branch.name}: ${branch.aheadCanonical} commits ahead; ${branch.latestSubject ?? 'no subject'}`),
        ],
        branchHygiene: hygiene,
      }
    }
    if (!input.smallestProductSlice) {
      return {
        action: decision.action,
        decision,
        status: 'blocked',
        error: 'missing_smallest_product_slice_contract',
        errors: [
          'smallestProductSlice.goal is required',
          'smallestProductSlice.implementationTask is required',
          'smallestProductSlice.allowedPaths is required',
          'smallestProductSlice.expectedPaths is required',
          'smallestProductSlice.verifyCommand is required',
        ],
      }
    }
    if (decision.action !== 'start_smallest_product_slice') {
      runtimeTrace.unshift({
        type: 'supervisor.fallback_smallest_slice',
        timestamp: new Date().toISOString(),
        data: {
          action: decision.action,
          failureType: decision.failureType,
          reason: decision.reason,
          targetPlanId: decision.targetPlanId,
          targetStepId: decision.targetStepId,
        },
      })
      runtimeTrace.splice(200)
    }

    let plan: ActionPlan
    const selectedWorkers = selectSmallestProductSliceWorkers(input.smallestProductSlice, new Set(Object.keys(allWorkers())))
    try {
      plan = buildSmallestProductSlicePlan(input.smallestProductSlice, new Set(Object.keys(allWorkers())))
    } catch (err) {
      return {
        action: decision.action,
        decision,
        status: 'blocked',
        error: 'invalid_smallest_product_slice_contract',
        errors: [err instanceof Error ? err.message : String(err)],
      }
    }

    const errors = [
      ...planEngine.validate(plan, new Set(Object.keys(allWorkers()))),
      ...validateExecutionPolicy(plan),
    ]
    if (errors.length > 0) {
      return { action: decision.action, decision, plan, status: 'blocked', error: 'validation_failed', errors }
    }

    const approvalPolicy = input.approval?.policy ?? {
      repoRoot: cwd,
      trustedPaths: [...new Set([...input.smallestProductSlice.allowedPaths, 'docs'])],
    }
    const approvals = plan.steps
      .filter(step => step.mode === 'write' || step.mode === 'report')
      .map(step => evaluatePlanStepApproval({
        userObjective: plan.goal,
        step,
        policy: approvalPolicy,
        explicitAuthorization: input.approval?.explicitAuthorization,
      }))
    approvalDecisions.unshift(...approvals)
    approvalDecisions.splice(100)
    runtimeTrace.unshift({ type: 'approval.preflight', timestamp: new Date().toISOString(), data: { goal: plan.goal, approvals, selectedWorkers } })
    runtimeTrace.splice(200)
    const blockedApprovals = approvals.filter(item => item.status !== 'approved')
    if ((input.approval?.enforce ?? true) && blockedApprovals.length > 0) {
      return {
        action: decision.action,
        decision,
        plan,
        approvals,
        selectedWorkers,
        status: blockedApprovals.some(item => item.status === 'needs_boss') ? 'needs_boss' : 'blocked',
        error: 'approval_blocked',
        errors: blockedApprovals.map(item => `${item.stepId ?? 'unknown'}: ${item.reason}`),
      }
    }

    if (input.dryRun) return { action: decision.action, decision, plan, approvals, selectedWorkers, status: 'dry_run' }

    const planId = nextPlanId()
    let lockHandle: SchedulerLockHandle | undefined
    try {
      lockHandle = schedulerLock.acquire({ planId, goal: plan.goal })
      planEvents.append({ type: 'lock.acquired', planId })
    } catch (err) {
      if (err instanceof SchedulerLockError) {
        return {
          action: decision.action,
          decision,
          plan,
          status: 'blocked',
          error: 'scheduler_locked',
          errors: [`Another plan is already executing for this repo: ${err.conflict.record?.planId ?? 'unknown plan'}`],
        }
      }
      throw err
    }

    let worktree: WorktreeContext | undefined
    let planRuntime = runtime
    let planCwd = cwd
    let boundaryStatus: string[] | undefined
    try {
      worktree = createCycleWorktree(cwd, planId, { mode: 'cycle-worktree', cleanup: 'never' })
      boundaryStatus = gitStatus(worktree.repoRoot)
      planRuntime = createWorkerRuntime({
        cwd: worktree.cwd,
        workers: Object.fromEntries(customWorkers),
        acpGateway,
      })
      planCwd = worktree.worktreePath
    } catch (err) {
      lockHandle.release()
      if (worktree) cleanupCycleWorktree(worktree)
      return {
        action: decision.action,
        decision,
        plan,
        status: 'blocked',
        error: 'worktree_creation_failed',
        errors: [err instanceof Error ? err.message : String(err)],
      }
    }

    const entry = {
      plan,
      worktree,
      boundaryStatus,
      status: 'executing' as const,
      createdAt: new Date().toISOString(),
      schedulerLock: true,
      lockPlanId: planId,
      lockHandle,
    }
    plans.set(planId, entry)
    planEvents.append({ type: 'plan.created', planId, plan, worktree, boundaryStatus, schedulerLock: true, lockPlanId: planId })
    startPlanExecution(planId, entry, planRuntime, planCwd, 'supervisor-tick')

    runtimeTrace.unshift({ type: 'supervisor.submitted', timestamp: new Date().toISOString(), data: { planId, selectedWorkers } })
    runtimeTrace.splice(200)
    return { action: decision.action, decision, plan, approvals, selectedWorkers, submittedPlanId: planId, status: 'executing' }
  }

  const classifyFailure = (step: StepResult): 'timeout' | 'artifact_contract' | 'verification' | 'worktree_boundary' | 'worker_error' => {
    if (step.id === 'worktree-boundary') return 'worktree_boundary'
    if (step.status === 'timeout' || /timeout/i.test(step.output)) return 'timeout'
    if (step.output.includes('[ARTIFACT CONTRACT FAILED]')) return 'artifact_contract'
    if (step.output.includes('[VERIFY FAILED]')) return 'verification'
    return 'worker_error'
  }

  const maybeStartRepair = async (failedPlanId: string, entry: PlanEntry, result: PlanResult, repair?: PlanRequest['repair'], boundaryError?: string): Promise<boolean> => {
    if (repair?.enabled === false || (result.summary.failed === 0 && !boundaryError)) return false
    if (entry.repairOf) {
      runtimeTrace.unshift({
        type: 'repair.circuit_breaker.prevented_nested_repair',
        timestamp: new Date().toISOString(),
        data: { failedPlanId, repairOf: entry.repairOf },
      })
      runtimeTrace.splice(200)
      return false
    }
    const attempt = (entry.repairAttempt ?? 0) + 1
    const maxAttempts = repair?.maxAttempts ?? config.maxInternalRepairAttempts ?? 2
    if (attempt > maxAttempts) return false
    entry.repairAttempt = attempt
    const stepById = new Map(entry.plan.steps.map(step => [step.id, step]))
    const failedSteps = result.steps.filter(step =>
      (step.status === 'failed' || step.status === 'timeout')
      && stepById.get(step.id)?.blocking !== false,
    )
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
    if (failedSteps.length === 0) return false
    const repairWorker = repair?.worker ?? 'autopilot-producer'
    if (!allWorkers()[repairWorker]) return false
    const verifyWorker = allWorkers()['qa-reality-checker'] ? 'qa-reality-checker' : repairWorker
    const repairReportPath = `docs/tanren-repair-${failedPlanId}.md`
    const runtimeEvaluations = new Map<string, ReturnType<typeof evaluateExecutionHarnessFailure> | undefined>()
    const runtimeEvaluation = (step: StepResult) => {
      if (runtimeEvaluations.has(step.id)) return runtimeEvaluations.get(step.id)
      const original = stepById.get(step.id)
      if (!original) return undefined
      try {
        const evaluation = evaluateExecutionHarnessFailure({
          objectiveId: entry.lockPlanId ?? failedPlanId,
          planId: failedPlanId,
          step: original,
          result: step,
          attempt,
          repoRoot: entry.worktree?.repoRoot ?? cwd,
          worktreePath: entry.worktree?.worktreePath,
        })
        runtimeEvaluations.set(step.id, evaluation)
        return evaluation
      } catch {
        runtimeEvaluations.set(step.id, undefined)
        return undefined
      }
    }
    const repairPlan: ActionPlan = {
      goal: `Repair failed plan ${failedPlanId}: ${entry.plan.goal}`,
      acceptance: 'Classify the failure, apply a focused repair, verify the result, and report a concise handoff.',
      steps: [
        ...failedSteps.map(step => ({
          id: `classify-${step.id}`,
          worker: repairWorker,
          mode: 'read' as const,
          label: `Classify ${step.id}`,
          dependsOn: [],
          timeoutSeconds: 180,
          task: [
            `Classify failed step ${step.id} from plan ${failedPlanId}.`,
            `Failure type hint: ${runtimeEvaluation(step)?.failureType ?? classifyFailure(step)}`,
            `Execution harness next action: ${runtimeEvaluation(step)?.nextAction ?? 'unavailable'}`,
            `Original worker: ${step.worker}`,
            `Failure: ${step.output}`,
            'Return the smallest repair strategy. Do not edit files in this classify step.',
          ].join('\n\n'),
        })),
        ...failedSteps.map(step => {
          const original = entry.plan.steps.find(candidate => candidate.id === step.id)
          return {
            id: `fix-${step.id}`,
            worker: repairWorker,
            label: `Fix ${step.id}`,
            dependsOn: [`classify-${step.id}`],
            timeoutSeconds: 300,
            task: [
              `Apply a focused repair for failed step ${step.id} from plan ${failedPlanId}.`,
              `Failure type: ${runtimeEvaluation(step)?.failureType ?? classifyFailure(step)}`,
              `Execution harness next action: ${runtimeEvaluation(step)?.nextAction ?? 'unavailable'}`,
              `Classifier output: {{classify-${step.id}.output}}`,
              'Keep scope minimal and do not expand product scope.',
            ].join('\n\n'),
            mode: 'write' as const,
            verifyCommand: original?.verifyCommand ?? 'test -d docs',
            artifactContract: original?.artifactContract ?? { allowedPaths: ['docs'], expectedPaths: ['docs'] },
          }
        }),
        {
          id: 'repair-verify',
          worker: verifyWorker,
          mode: 'verify',
          label: 'Verify repair',
          dependsOn: failedSteps.map(step => `fix-${step.id}`),
          timeoutSeconds: 180,
          task: [
            `Verify repair for failed plan ${failedPlanId}.`,
            'Check the repaired files, run available verification commands, and report remaining blockers first.',
          ].join('\n\n'),
        },
        {
          id: 'repair-report',
          worker: repairWorker,
          mode: 'report',
          label: 'Repair report',
          dependsOn: ['repair-verify'],
          timeoutSeconds: 180,
          verifyCommand: `test -e ${repairReportPath}`,
          artifactContract: { allowedPaths: ['docs'], expectedPaths: [repairReportPath] },
          task: [
            `Create ${repairReportPath} as a concise repair handoff for failed plan ${failedPlanId}.`,
            'Include failure classification, files changed, verification evidence, and whether boss escalation is required.',
            'Boss-facing language should be Traditional Chinese except proper nouns.',
          ].join('\n\n'),
        },
      ],
    }
    const repairPolicyErrors = validateExecutionPolicy(repairPlan)
    if (repairPolicyErrors.length > 0) {
      planEvents.append({ type: 'plan.failed', planId: failedPlanId, error: `Repair policy validation failed: ${repairPolicyErrors.join('; ')}` })
      return false
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
      schedulerLock: entry.schedulerLock,
      lockPlanId: entry.lockPlanId ?? failedPlanId,
      lockHandle: entry.lockHandle,
    }
    plans.set(repairPlanId, repairEntry)
    planEvents.append({ type: 'repair.created', planId: failedPlanId, repairPlanId, repairAttempt: attempt, failedStepIds: failedSteps.map(step => step.id) })
    planEvents.append({ type: 'plan.created', planId: repairPlanId, plan: repairPlan, worktree: entry.worktree, boundaryStatus: entry.boundaryStatus, schedulerLock: repairEntry.schedulerLock, lockPlanId: repairEntry.lockPlanId })
    const repairRuntimeCwd = entry.worktree?.cwd ?? cwd
    const repairPlanCwd = entry.worktree?.worktreePath ?? cwd
    const repairRuntime = entry.worktree
      ? createWorkerRuntime({ cwd: repairRuntimeCwd, workers: Object.fromEntries(customWorkers), acpGateway })
      : runtime
    startPlanExecution(repairPlanId, repairEntry, repairRuntime, repairPlanCwd, 'repair-cycle', { enabled: false })
    return true
  }

  function loadPersistedPlans() {
    const replayed = planEvents.replay()
    if (replayed.size > 0) {
      for (const [planId, entry] of replayed) {
        plans.set(planId, entry)
      }
      return
    }

    try {
      const saved = JSON.parse(readFileSync(plansPath, 'utf-8')) as Array<Omit<PlanEntry, 'resultPromise'> & { planId: string }>
      for (const savedEntry of saved) {
        const { planId, ...entry } = savedEntry
        if (entry.status === 'executing' && entry.schedulerLock === undefined) {
          entry.schedulerLock = true
          entry.lockPlanId = planId
        }
        plans.set(planId, entry)
      }
    } catch { /* no persisted plans */ }
  }

  function resumePersistedPlans() {
    for (const [planId, entry] of plans) {
      if (entry.status !== 'executing') continue
      const planCwd = entry.worktree?.worktreePath ?? cwd
      const runtimeCwd = entry.worktree?.cwd ?? cwd
      const planRuntime = entry.worktree
        ? createWorkerRuntime({ cwd: runtimeCwd, workers: Object.fromEntries(customWorkers), acpGateway })
        : runtime
      startPlanExecution(planId, entry, planRuntime, planCwd)
    }
  }

  const refreshProvider = (name: string, def: WorkerDefinition) => {
    runtime.workerProviders.delete(name)
    const providerKey = def.backend === 'agent-sdk'
      ? 'agent-sdk'
      : def.backend === 'claude-code'
        ? 'claude-cli'
        : def.backend === 'codex'
          ? 'codex'
          : (def.vendor ?? 'agent-sdk')
    if (!['sdk', 'agent-sdk', 'claude-code', 'codex', 'acp'].includes(def.backend)) return
    if (providerKey === 'agent-sdk') {
      const next = createWorkerRuntime({ cwd, workers: { [name]: def }, acpGateway })
      const provider = next.workerProviders.get(name)
      if (provider) runtime.workerProviders.set(name, provider)
    } else {
      runtime.workerProviders.set(name, createProvider({ provider: providerKey, model: def.agent.model, options: def.providerOptions, cwd }))
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
    workerQualificationSpecs,
    qualificationStatusFor,
    readQualificationResults,
    writeQualificationResults,
    refreshProvider,
    activePlans,
    hasActivePlan,
    activeCycleBranches,
    branchHygieneStatus,
    cleanupBranchHygiene,
    writeProductionSnapshot,
    validateExecutionPolicy,
    classifyTaskError,
    blockingFailedSteps,
    objectiveStatus,
    supervisorDecision,
    supervisorTick,
    approvalDecisions,
    runtimeTrace,
    learningTrace,
    reapStaleRunningTasks,
    closeIneffectiveActiveRepairPlans,
    autoMergeReadyPlan,
    startPlanExecution,
    gitStatus,
    schedulerLock,
    planEvents,
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

type MergeRequest = {
  method?: 'ff' | 'squash'
  targetBranch?: string
  commitMessage?: string
  cleanupWorktree?: boolean
  requiredGates?: WorkerGate[]
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gateVerdict(output: unknown): 'pass' | 'fail' | 'blocked' | 'unknown' {
  const text = String(output ?? '')
  const lineVerdict = text.match(/^\s*(?:verdict|recommendation|result|結論|建議)?\s*:?\s*(PASS|FAIL|FAILED|BLOCKED)\b/im)
  if (lineVerdict) {
    const value = lineVerdict[1].toUpperCase()
    if (value === 'PASS') return 'pass'
    if (value === 'BLOCKED') return 'blocked'
    return 'fail'
  }
  if (/\bBLOCKED\b|需要人工|NEED HUMAN/i.test(text)) return 'blocked'
  if (/\bFAIL(?:ED)?\b|不通過/i.test(text.replace(/PASS\/FAIL/gi, ''))) return 'fail'
  if (/\bPASS(?:ED)?\b|通過/i.test(text)) return 'pass'
  return 'unknown'
}

function gateSummary(entry: { plan: ActionPlan }, steps: ReturnType<ResultBuffer['list']>) {
  const gates = entry.plan.steps
    .filter(step => step.gate)
    .map(step => {
      const task = steps.find(candidate => candidate.id === step.id)
      const status = task?.status ?? 'pending'
      return { gate: step.gate!, stepId: step.id, worker: step.worker, status, verdict: gateVerdict(task?.result ?? task?.error) }
    })
  const nextGate = gates.find(gate => gate.status !== 'completed' || gate.verdict !== 'pass')
  return {
    gates,
    nextGate,
    mergeReady: ['review', 'qa', 'release'].every(required =>
      gates.some(gate => gate.gate === required && gate.status === 'completed' && gate.verdict === 'pass'),
    ),
  }
}

export function createOrchestrationRouter(config: OrchestrationMiddlewareConfig = {}): Hono {
  const routerCwd = config.cwd ?? process.cwd()
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
    const plan: ActionPlan = { goal: body.goal, acceptance: body.acceptance, steps: body.steps, convergence: body.convergence }
    const errors = [
      ...mw.planEngine.validate(plan, new Set(Object.keys(mw.allWorkers()))),
      ...mw.validateExecutionPolicy(plan),
    ]
    if (errors.length > 0) return c.json({ error: 'validation_failed', errors }, 400)

    const planId = mw.nextPlanId()
    let lockHandle: SchedulerLockHandle | undefined
    if (body.schedulerLock !== false) {
      try {
        lockHandle = mw.schedulerLock.acquire({ planId, goal: plan.goal })
        mw.planEvents.append({ type: 'lock.acquired', planId })
      } catch (err) {
        if (err instanceof SchedulerLockError) {
          return c.json({
            error: 'scheduler_locked',
            message: 'Another plan is already executing for this repo.',
            lock: err.conflict.record,
            lockPath: err.conflict.path,
            activePlans: mw.activePlans().map(([activePlanId, entry]) => ({ planId: activePlanId, goal: entry.plan.goal, status: entry.status })),
          }, 409)
        }
        throw err
      }
    }
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
        planCwd = worktree.worktreePath
      }
    } catch (err) {
      lockHandle?.release()
      if (worktree) cleanupCycleWorktree(worktree)
      return c.json({ error: 'worktree_creation_failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }

    const entry = { plan, worktree, boundaryStatus, status: 'executing' as const, createdAt: new Date().toISOString(), schedulerLock: body.schedulerLock !== false, lockPlanId: planId, lockHandle }
    mw.plans.set(planId, entry)
    mw.planEvents.append({ type: 'plan.created', planId, plan, worktree, boundaryStatus, schedulerLock: entry.schedulerLock, lockPlanId: entry.lockPlanId })
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
    const failed = mw.blockingFailedSteps(planId, entry).length
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
      gateStatus: gateSummary(entry, steps),
      worktree: worktreeJson(entry.worktree),
    })
  })

  app.delete('/task/:id', c => mw.buffer.cancel(c.req.param('id'), c.req.query('planId')) ? c.json({ ok: true }) : c.json({ error: 'cannot cancel' }, 400))

  app.get('/pool', c => c.json({
    workers: Object.entries(mw.allWorkers()).map(([name, def]) => ({
      name, backend: def.backend, model: def.agent.model, timeout: def.defaultTimeoutSeconds,
      providerOptions: def.providerOptions,
      policy: def.policy,
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

  app.get('/objective/status', c => c.json(mw.objectiveStatus()))
  app.get('/product/status', c => {
    const status = mw.objectiveStatus()
    return c.json({
      productReady: status.productReady ?? false,
      lifecyclePhase: status.lifecyclePhase ?? 'idle',
      currentObjective: status.currentObjective,
      activeWorktree: status.activeWorktree,
      blockedReason: status.blockedReason,
      mergeReady: status.mergeReady,
      nextMergeGate: status.nextMergeGate,
      gateStatus: status.gateStatus,
      repairAttempt: status.repairAttempt,
    })
  })
  app.get('/branch-hygiene', c => c.json(mw.branchHygieneStatus()))
  app.get('/productization/status', c => c.json({
    objective: mw.objectiveStatus(),
    branchHygiene: mw.branchHygieneStatus(),
    staleReports: false,
  }))
  app.post('/productization/reports/refresh', c => {
    mw.writeProductionSnapshot({ type: 'manual-refresh' })
    return c.json({ ok: true })
  })
  app.post('/branch-hygiene/cleanup', async c => {
    const body: { dryRun?: boolean } = await c.req.json<{ dryRun?: boolean }>().catch(() => ({}))
    return c.json(mw.cleanupBranchHygiene({ dryRun: body.dryRun !== false }))
  })
  app.get('/supervisor/decision', c => c.json(mw.supervisorDecision()))
  app.get('/approvals', c => c.json({ approvals: mw.approvalDecisions.slice(0, 50) }))
  app.get('/runtime/trace', c => c.json({ events: mw.runtimeTrace.slice(0, 100) }))
  app.get('/learning/events', c => c.json({ events: [...mw.learningTrace, ...readStepLearningEvents(routerCwd, 50)].slice(0, 50) }))
  app.post('/approval/evaluate', async c => {
    const body = await c.req.json<{
      userObjective: string
      step: PlanStep
      policy: Parameters<typeof evaluatePlanStepApproval>[0]['policy']
      explicitAuthorization?: string[]
    }>()
    if (!body.userObjective || !body.step || !body.policy) return c.json({ error: 'userObjective, step, and policy required' }, 400)
    const decision = evaluatePlanStepApproval(body)
    mw.approvalDecisions.unshift(decision)
    mw.approvalDecisions.splice(100)
    return c.json(decision)
  })
  app.post('/supervisor/tick', async c => {
    const body = await c.req.json<SupervisorTickInput>().catch(() => ({}))
    const result = await mw.supervisorTick(body)
    const status = result.error === 'scheduler_locked' ? 409
      : result.error ? 400
        : 200
    return c.json(result, status)
  })

  app.get('/workers', c => c.json({
    workers: Object.entries(mw.allWorkers()).map(([name, def]) => ({
      name,
      backend: def.backend,
      vendor: def.vendor,
      providerOptions: def.providerOptions,
      docker: def.docker,
      swarm: def.swarm,
      model: def.agent.model,
      description: def.agent.description,
      prompt: def.agent.prompt,
      tools: def.agent.tools,
      maxTurns: def.agent.maxTurns,
      timeout: def.defaultTimeoutSeconds,
      policy: def.policy,
      qualification: mw.qualificationStatusFor(name),
      builtin: !!WORKERS[name],
    })),
  }))

  app.get('/workers/qualifications', c => {
    const specs = mw.workerQualificationSpecs()
    const specByWorker = new Map(specs.map(spec => [spec.worker, spec]))
    return c.json({
      workers: Object.keys(mw.allWorkers()).map(worker => ({
        worker,
        configured: specByWorker.has(worker),
        requiredForProduction: specByWorker.get(worker)?.requiredForProduction === true,
        title: specByWorker.get(worker)?.title,
        status: mw.qualificationStatusFor(worker),
      })),
      specs,
      results: mw.readQualificationResults(),
    })
  })

  app.post('/workers/qualifications/run', async c => {
    const body = await c.req.json<{ workers?: string[]; isolation?: WorktreeIsolationConfig; schedulerLock?: boolean }>().catch(() => ({} as { workers?: string[]; isolation?: WorktreeIsolationConfig; schedulerLock?: boolean }))
    const selected = new Set(body.workers ?? [])
    const specs = mw.workerQualificationSpecs().filter(spec => selected.size === 0 || selected.has(spec.worker))
    if (specs.length === 0) return c.json({ error: 'no_worker_qualification_specs' }, 400)
    const plan: ActionPlan = {
      goal: `${QUALIFICATION_GOAL_PREFIX}: ${specs.map(spec => spec.worker).join(', ')}`,
      acceptance: 'Each worker must prove it can produce its owned artifact, stay inside allowed paths, and return PASS/FAIL/BLOCKED with evidence.',
      steps: specs.map(spec => ({
        id: `qualify-${spec.worker.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
        worker: spec.worker,
        mode: spec.mode ?? 'report',
        label: spec.title ?? `Qualify ${spec.worker}`,
        dependsOn: [],
        timeoutSeconds: spec.timeoutSeconds,
        verifyCommand: spec.verifyCommand,
        artifactContract: spec.artifactContract,
        task: [
          `Worker qualification for ${spec.worker}.`,
          spec.acceptance ? `Acceptance:\n${spec.acceptance}` : '',
          'Return the first line as exactly PASS, FAIL, or BLOCKED.',
          'Then include files changed, verification evidence, gaps, and one skill improvement if you failed or were blocked.',
          spec.task,
        ].filter(Boolean).join('\n\n'),
      })),
    }
    const errors = [
      ...mw.planEngine.validate(plan, new Set(Object.keys(mw.allWorkers()))),
      ...mw.validateExecutionPolicy(plan),
    ]
    if (errors.length > 0) return c.json({ error: 'validation_failed', errors }, 400)
    const planId = mw.nextPlanId()
    let worktree: WorktreeContext | undefined
    let planRuntime = mw.runtime
    let planCwd = routerCwd
    let boundaryStatus: string[] | undefined
    try {
      const isolation = body.isolation ?? { mode: 'cycle-worktree', branchPrefix: 'tanren/qualification', cleanup: 'never' } as WorktreeIsolationConfig
      if (isolation.mode === 'cycle-worktree') {
        worktree = createCycleWorktree(routerCwd, planId, isolation)
        boundaryStatus = mw.gitStatus(worktree.repoRoot)
        planRuntime = createWorkerRuntime({ cwd: worktree.cwd, workers: Object.fromEntries(mw.customWorkers), acpGateway: mw.acpGateway })
        planCwd = worktree.worktreePath
      }
    } catch (err) {
      if (worktree) cleanupCycleWorktree(worktree)
      return c.json({ error: 'worktree_creation_failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
    const entry = { plan, worktree, boundaryStatus, status: 'executing' as const, createdAt: new Date().toISOString(), schedulerLock: false, lockPlanId: planId }
    mw.plans.set(planId, entry)
    const qualificationResults = mw.readQualificationResults()
    for (const spec of specs) {
      qualificationResults[spec.worker] = {
        worker: spec.worker,
        status: 'running',
        planId,
        stepId: `qualify-${spec.worker.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
        updatedAt: new Date().toISOString(),
        summary: 'Qualification running.',
      }
    }
    mw.writeQualificationResults(qualificationResults)
    mw.planEvents.append({ type: 'plan.created', planId, plan, worktree, boundaryStatus, schedulerLock: false, lockPlanId: planId })
    mw.startPlanExecution(planId, entry, planRuntime, planCwd, 'worker-qualification', { enabled: false })
    return c.json({ planId, status: 'executing', steps: plan.steps.length, worktree: worktreeJson(worktree) })
  })

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
      policy: body.policy,
      docker: body.docker,
      swarm: body.swarm,
      learning: body.learning,
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
      const gates = gateSummary(entry, steps)
      return {
        planId,
        goal: entry.plan.goal,
        status: entry.status,
        repairOf: entry.repairOf,
        repairAttempt: entry.repairAttempt,
        totalSteps: entry.plan.steps.length,
        completed: steps.filter(s => s.status === 'completed').length,
        failed: mw.blockingFailedSteps(planId, entry).length,
        running: steps.filter(s => s.status === 'running').length,
        gateStatus: gates,
        worktree: worktreeJson(entry.worktree),
        steps: entry.plan.steps.map(s => {
          const task = steps.find(t => t.id === s.id)
          const failedLike = task?.status === 'failed' || task?.status === 'timeout' || task?.status === 'cancelled'
          return {
            id: s.id,
            worker: s.worker,
            label: s.label,
            gate: s.gate,
            dependsOn: s.dependsOn,
            status: task?.status ?? 'pending',
            durationMs: task?.durationMs,
            errorKind: failedLike ? mw.classifyTaskError(task?.error ?? task?.result) : undefined,
            error: failedLike ? task?.error : undefined,
          }
        }),
      }
    }),
  }))

  app.get('/plan-events', c => c.json({ events: mw.planEvents.readAll() }))

  app.post('/plan/:id/merge', async c => {
    const planId = c.req.param('id')
    const body: MergeRequest = await c.req.json<MergeRequest>().catch(() => ({}))
    const result = mw.autoMergeReadyPlan(planId, body)
    if (result.ok) return c.json(result)
    const status = result.error === 'not_found' ? 404
      : result.error === 'no_worktree' ? 400
        : 409
    return c.json(result, status)
  })

  app.get('/plan/:id/merge-policy', c => {
    const planId = c.req.param('id')
    const entry = mw.plans.get(planId)
    if (!entry) return c.json({ error: 'not_found' }, 404)
    const requiredGates: WorkerGate[] = ['review', 'qa', 'release']
    const steps = mw.buffer.list({ planId })
    const gates = gateSummary(entry, steps)
    const missingGates = requiredGates.filter(required =>
      !gates.gates.some(gate => gate.gate === required && gate.status === 'completed' && gate.verdict === 'pass'),
    )
    const dirty = entry.worktree ? mw.gitStatus(entry.worktree.worktreePath) : []
    const failed = mw.blockingFailedSteps(planId, entry)
    const mergeReady = entry.status === 'completed'
      && !!entry.worktree
      && missingGates.length === 0
      && failed.length === 0
      && dirty.length === 0
    return c.json({
      planId,
      mergeReady,
      recommendedAction: mergeReady ? 'merge' : 'wait_or_repair',
      requiredGates,
      missingGates,
      failed: failed.map(step => ({ id: step.id, status: step.status, worker: step.worker })),
      dirty,
      worktree: worktreeJson(entry.worktree),
      gateStatus: gates,
    })
  })

  app.post('/plan/validate', async c => {
    const body = await c.req.json<PlanRequest>()
    const errors = [
      ...mw.planEngine.validate(body, new Set(Object.keys(mw.allWorkers()))),
      ...mw.validateExecutionPolicy(body),
    ]
    return c.json({ valid: errors.length === 0, errors })
  })

  app.get('/templates', c => c.json({ templates: PLAN_TEMPLATES }))
  app.post('/plan/from-template', async c => {
    const body = await c.req.json<TemplatePlanRequest>()
    const tpl = PLAN_TEMPLATES.find(t => t.name === body.template)
    if (!tpl) return c.json({ error: `Unknown template: ${body.template}` }, 400)
    const missing = tpl.params.filter(p => p.required && !body.params[p.name])
    if (missing.length > 0) return c.json({ error: 'missing_params', missing: missing.map(p => p.name) }, 400)
    let planJson = JSON.stringify(tpl.plan)
    for (const param of tpl.params) planJson = planJson.replaceAll(`{{${param.name}}}`, body.params[param.name] ?? '')
    const plan = JSON.parse(planJson) as ActionPlan
    const errors = [
      ...mw.planEngine.validate(plan, new Set(Object.keys(mw.allWorkers()))),
      ...mw.validateExecutionPolicy(plan),
    ]
    if (errors.length > 0) return c.json({ error: 'template_validation_failed', errors }, 400)
    const planId = mw.nextPlanId()
    let lockHandle: SchedulerLockHandle | undefined
    if (body.schedulerLock !== false) {
      try {
        lockHandle = mw.schedulerLock.acquire({ planId, goal: plan.goal })
        mw.planEvents.append({ type: 'lock.acquired', planId })
      } catch (err) {
        if (err instanceof SchedulerLockError) {
          return c.json({
            error: 'scheduler_locked',
            message: 'Another plan is already executing for this repo.',
            lock: err.conflict.record,
            lockPath: err.conflict.path,
            activePlans: mw.activePlans().map(([activePlanId, entry]) => ({ planId: activePlanId, goal: entry.plan.goal, status: entry.status })),
          }, 409)
        }
        throw err
      }
    }
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
        planCwd = worktree.worktreePath
      }
    } catch (err) {
      lockHandle?.release()
      if (worktree) cleanupCycleWorktree(worktree)
      return c.json({ error: 'worktree_creation_failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
    const entry = { plan, worktree, boundaryStatus, status: 'executing' as const, createdAt: new Date().toISOString(), schedulerLock: body.schedulerLock !== false, lockPlanId: planId, lockHandle }
    mw.plans.set(planId, entry)
    mw.planEvents.append({ type: 'plan.created', planId, plan, worktree, boundaryStatus, schedulerLock: entry.schedulerLock, lockPlanId: entry.lockPlanId })
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
