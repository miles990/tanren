import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createOrchestrationMiddleware } from './router.js'
import type { ActionPlan } from './plan-engine.js'

test('orchestration policy rejects writer steps without artifact contract and verification', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const plan: ActionPlan = {
      goal: 'policy',
      steps: [{ id: 'write', worker: 'coder', task: 'edit files', dependsOn: [] }],
    }
    const errors = mw.validateExecutionPolicy(plan)
    assert.ok(errors.some(error => error.includes('verifyCommand')))
    assert.ok(errors.some(error => error.includes('allowedPaths')))
    assert.ok(errors.some(error => error.includes('expectedPaths')))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('orchestration policy allows read-mode writer workers but enforces report contracts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const readPlan: ActionPlan = {
      goal: 'read',
      steps: [{ id: 'classify', worker: 'coder', mode: 'read', task: 'read only', dependsOn: [] }],
    }
    assert.deepEqual(mw.validateExecutionPolicy(readPlan), [])

    const reportPlan: ActionPlan = {
      goal: 'report',
      steps: [{ id: 'report', worker: 'coder', mode: 'report', task: 'write report', dependsOn: [] }],
    }
    assert.ok(mw.validateExecutionPolicy(reportPlan).some(error => error.includes('verifyCommand')))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
