import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

test('objective status requires completed gates to return PASS verdicts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const plan: ActionPlan = {
      goal: 'gate verdicts',
      steps: [
        { id: 'review', worker: 'reviewer', mode: 'verify', gate: 'review', task: 'review', dependsOn: [] },
        { id: 'qa', worker: 'reviewer', mode: 'verify', gate: 'qa', task: 'qa', dependsOn: ['review'] },
        { id: 'release', worker: 'reviewer', mode: 'verify', gate: 'release', task: 'release', dependsOn: ['qa'] },
      ],
    }

    mw.plans.set('plan-gates', { plan, status: 'completed', createdAt: new Date().toISOString() })
    for (const step of plan.steps) {
      mw.buffer.submit({ id: step.id, planId: 'plan-gates', worker: step.worker, task: step.task })
      mw.buffer.start(step.id, 'plan-gates')
    }
    mw.buffer.complete('review', 'PASS\nNo blockers.', 'plan-gates')
    mw.buffer.complete('qa', 'PASS/FAIL: PASS\nReady.', 'plan-gates')
    mw.buffer.complete('release', 'Result: FAIL\nRelease is blocked.', 'plan-gates')

    const status = mw.objectiveStatus()
    assert.equal(status.mergeReady, false)
    assert.match(status.blockedReason ?? '', /release gate fail/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('stale running watchdog marks timed-out steps and fails the plan', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-watchdog-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const plan: ActionPlan = {
      goal: 'stale plan',
      steps: [{ id: 'hang', worker: 'shell', task: 'sleep 999', dependsOn: [], timeoutSeconds: 1 }],
    }
    mw.plans.set('plan-stale', { plan, status: 'executing', createdAt: new Date().toISOString(), schedulerLock: false })
    mw.buffer.submit({ id: 'hang', planId: 'plan-stale', worker: 'shell', task: 'sleep 999' })
    mw.buffer.start('hang', 'plan-stale')
    const task = mw.buffer.get('hang', 'plan-stale')!
    task.startedAt = new Date(Date.now() - 5_000)

    const reaped = await mw.reapStaleRunningTasks({ graceMs: 0, startRepair: false })
    assert.equal(reaped.length, 1)
    assert.equal(mw.buffer.get('hang', 'plan-stale')?.status, 'timeout')
    assert.equal(mw.plans.get('plan-stale')?.status, 'failed')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('supervisor tick auto-merges a completed gated worktree plan', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-merge-repo-'))
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src/index.txt'), 'base\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    const worktree = join(tmpdir(), `tanren-merge-wt-${Date.now()}`)
    execFileSync('git', ['worktree', 'add', '-b', 'plan-branch', worktree], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(worktree, 'src/index.txt'), 'base\nslice\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'slice'], { cwd: worktree, stdio: 'ignore' })

    const mw = createOrchestrationMiddleware({ cwd: repo })
    const plan: ActionPlan = {
      goal: 'merge slice',
      steps: [
        { id: 'implement', worker: 'shell', mode: 'write', task: 'true', dependsOn: [] },
        { id: 'review', worker: 'shell', mode: 'verify', gate: 'review', task: 'printf PASS', dependsOn: ['implement'] },
        { id: 'qa', worker: 'shell', mode: 'verify', gate: 'qa', task: 'printf PASS', dependsOn: ['review'] },
        { id: 'release', worker: 'shell', mode: 'verify', gate: 'release', task: 'printf PASS', dependsOn: ['qa'] },
      ],
    }
    mw.plans.set('plan-merge', {
      plan,
      status: 'completed',
      createdAt: new Date().toISOString(),
      schedulerLock: false,
      worktree: {
        mode: 'cycle-worktree',
        repoRoot: repo,
        originalCwd: repo,
        cwd: worktree,
        worktreePath: worktree,
        branchName: 'plan-branch',
        baseRef: 'HEAD',
        cleanup: 'never',
      },
    })
    for (const step of plan.steps) {
      mw.buffer.submit({ id: step.id, planId: 'plan-merge', worker: step.worker, task: step.task })
      mw.buffer.start(step.id, 'plan-merge')
      mw.buffer.complete(step.id, step.gate ? 'PASS\nok' : 'implemented', 'plan-merge')
    }

    const decision = mw.supervisorDecision()
    assert.equal(decision.action, 'run_merge_gate')
    const result = await mw.supervisorTick()
    assert.equal(result.status, 'completed')
    assert.match(execFileSync('git', ['log', '--oneline', '-1'], { cwd: repo, encoding: 'utf-8' }), /slice/)
    assert.equal(mw.objectiveStatus().productReady, true)
  } finally {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' }) } catch { /* ignore */ }
    rmSync(repo, { recursive: true, force: true })
  }
})

test('supervisor tick dry-run builds a valid smallest product slice plan', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const result = await mw.supervisorTick({
      dryRun: true,
      smallestProductSlice: {
        goal: 'demo slice',
        implementationTask: 'Create a visible demo slice.',
        allowedPaths: ['src'],
        expectedPaths: ['src/index.ts'],
        verifyCommand: 'test -e src/index.ts',
      },
    })

    assert.equal(result.status, 'dry_run')
    assert.equal(result.action, 'start_smallest_product_slice')
    assert.equal(result.plan?.steps.length, 4)
    assert.deepEqual(mw.validateExecutionPolicy(result.plan!), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('supervisor tick falls back to smallest product slice after stale failed repair state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const failedPlan: ActionPlan = {
      goal: 'old failed repair',
      steps: [
        { id: 'repair-verify', worker: 'reviewer', mode: 'verify', task: 'verify old repair', dependsOn: [] },
      ],
    }
    mw.plans.set('plan-old', {
      plan: failedPlan,
      status: 'failed',
      createdAt: new Date().toISOString(),
      repairAttempt: 1,
    })
    mw.buffer.submit({ id: 'repair-verify', planId: 'plan-old', worker: 'reviewer', task: 'verify old repair' })
    mw.buffer.start('repair-verify', 'plan-old')
    mw.buffer.fail('repair-verify', 'Reached maximum number of turns while verifying old repair.', 'plan-old')

    const result = await mw.supervisorTick({
      dryRun: true,
      smallestProductSlice: {
        goal: 'demo slice',
        implementationTask: 'Create a visible demo slice.',
        allowedPaths: ['src'],
        expectedPaths: ['src/index.ts'],
        verifyCommand: 'test -e src/index.ts',
      },
    })

    assert.equal(result.status, 'dry_run')
    assert.equal(result.action, 'decompose_failed_step')
    assert.equal(result.decision.failureType, 'max_turns')
    assert.equal(result.plan?.goal, 'demo slice')
    assert.equal(result.plan?.steps.length, 4)
    assert.equal(mw.runtimeTrace[0]?.type, 'approval.preflight')
    assert.equal(mw.runtimeTrace[1]?.type, 'supervisor.fallback_smallest_slice')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('completed repair exposes and dry-runs downstream resume instead of waiting', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const productPlan: ActionPlan = {
      goal: 'demo product',
      steps: [
        {
          id: 'implement-slice',
          worker: 'coder',
          mode: 'write',
          task: 'implement',
          dependsOn: [],
          verifyCommand: 'true',
          artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] },
        },
        { id: 'review-slice', worker: 'reviewer', mode: 'verify', gate: 'review', task: 'review', dependsOn: ['implement-slice'] },
        { id: 'qa-slice', worker: 'reviewer', mode: 'verify', gate: 'qa', task: 'qa', dependsOn: ['review-slice'] },
        { id: 'release-slice', worker: 'reviewer', mode: 'verify', gate: 'release', task: 'release', dependsOn: ['qa-slice'] },
      ],
    }
    const repairPlan: ActionPlan = {
      goal: 'repair product',
      steps: [
        { id: 'repair-verify', worker: 'reviewer', mode: 'verify', task: 'verify', dependsOn: [] },
      ],
    }

    mw.plans.set('plan-product', {
      plan: productPlan,
      status: 'failed',
      createdAt: '2026-05-20T00:00:00.000Z',
    })
    mw.buffer.submit({ id: 'implement-slice', planId: 'plan-product', worker: 'coder', task: 'implement' })
    mw.buffer.start('implement-slice', 'plan-product')
    mw.buffer.fail('implement-slice', 'Reached maximum number of turns', 'plan-product')
    for (const step of productPlan.steps.slice(1)) {
      mw.buffer.submit({ id: step.id, planId: 'plan-product', worker: step.worker, task: step.task })
    }

    mw.plans.set('plan-repair', {
      plan: repairPlan,
      status: 'completed',
      createdAt: '2026-05-20T00:01:00.000Z',
      completedAt: '2026-05-20T00:02:00.000Z',
      repairOf: 'plan-product',
      repairAttempt: 1,
    })
    mw.buffer.submit({ id: 'repair-verify', planId: 'plan-repair', worker: 'reviewer', task: 'verify' })
    mw.buffer.start('repair-verify', 'plan-repair')
    mw.buffer.complete('repair-verify', 'PASS', 'plan-repair')

    const status = mw.objectiveStatus()
    assert.match(status.blockedReason ?? '', /needs downstream resume/)
    assert.equal(status.nextMergeGate?.gate, 'review')

    const decision = mw.supervisorDecision()
    assert.equal(decision.action, 'resume_downstream')
    assert.equal(decision.targetPlanId, 'plan-product')

    const tick = await mw.supervisorTick({ dryRun: true })
    assert.equal(tick.status, 'dry_run')
    assert.equal(tick.action, 'resume_downstream')
    assert.equal(tick.submittedPlanId, 'plan-product')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('downstream resume retries failed gate steps instead of marking them repaired', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const productPlan: ActionPlan = {
      goal: 'demo product',
      steps: [
        { id: 'implement-slice', worker: 'shell', mode: 'write', task: 'true', dependsOn: [] },
        { id: 'review-slice', worker: 'shell', mode: 'verify', gate: 'review', task: 'printf PASS', dependsOn: ['implement-slice'] },
        { id: 'qa-slice', worker: 'shell', mode: 'verify', gate: 'qa', task: 'printf PASS', dependsOn: ['review-slice'] },
        { id: 'release-slice', worker: 'shell', mode: 'verify', gate: 'release', task: 'printf PASS', dependsOn: ['qa-slice'] },
      ],
    }
    const repairPlan: ActionPlan = {
      goal: 'repair review provider failure',
      steps: [{ id: 'repair-verify', worker: 'shell', mode: 'verify', task: 'printf PASS', dependsOn: [] }],
    }

    mw.plans.set('plan-product', { plan: productPlan, status: 'failed', createdAt: '2026-05-20T00:00:00.000Z', schedulerLock: false })
    mw.buffer.submit({ id: 'implement-slice', planId: 'plan-product', worker: 'shell', task: 'true' })
    mw.buffer.start('implement-slice', 'plan-product')
    mw.buffer.complete('implement-slice', 'implemented', 'plan-product')
    mw.buffer.submit({ id: 'review-slice', planId: 'plan-product', worker: 'shell', task: 'printf PASS' })
    mw.buffer.start('review-slice', 'plan-product')
    mw.buffer.fail('review-slice', 'temporary provider output missing', 'plan-product')
    for (const step of productPlan.steps.slice(2)) {
      mw.buffer.submit({ id: step.id, planId: 'plan-product', worker: step.worker, task: step.task })
    }

    mw.plans.set('plan-repair', {
      plan: repairPlan,
      status: 'completed',
      createdAt: '2026-05-20T00:01:00.000Z',
      completedAt: '2026-05-20T00:02:00.000Z',
      repairOf: 'plan-product',
      repairAttempt: 1,
      schedulerLock: false,
    })
    mw.buffer.submit({ id: 'repair-verify', planId: 'plan-repair', worker: 'shell', task: 'printf PASS' })
    mw.buffer.start('repair-verify', 'plan-repair')
    mw.buffer.complete('repair-verify', 'PASS', 'plan-repair')

    const tick = await mw.supervisorTick()
    assert.equal(tick.status, 'executing')
    assert.equal(tick.action, 'resume_downstream')
    await mw.plans.get('plan-product')?.resultPromise

    const review = mw.buffer.get('review-slice', 'plan-product')
    assert.equal(review?.status, 'completed')
    assert.equal(review?.result, 'PASS')
    assert.equal(mw.buffer.get('qa-slice', 'plan-product')?.status, 'completed')
    assert.equal(mw.buffer.get('release-slice', 'plan-product')?.status, 'completed')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('supervisor tick enforces approval policy before submission', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const result = await mw.supervisorTick({
      dryRun: true,
      smallestProductSlice: {
        goal: 'unsafe slice',
        implementationTask: 'Inspect credentials while preparing the demo.',
        allowedPaths: ['.'],
        expectedPaths: ['.env'],
        verifyCommand: 'test -e .env',
      },
      approval: {
        policy: {
          repoRoot: cwd,
          trustedPaths: ['game', 'docs', 'tools'],
        },
      },
    })

    assert.equal(result.error, 'approval_blocked')
    assert.equal(result.approvals?.[0].riskType, 'credential_access')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
