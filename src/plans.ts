/**
 * Tanren — Plan System (Continuation Management)
 *
 * Persists intent and progress across ticks. The agent writes plans,
 * the framework tracks state and injects context.
 *
 * Constraint Texture:
 * - Deterministic (code): read plan files, track steps, run verify, inject context
 * - Cognitive (agent): write plans, decide when steps are done, make architecture decisions
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PerceptionPlugin, ActionHandler } from './types.js'

const execFileAsync = promisify(execFile)

// === Plan Data Model ===

export interface PlanStep {
  index: number
  description: string
  done: boolean
  context?: string[]      // files to pre-read
  verify?: string         // shell command
  verifyResult?: string   // last verify output
}

export interface Plan {
  name: string
  status: 'active' | 'paused' | 'done'
  steps: PlanStep[]
  currentStep: number     // index of first incomplete step
  file: string            // path to plan file
}

// === Plan Parser ===

export function parsePlan(content: string, file: string): Plan | null {
  const lines = content.split('\n')

  // Extract name from first heading
  const heading = lines.find(l => l.startsWith('# '))
  if (!heading) return null
  const nameMatch = heading.match(/^#\s+(?:Plan:\s*)?(.+)/)
  const name = nameMatch?.[1]?.trim() ?? 'unnamed'

  // Extract status
  const statusLine = lines.find(l => /^status:\s*/i.test(l))
  const status = (statusLine?.match(/^status:\s*(\w+)/i)?.[1] ?? 'active') as Plan['status']

  // Parse steps
  const steps: PlanStep[] = []
  for (const line of lines) {
    const stepMatch = line.match(/^- \[([ x])\]\s*(\d+)\.\s*(.+)/)
    if (!stepMatch) continue

    const done = stepMatch[1] === 'x'
    const index = parseInt(stepMatch[2], 10)
    let description = stepMatch[3]

    // Extract inline metadata
    const context: string[] = []
    const contextMatch = description.match(/\|\s*context:\s*\[([^\]]+)\]/)
    if (contextMatch) {
      context.push(...contextMatch[1].split(',').map(s => s.trim()))
      description = description.replace(contextMatch[0], '').trim()
    }

    let verify: string | undefined
    const verifyMatch = description.match(/\|\s*verify:\s*(.+?)(?:\||$)/)
    if (verifyMatch) {
      verify = verifyMatch[1].trim()
      description = description.replace(verifyMatch[0], '').trim()
    }

    // Clean trailing pipes
    description = description.replace(/\|\s*$/, '').trim()

    steps.push({ index, description, done, context: context.length > 0 ? context : undefined, verify })
  }

  if (steps.length === 0) return null

  const currentStep = steps.find(s => !s.done)?.index ?? steps[steps.length - 1].index

  return { name, status, steps, currentStep, file }
}

// === Plan File Operations ===

export function loadPlans(plansDir: string): Plan[] {
  if (!existsSync(plansDir)) return []

  const files = readdirSync(plansDir).filter(f => f.endsWith('.md')).sort()
  const plans: Plan[] = []

  for (const file of files) {
    const content = readFileSync(join(plansDir, file), 'utf-8')
    const plan = parsePlan(content, join(plansDir, file))
    if (plan) plans.push(plan)
  }

  return plans
}

export function markStepDone(plan: Plan, stepIndex: number): boolean {
  const content = readFileSync(plan.file, 'utf-8')
  const lines = content.split('\n')
  let found = false

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^- \[ \]\s*(\d+)\./)
    if (match && parseInt(match[1], 10) === stepIndex) {
      lines[i] = lines[i].replace('- [ ]', '- [x]')
      found = true
      break
    }
  }

  if (found) {
    writeFileSync(plan.file, lines.join('\n'), 'utf-8')
    // Check if all steps done → mark plan done
    const updated = parsePlan(lines.join('\n'), plan.file)
    if (updated && updated.steps.every(s => s.done)) {
      const statusIdx = lines.findIndex(l => /^status:\s*/i.test(l))
      if (statusIdx >= 0) {
        lines[statusIdx] = 'status: done'
        writeFileSync(plan.file, lines.join('\n'), 'utf-8')
      }
    }
  }

  return found
}

// === Verify Runner ===

async function runVerify(command: string, workDir: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      cwd: workDir,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    })
    const output = (stdout + stderr).trim()
    return output ? `✅ PASSED: ${output.slice(0, 500)}` : '✅ PASSED'
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `❌ FAILED: ${msg.slice(0, 500)}`
  }
}

// === Perception Plugin ===

