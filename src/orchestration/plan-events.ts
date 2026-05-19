import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionPlan, PlanEvent, StepResult } from './plan-engine.js'
import type { WorktreeContext } from './worktree.js'

export type PlanLogEvent =
  | { type: 'plan.created'; planId: string; plan: ActionPlan; worktree?: WorktreeContext; boundaryStatus?: string[]; schedulerLock?: boolean; lockPlanId?: string; timestamp: string }
  | { type: 'plan.started'; planId: string; timestamp: string; attempt: number }
  | { type: 'plan.completed'; planId: string; status: 'completed' | 'failed'; timestamp: string }
  | { type: 'plan.failed'; planId: string; error: string; timestamp: string }
  | { type: 'repair.created'; planId: string; repairPlanId: string; repairAttempt: number; failedStepIds: string[]; timestamp: string }
  | { type: 'step.dispatched'; planId: string; stepId: string; worker: string; timestamp: string }
  | { type: 'step.completed'; planId: string; stepId: string; worker: string; timestamp: string }
  | { type: 'step.failed'; planId: string; stepId: string; worker: string; status: StepResult['status']; output: string; timestamp: string }
  | { type: 'step.retrying'; planId: string; stepId: string; attempt: number; error: string; timestamp: string }
  | { type: 'lock.acquired'; planId: string; timestamp: string }
  | { type: 'lock.released'; planId: string; timestamp: string }
  | { type: 'merge.completed'; planId: string; targetBranch: string; method: 'ff' | 'squash'; timestamp: string }
  | { type: 'merge.failed'; planId: string; error: string; timestamp: string }

export class PlanEventLog {
  private path: string

  constructor(cwd: string) {
    this.path = join(cwd, 'plan-events.jsonl')
  }

  append(event: Record<string, unknown> & { type: PlanLogEvent['type']; timestamp?: string }): void {
    const fullEvent = { ...event, timestamp: event.timestamp ?? new Date().toISOString() } as PlanLogEvent
    try { appendFileSync(this.path, JSON.stringify(fullEvent) + '\n', 'utf-8') } catch { /* fail-open */ }
  }

  readAll(): PlanLogEvent[] {
    if (!existsSync(this.path)) return []
    const events: PlanLogEvent[] = []
    for (const line of readFileSync(this.path, 'utf-8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line) as PlanLogEvent) } catch { /* skip malformed */ }
    }
    return events
  }

  replay(): Map<string, { plan: ActionPlan; worktree?: WorktreeContext; boundaryStatus?: string[]; status: 'executing' | 'completed' | 'failed'; createdAt: string; completedAt?: string; repairOf?: string; repairAttempt?: number; schedulerLock?: boolean; lockPlanId?: string }> {
    const plans = new Map<string, { plan: ActionPlan; worktree?: WorktreeContext; boundaryStatus?: string[]; status: 'executing' | 'completed' | 'failed'; createdAt: string; completedAt?: string; repairOf?: string; repairAttempt?: number; schedulerLock?: boolean; lockPlanId?: string }>()
    const repairParents = new Map<string, { repairOf: string; repairAttempt: number }>()
    for (const event of this.readAll()) {
      switch (event.type) {
        case 'plan.created': {
          const repair = repairParents.get(event.planId)
          plans.set(event.planId, {
            plan: event.plan,
            worktree: event.worktree,
            boundaryStatus: event.boundaryStatus,
            status: 'executing',
            createdAt: event.timestamp,
            repairOf: repair?.repairOf,
            repairAttempt: repair?.repairAttempt,
            schedulerLock: event.schedulerLock ?? true,
            lockPlanId: event.lockPlanId ?? repair?.repairOf ?? event.planId,
          })
          break
        }
        case 'repair.created':
          repairParents.set(event.repairPlanId, { repairOf: event.planId, repairAttempt: event.repairAttempt })
          if (plans.has(event.repairPlanId)) {
            const entry = plans.get(event.repairPlanId)!
            entry.repairOf = event.planId
            entry.repairAttempt = event.repairAttempt
            entry.lockPlanId = event.planId
          }
          break
        case 'plan.started':
          if (plans.has(event.planId)) plans.get(event.planId)!.status = 'executing'
          break
        case 'plan.completed':
          if (plans.has(event.planId)) {
            const entry = plans.get(event.planId)!
            entry.status = event.status
            entry.completedAt = event.timestamp
          }
          break
        case 'plan.failed':
          if (plans.has(event.planId)) {
            const entry = plans.get(event.planId)!
            entry.status = 'failed'
            entry.completedAt = event.timestamp
          }
          break
      }
    }
    return plans
  }

  appendEngineEvent(planId: string, event: PlanEvent): void {
    switch (event.type) {
      case 'step.dispatched':
        this.append({ type: 'step.dispatched', planId, stepId: event.step.id, worker: event.step.worker })
        break
      case 'step.completed':
        this.append({ type: 'step.completed', planId, stepId: event.result.id, worker: event.result.worker })
        break
      case 'step.failed':
        this.append({ type: 'step.failed', planId, stepId: event.result.id, worker: event.result.worker, status: event.result.status, output: event.result.output.slice(0, 2000) })
        break
      case 'step.retrying':
        this.append({ type: 'step.retrying', planId, stepId: event.step.id, attempt: event.attempt, error: event.error.slice(0, 2000) })
        break
    }
  }
}
