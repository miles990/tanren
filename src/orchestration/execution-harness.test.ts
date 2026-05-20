import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluateExecutionHarnessFailure, evaluatePlanStepApproval } from './execution-harness.js'

test('execution harness maps plan step contracts into autonomy-runtime decisions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-exec-harness-'))
  try {
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/index.ts'), 'export {}\n')
    const evaluation = evaluateExecutionHarnessFailure({
      objectiveId: 'objective-1',
      planId: 'plan-1',
      repoRoot: cwd,
      step: {
        id: 'write',
        worker: 'coder',
        task: 'write',
        dependsOn: [],
        verifyCommand: 'test -e src/index.ts',
        artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] },
      },
      result: {
        id: 'write',
        worker: 'coder',
        status: 'failed',
        output: 'Reached maximum number of turns',
        durationMs: 1,
        dispatchOrder: 0,
      },
    })

    assert.equal(evaluation.failureType, 'max_turns')
    assert.equal(evaluation.nextAction, 'decompose')
    assert.equal(evaluation.task.artifactContract.expectedOutputs[0], 'src/index.ts')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('execution harness treats missing expected output as contract failure', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-exec-harness-'))
  try {
    const evaluation = evaluateExecutionHarnessFailure({
      objectiveId: 'objective-1',
      planId: 'plan-1',
      repoRoot: cwd,
      step: {
        id: 'write',
        worker: 'coder',
        task: 'write',
        dependsOn: [],
        artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] },
      },
      result: {
        id: 'write',
        worker: 'coder',
        status: 'failed',
        output: 'done',
        durationMs: 1,
        dispatchOrder: 0,
      },
    })

    assert.equal(evaluation.failureType, 'contract')
    assert.equal(evaluation.nextAction, 'retry_same_step')
    assert.equal(evaluation.runtimeResult.evidence[0].passed, false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('execution harness approves bounded plan steps and blocks credential paths', () => {
  const policy = { repoRoot: '/repo', trustedPaths: ['game', 'docs', 'tools'] }
  const ok = evaluatePlanStepApproval({
    userObjective: 'Build the demo.',
    policy,
    step: {
      id: 'write',
      worker: 'coder',
      task: 'edit game script',
      dependsOn: [],
      artifactContract: { allowedPaths: ['game'], expectedPaths: ['game/scripts/main.gd'] },
    },
  })
  assert.equal(ok.status, 'approved')

  const blocked = evaluatePlanStepApproval({
    userObjective: 'Build the demo.',
    policy,
    step: {
      id: 'secret',
      worker: 'coder',
      task: 'inspect .env',
      dependsOn: [],
      artifactContract: { allowedPaths: ['.'], expectedPaths: ['.env'] },
    },
  })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.riskType, 'credential_access')
})