export function createPlanPerception(plansDir: string, workDir: string): PerceptionPlugin {
  return {
    name: 'active-plan',
    category: 'plan',
    fn: () => {
      const plans = loadPlans(plansDir)
      const active = plans.filter(p => p.status === 'active')

      if (active.length === 0) return ''

      const sections: string[] = []

      for (const plan of active) {
        const current = plan.steps.find(s => s.index === plan.currentStep)
        if (!current) continue

        const progress = plan.steps.filter(s => s.done).length
        const total = plan.steps.length

        let section = `<plan name="${plan.name}" progress="${progress}/${total}">\n`
        section += `Current step ${current.index}: ${current.description}\n`

        // Show completed steps briefly
        const doneSteps = plan.steps.filter(s => s.done)
        if (doneSteps.length > 0) {
          section += `\nCompleted: ${doneSteps.map(s => `${s.index}. ${s.description}`).join(', ')}\n`
        }

        // Show upcoming steps
        const upcoming = plan.steps.filter(s => !s.done && s.index !== current.index)
        if (upcoming.length > 0) {
          section += `Next: ${upcoming.map(s => `${s.index}. ${s.description}`).join(', ')}\n`
        }

        // Show last verify result if exists
        if (current.verifyResult) {
          section += `\nLast verify: ${current.verifyResult}\n`
        }

        section += '</plan>'
        sections.push(section)
      }

      return sections.join('\n\n')
    },
  }
}

// === Context Injection Plugin ===

export function createPlanContextInjection(plansDir: string, workDir: string): PerceptionPlugin {
  return {
    name: 'plan-context',
    category: 'plan',
    fn: () => {
      const plans = loadPlans(plansDir)
      const active = plans.filter(p => p.status === 'active')

      const sections: string[] = []

      for (const plan of active) {
        const current = plan.steps.find(s => s.index === plan.currentStep)
        if (!current?.context) continue

        for (const filePath of current.context) {
          const absPath = resolve(workDir, filePath)
          if (!existsSync(absPath)) {
            sections.push(`<plan-context file="${filePath}">[file not found]</plan-context>`)
            continue
          }
          try {
            const content = readFileSync(absPath, 'utf-8')
            // Cap at 5000 chars per file to avoid blowing up context
            const capped = content.length > 5000
              ? content.slice(0, 5000) + `\n... (${content.length - 5000} chars truncated)`
              : content
            sections.push(`<plan-context file="${filePath}">\n${capped}\n</plan-context>`)
          } catch {
            sections.push(`<plan-context file="${filePath}">[read error]</plan-context>`)
          }
        }
      }

      return sections.join('\n\n')
    },
  }
}

// === Action: step ===

export function createStepAction(plansDir: string, workDir: string): ActionHandler {
  return {
    type: 'step',
    description: 'Mark a plan step as completed. Framework auto-advances to next step and runs verification if specified.',
    toolSchema: {
      properties: {
        plan: { type: 'string', description: 'Plan name (from <plan name="...">)' },
        step: { type: 'number', description: 'Step number to mark as done' },
      },
      required: ['step'],
    },
    async execute(action) {
      const stepNum = (action.input?.step as number) ?? parseInt(action.content, 10)
      const planName = action.input?.plan as string | undefined

      if (isNaN(stepNum)) return '[step error: invalid step number]'

      const plans = loadPlans(plansDir)
      const active = plans.filter(p => p.status === 'active')

      // Find matching plan
      let plan: Plan | undefined
      if (planName) {
        plan = active.find(p => p.name.toLowerCase().includes(planName.toLowerCase()))
      }
      // If only one active plan, use it
      if (!plan && active.length === 1) {
        plan = active[0]
      }
      if (!plan) return `[step error: no active plan found${planName ? ` matching "${planName}"` : ''}]`

      const step = plan.steps.find(s => s.index === stepNum)
      if (!step) return `[step error: step ${stepNum} not found in plan "${plan.name}"]`
      if (step.done) return `Step ${stepNum} already completed.`

      // Mark done
      const marked = markStepDone(plan, stepNum)
      if (!marked) return `[step error: could not mark step ${stepNum}]`

      // Run verify if specified
      let verifyOutput = ''
      if (step.verify) {
        verifyOutput = await runVerify(step.verify, workDir)
        // Store verify result for next tick's perception
        const content = readFileSync(plan.file, 'utf-8')
        // We don't modify the plan file for verify results — just return it
      }

      // Find next step
      const updatedPlan = parsePlan(readFileSync(plan.file, 'utf-8'), plan.file)
      const nextStep = updatedPlan?.steps.find(s => !s.done)

      let result = `✓ Step ${stepNum} completed in plan "${plan.name}".`
      if (verifyOutput) result += `\nVerify: ${verifyOutput}`
      if (nextStep) {
        result += `\nNext: Step ${nextStep.index} — ${nextStep.description}`
      } else {
        result += '\n🎉 All steps completed! Plan is done.'
      }

      return result
    },
  }
}

// === Integration: register all plan components ===

export function createPlanSystem(memoryDir: string, workDir: string): {
  perceptionPlugins: PerceptionPlugin[]
  actions: ActionHandler[]
} {
  const plansDir = join(memoryDir, 'plans')
  if (!existsSync(plansDir)) mkdirSync(plansDir, { recursive: true })

  return {
    perceptionPlugins: [
      createPlanPerception(plansDir, workDir),
      createPlanContextInjection(plansDir, workDir),
    ],
    actions: [
      createStepAction(plansDir, workDir),
    ],
  }
}
