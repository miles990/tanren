import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PlanEngine, type ActionPlan } from './plan-engine.js'

function gitInit(cwd: string) {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
}

test('PlanEngine fails a step that changes files outside artifactContract.allowedPaths', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-plan-'))
  try {
    gitInit(cwd)
    mkdirSync(join(cwd, 'allowed'), { recursive: true })
    const engine = new PlanEngine(async () => {
      writeFileSync(join(cwd, 'outside.txt'), 'not allowed', 'utf-8')
      return 'wrote outside file'
    }, { cwd })

    const plan: ActionPlan = {
      goal: 'artifact guard',
      steps: [{
        id: 'write',
        worker: 'writer',
        task: 'write',
        dependsOn: [],
        artifactContract: { allowedPaths: ['allowed'] },
      }],
    }

    const result = await engine.execute(plan)
    assert.equal(result.summary.failed, 1)
    assert.match(result.steps[0].output, /ARTIFACT CONTRACT FAILED/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PlanEngine lets downstream steps continue after non-blocking support failure', async () => {
  const engine = new PlanEngine(async (_worker, task) => {
    if (task === 'support') throw new Error('support unavailable')
    return 'main completed'
  })

  const plan: ActionPlan = {
    goal: 'advisory support can fail',
    acceptance: 'main work completes',
    steps: [
      { id: 'support', worker: 'advisor', task: 'support', dependsOn: [], blocking: false },
      { id: 'main', worker: 'builder', task: 'main', dependsOn: ['support'] },
    ],
  }

  const result = await engine.execute(plan)
  assert.equal(result.steps.find(step => step.id === 'support')?.status, 'failed')
  assert.equal(result.steps.find(step => step.id === 'main')?.status, 'completed')
  assert.equal(result.summary.failed, 0)
  assert.equal(result.accepted, true)
})

test('PlanEngine times out a stuck executor even if the worker never resolves', async () => {
  const engine = new PlanEngine(async () => {
    await new Promise(() => undefined)
    return 'unreachable'
  })

  const plan: ActionPlan = {
    goal: 'stuck worker',
    steps: [
      { id: 'hang', worker: 'worker', task: 'hang', dependsOn: [], timeoutSeconds: 0.01 },
    ],
  }

  const result = await engine.execute(plan)
  const step = result.steps.find(candidate => candidate.id === 'hang')
  assert.equal(step?.status, 'timeout')
  assert.match(step?.output ?? '', /timeout/)
  assert.equal(result.summary.failed, 1)
})

test('PlanEngine respects worker-level max concurrency', async () => {
  let active = 0
  let peak = 0
  const engine = new PlanEngine(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 20))
    active -= 1
    return 'done'
  }, {
    getWorkerMaxConcurrency: worker => worker === 'single-writer' ? 1 : undefined,
  })

  const plan: ActionPlan = {
    goal: 'single writer',
    steps: [
      { id: 'a', worker: 'single-writer', task: 'a', dependsOn: [] },
      { id: 'b', worker: 'single-writer', task: 'b', dependsOn: [] },
    ],
  }

  const result = await engine.execute(plan)
  assert.equal(result.summary.completed, 2)
  assert.equal(peak, 1)
})
