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

test('orchestration policy enforces worker-declared downstream gates', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const missingGate: ActionPlan = {
      goal: 'missing gate',
      steps: [{
        id: 'write',
        worker: 'coder',
        mode: 'write',
        task: 'edit files',
        dependsOn: [],
        verifyCommand: 'true',
        artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] },
      }],
    }
    assert.ok(mw.validateExecutionPolicy(missingGate).some(error => error.includes("requires downstream 'review' gate")))

    const gated: ActionPlan = {
      goal: 'gated',
      steps: [
        {
          id: 'write',
          worker: 'coder',
          mode: 'write',
          task: 'edit files',
          dependsOn: [],
          verifyCommand: 'true',
          artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] },
        },
        { id: 'review', worker: 'reviewer', mode: 'verify', gate: 'review', task: 'review write', dependsOn: ['write'] },
      ],
    }
    assert.deepEqual(mw.validateExecutionPolicy(gated), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('orchestration policy validates custom worker capabilities and backends', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    mw.customWorkers.set('research-only', {
      agent: { description: 'read only', tools: ['Read'], prompt: '', model: 'haiku' },
      backend: 'sdk',
      defaultTimeoutSeconds: 60,
      policy: {
        capabilities: ['read'],
        defaultMode: 'read',
        allowedBackends: ['sdk'],
      },
    })

    const plan: ActionPlan = {
      goal: 'custom policy',
      steps: [{ id: 'write', worker: 'research-only', mode: 'write', task: 'try to write', dependsOn: [] }],
    }

    const errors = mw.validateExecutionPolicy(plan)
    assert.ok(errors.some(error => error.includes("does not allow mode 'write'")))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
