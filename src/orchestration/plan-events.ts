import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionPlan, PlanEvent, StepResult } from './plan-engine.js'
import type { WorktreeContext } from './worktree.js'

export type PlanLogEvent =
  | { type: 'plan.created'; planId: string; plan: ActionPlan; worktree?: WorktreeContext; timestamp: string }
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
