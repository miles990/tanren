import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanStep, StepResult } from './plan-engine.js'
import type { WorkerDefinition } from './workers.js'

export interface StepLearningEvent {
  timestamp: string
  planId: string
  stepId: string
  worker: string
  lessons: string[]
}

export interface StepLearningOptions {
  cwd: string
  planId: string
  step?: PlanStep
  result: StepResult
  worker?: WorkerDefinition
}

const LESSON_PATTERNS = [
  /root cause/i,
  /lesson/i,
  /learning/i,
  /next time/i,
  /prevent/i,
  /根因/,
  /教訓/,
  /學習/,
  /下次/,
  /防範/,
]

const sanitizeLesson = (line: string) => line
  .replace(/^\s*[-*#>|]+\s*/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 500)

export function learningEventsPath(cwd: string, worker?: WorkerDefinition): string {
  const outputPath = worker?.learning?.outputPath ?? 'learning-events.jsonl'
  return join(cwd, outputPath)
}

export function extractStepLessons(output: string, maxLessons = 5): string[] {
  const lessons: string[] = []
  for (const line of output.split('\n')) {
    const lesson = sanitizeLesson(line)
    if (!lesson) continue
    if (!LESSON_PATTERNS.some(pattern => pattern.test(lesson))) continue
    if (!lessons.includes(lesson)) lessons.push(lesson)
    if (lessons.length >= maxLessons) break
  }
  return lessons
}

export function recordStepLearningEvent(opts: StepLearningOptions): StepLearningEvent | null {
  if (opts.worker?.learning?.enabled === false) return null
  const lessons = extractStepLessons(opts.result.output, opts.worker?.learning?.maxLessons ?? 5)
  if (lessons.length === 0) return null
  const event: StepLearningEvent = {
    timestamp: new Date().toISOString(),
    planId: opts.planId,
    stepId: opts.result.id,
    worker: opts.result.worker,
    lessons,
  }
  try {
    appendFileSync(learningEventsPath(opts.cwd, opts.worker), JSON.stringify(event) + '\n', 'utf-8')
  } catch {
    return null
  }
  return event
}

export function readStepLearningEvents(cwd: string, limit = 50): StepLearningEvent[] {
  const path = join(cwd, 'learning-events.jsonl')
  if (!existsSync(path)) return []
  const events: StepLearningEvent[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
    try { events.push(JSON.parse(line) as StepLearningEvent) } catch { /* skip malformed */ }
  }
  return events.slice(-limit).reverse()
}
