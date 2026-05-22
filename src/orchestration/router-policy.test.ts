import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createOrchestrationMiddleware } from './router.js'
import type { ActionPlan } from './plan-engine.js'
import { extractStepLessons, recordStepLearningEvent } from './learning-events.js'
import { auditBranchHygiene, cleanupMergedCycleBranches } from './branch-hygiene.js'
import { writeProductionReports } from './production-reports.js'

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

test('orchestration policy blocks production use until required worker qualification passes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-qualification-policy-'))
  try {
    writeFileSync(join(cwd, 'worker-qualifications.json'), JSON.stringify({
      workers: [{
        worker: 'reviewer',
        task: 'prove review ability',
        requiredForProduction: true,
      }],
    }), 'utf-8')
    const mw = createOrchestrationMiddleware({ cwd })
    const productionPlan: ActionPlan = {
      goal: 'production review',
      steps: [{ id: 'review', worker: 'reviewer', mode: 'verify', task: 'review', dependsOn: [] }],
    }
    assert.ok(mw.validateExecutionPolicy(productionPlan).some(error => error.includes('must pass worker qualification')))
    const qualificationPlan: ActionPlan = {
      goal: 'Worker qualification: reviewer',
      steps: [{ id: 'qualify-reviewer', worker: 'reviewer', mode: 'verify', task: 'qualify', dependsOn: [] }],
    }
    assert.deepEqual(mw.validateExecutionPolicy(qualificationPlan), [])

    const writerQualificationPlan: ActionPlan = {
      goal: 'Worker qualification: gameplay-engineer',
      steps: [{
        id: 'qualify-gameplay-engineer',
        worker: 'gameplay-engineer',
        mode: 'write',
        task: 'qualify',
        dependsOn: [],
        verifyCommand: 'true',
        artifactContract: { allowedPaths: ['game'], expectedPaths: ['game/scripts/main.gd'] },
      }],
    }
    assert.deepEqual(mw.validateExecutionPolicy(writerQualificationPlan), [])

    writeFileSync(join(cwd, 'worker-qualification-results.json'), JSON.stringify({
      reviewer: {
        worker: 'reviewer',
        status: 'passed',
        updatedAt: new Date().toISOString(),
      },
    }), 'utf-8')
    assert.deepEqual(mw.validateExecutionPolicy(productionPlan), [])
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

test('orchestration policy supports docker and swarm workers as bounded execution adapters', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-policy-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    mw.customWorkers.set('docker-agent', {
      agent: { description: 'container agent', tools: [], prompt: '', model: 'container' },
      backend: 'docker',
      docker: { image: 'example/agent:latest' },
      defaultTimeoutSeconds: 60,
      policy: {
        capabilities: ['write', 'verify'],
        defaultMode: 'write',
        allowedBackends: ['docker'],
        requiresArtifactContract: true,
      },
    })
    mw.customWorkers.set('external-swarm', {
      agent: { description: 'external swarm', tools: [], prompt: '', model: 'swarm' },
      backend: 'swarm',
      swarm: { url: 'http://localhost:9999/dispatch' },
      defaultTimeoutSeconds: 60,
      policy: {
        capabilities: ['verify'],
        defaultMode: 'verify',
        allowedBackends: ['swarm'],
      },
    })

    const valid: ActionPlan = {
      goal: 'adapter policy',
      steps: [
        {
          id: 'write',
          worker: 'docker-agent',
          mode: 'write',
          task: 'edit bounded files',
          dependsOn: [],
          verifyCommand: 'test -e game/main.gd',
          artifactContract: { allowedPaths: ['game'], expectedPaths: ['game/main.gd'] },
        },
        { id: 'verify', worker: 'external-swarm', task: 'review output', dependsOn: ['write'] },
      ],
    }
    assert.deepEqual(mw.validateExecutionPolicy(valid), [])

    const missingContract: ActionPlan = {
      goal: 'adapter policy fail',
      steps: [{ id: 'write', worker: 'docker-agent', mode: 'write', task: 'edit files', dependsOn: [] }],
    }
    assert.ok(mw.validateExecutionPolicy(missingContract).some(error => error.includes('artifactContract.allowedPaths')))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('step learning extraction records root-cause style lessons', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-learning-'))
  try {
    const lessons = extractStepLessons('Summary\nRoot cause: task scope was too broad.\nNext time: split work before dispatch.')
    assert.deepEqual(lessons, ['Root cause: task scope was too broad.', 'Next time: split work before dispatch.'])

    const event = recordStepLearningEvent({
      cwd,
      planId: 'plan-1',
      result: {
        id: 'qa',
        worker: 'reviewer',
        status: 'completed',
        output: '根因: verification command did not cover the UI.\n防範: add a browser check.',
        durationMs: 1,
        dispatchOrder: 0,
      },
    })
    assert.equal(event?.lessons.length, 2)
    assert.equal(event?.worker, 'reviewer')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production reports write boss, product brief, and roadmap snapshots', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-production-reports-'))
  try {
    writeProductionReports(cwd, {
      bossReportPath: 'docs/boss-report.md',
      productBriefPath: 'docs/product-brief-current.md',
      roadmapPath: 'docs/roadmap-current.md',
    }, {
      timestamp: '2026-05-20T00:00:00.000Z',
      objective: {
        lifecyclePhase: 'blocked',
        productReady: false,
        blockedReason: 'qa gate failed',
        repairAttempt: 2,
        currentObjective: { planId: 'plan-1', goal: 'demo', status: 'failed' },
      },
      trigger: { type: 'test', planId: 'plan-1', status: 'failed' },
    })
    assert.match(execFileSync('cat', [join(cwd, 'docs/boss-report.md')], { encoding: 'utf-8' }), /qa gate failed/)
    assert.match(execFileSync('cat', [join(cwd, 'docs/product-brief-current.md')], { encoding: 'utf-8' }), /Current product/)
    assert.match(execFileSync('cat', [join(cwd, 'docs/roadmap-current.md')], { encoding: 'utf-8' }), /Branch Hygiene/)
    assert.doesNotMatch(execFileSync('cat', [join(cwd, 'docs/boss-report.md')], { encoding: 'utf-8' }), /game-designer/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production reports use configured owner progress rows', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-production-reporting-owners-'))
  try {
    writeProductionReports(cwd, {
      bossReportPath: 'docs/boss-report.md',
      productBriefPath: 'docs/product-brief-current.md',
      roadmapPath: 'docs/roadmap-current.md',
      productOwner: 'account-owner',
      reportingOwners: [{
        owner: 'domain-expert',
        responsibility: 'Domain requirements',
        currentOutput: 'docs/domain-brief.md',
        status: 'PASS',
        blocker: 'none',
        nextAction: 'Review final specification',
        finalSpecAlignment: 'Aligned',
      }],
    }, {
      timestamp: '2026-05-20T00:00:00.000Z',
      objective: {
        lifecyclePhase: 'running',
        productReady: false,
        currentObjective: { planId: 'plan-1', goal: 'slice', status: 'running' },
      },
      trigger: { type: 'test' },
    })
    const report = execFileSync('cat', [join(cwd, 'docs/boss-report.md')], { encoding: 'utf-8' })
    assert.match(report, /domain-expert/)
    assert.match(report, /docs\/domain-brief.md/)
    assert.doesNotMatch(report, /gameplay-engineer/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production reports avoid timestamp-only rewrites', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-production-reports-stable-'))
  try {
    const config = {
      bossReportPath: 'docs/boss-report.md',
      productBriefPath: 'docs/product-brief-current.md',
      roadmapPath: 'docs/roadmap-current.md',
    }
    const snapshot = {
      timestamp: '2026-05-20T00:00:00.000Z',
      objective: {
        lifecyclePhase: 'blocked',
        productReady: false,
        blockedReason: 'qa gate failed',
        repairAttempt: 2,
        currentObjective: { planId: 'plan-1', goal: 'demo', status: 'failed' },
      },
      trigger: { type: 'test', planId: 'plan-1', status: 'failed' },
    }
    writeProductionReports(cwd, config, snapshot)
    const before = statSync(join(cwd, 'docs/boss-report.md')).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 20))
    writeProductionReports(cwd, config, { ...snapshot, timestamp: '2026-05-20T00:01:00.000Z' })
    assert.equal(statSync(join(cwd, 'docs/boss-report.md')).mtimeMs, before)
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

test('qualification boundary failure overrides worker PASS result', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-qualification-boundary-'))
  const worktree = join(tmpdir(), `tanren-qualification-boundary-wt-${Date.now()}`)
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    writeFileSync(join(repo, 'worker-qualifications.json'), JSON.stringify({
      workers: [{
        worker: 'shell',
        requiredForProduction: true,
        task: 'write qualification artifact',
        verifyCommand: 'test -s docs/qualification/shell.md',
        artifactContract: {
          allowedPaths: ['docs/qualification'],
          expectedPaths: ['docs/qualification/shell.md'],
        },
      }],
    }), 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    mkdirSync(join(worktree, 'docs', 'qualification'), { recursive: true })

    const mw = createOrchestrationMiddleware({ cwd: repo })
    const plan: ActionPlan = {
      goal: 'Worker qualification: shell',
      steps: [{
        id: 'qualify-shell',
        worker: 'shell',
        mode: 'report',
        task: 'write qualification artifact',
        dependsOn: [],
        verifyCommand: 'test -s docs/qualification/shell.md',
        artifactContract: {
          allowedPaths: ['docs/qualification'],
          expectedPaths: ['docs/qualification/shell.md'],
        },
      }],
    }
    const entry = {
      plan,
      status: 'executing' as const,
      createdAt: new Date().toISOString(),
      schedulerLock: false,
      worktree: {
        mode: 'cycle-worktree' as const,
        repoRoot: repo,
        originalCwd: repo,
        cwd: worktree,
        worktreePath: worktree,
        branchName: 'qualification-work',
        baseRef: 'HEAD',
        cleanup: 'never' as const,
      },
      boundaryStatus: mw.gitStatus(repo),
    }
    mw.plans.set('plan-qualification-boundary', entry)
    const fakeRuntime = {
      ...mw.runtime,
      executeWorker: async () => {
        writeFileSync(join(worktree, 'docs', 'qualification', 'shell.md'), 'PASS\nok\n', 'utf-8')
        writeFileSync(join(repo, 'leak.txt'), 'leak\n', 'utf-8')
        return 'PASS\nok\n'
      },
    }
    mw.startPlanExecution(
      'plan-qualification-boundary',
      entry,
      fakeRuntime,
      worktree,
      'worker-qualification',
    )
    await mw.plans.get('plan-qualification-boundary')?.resultPromise

    assert.equal(mw.buffer.get('qualify-shell', 'plan-qualification-boundary')?.status, 'completed')
    assert.equal(mw.buffer.get('worktree-boundary', 'plan-qualification-boundary')?.status, 'failed')
    assert.equal(mw.qualificationStatusFor('shell').status, 'failed')
    assert.match(mw.qualificationStatusFor('shell').summary ?? '', /outside isolated worktree/)
    assert.equal([...mw.plans.values()].some(planEntry => planEntry.repairOf === 'plan-qualification-boundary'), false)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
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

test('branch hygiene marks canonical, active, merged, and unmerged cycle branches', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-branch-hygiene-'))
  try {
    execFileSync('git', ['init', '-b', 'productization/cycle-1'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['branch', 'tanren/cycle/merged'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'tanren/cycle/unmerged'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'slice.txt'), 'slice\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'slice'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'productization/cycle-1'], { cwd: repo, stdio: 'ignore' })

    const report = auditBranchHygiene(repo, ['tanren/cycle/unmerged'], {
      canonicalBranch: 'productization/cycle-1',
      consolidation: { mode: 'block-new-cycles', maxUnmergedCycleBranches: 0 },
    })
    assert.equal(report.sourceOfTruth, 'productization/cycle-1')
    assert.equal(report.branches.find(branch => branch.name === 'productization/cycle-1')?.status, 'canonical')
    assert.equal(report.branches.find(branch => branch.name === 'tanren/cycle/merged')?.recommendedAction, 'cleanup_worktree_and_branch')
    assert.equal(report.branches.find(branch => branch.name === 'tanren/cycle/unmerged')?.status, 'active-cycle')
    assert.equal(report.consolidation.required, false)

    const dryRun = cleanupMergedCycleBranches(repo, ['tanren/cycle/unmerged'], { canonicalBranch: 'productization/cycle-1' })
    assert.deepEqual(dryRun.removed.map(item => item.branch), ['tanren/cycle/merged'])
    assert.equal(execFileSync('git', ['branch', '--list', 'tanren/cycle/merged'], { cwd: repo, encoding: 'utf-8' }).trim(), 'tanren/cycle/merged')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('branch hygiene requires review before cleaning dirty merged worktrees', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-branch-dirty-'))
  const worktree = join(tmpdir(), `tanren-branch-dirty-wt-${Date.now()}`)
  try {
    execFileSync('git', ['init', '-b', 'productization/cycle-1'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['worktree', 'add', '-b', 'tanren/cycle/dirty-merged', worktree, 'productization/cycle-1'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(worktree, 'uncommitted.txt'), 'keep me\n', 'utf-8')

    const report = auditBranchHygiene(repo, [], { canonicalBranch: 'productization/cycle-1' })
    const dirty = report.branches.find(branch => branch.name === 'tanren/cycle/dirty-merged')
    assert.equal(dirty?.status, 'merged-cycle')
    assert.equal(dirty?.dirty, true)
    assert.equal(dirty?.recommendedAction, 'review_dirty_worktree_before_cleanup')
    assert.equal(report.summary.cleanupCandidates, 0)
    assert.equal(report.summary.needsReview, 1)

    const dryRun = cleanupMergedCycleBranches(repo, [], { canonicalBranch: 'productization/cycle-1' })
    assert.deepEqual(dryRun.removed, [])
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo, stdio: 'ignore' }) } catch { /* ignore */ }
    rmSync(repo, { recursive: true, force: true })
  }
})

test('branch hygiene requires consolidation when unmerged cycle branches exceed policy', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-branch-consolidation-'))
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', 'tanren/cycle/product-work'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'feature.txt'), 'feature\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'product feature'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })

    const report = auditBranchHygiene(repo, [], {
      canonicalBranch: 'main',
      consolidation: { mode: 'block-new-cycles', maxUnmergedCycleBranches: 0 },
    })
    assert.equal(report.consolidation.required, true)
    assert.equal(report.consolidation.candidates[0]?.name, 'tanren/cycle/product-work')
    assert.equal(report.consolidation.candidates[0]?.aheadCanonical, 1)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('supervisor tick dry-runs consolidation plan when branch hygiene blocks new cycles', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-supervisor-consolidation-'))
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs/base.md'), 'base\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', 'tanren/cycle/needs-review'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'docs/feature.md'), 'feature\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })

    const mw = createOrchestrationMiddleware({
      cwd: repo,
      branchHygiene: {
        canonicalBranch: 'main',
        consolidation: { mode: 'block-new-cycles', maxUnmergedCycleBranches: 0 },
      },
    })
    const result = await mw.supervisorTick({
      dryRun: true,
      approval: { enforce: false },
      consolidationPlan: {
        goal: 'consolidate',
        steps: [{
          id: 'audit',
          worker: 'analyst',
          mode: 'report',
          task: 'printf PASS',
          dependsOn: [],
          verifyCommand: 'test -e docs/base.md',
          artifactContract: { allowedPaths: ['docs'], expectedPaths: ['docs/base.md'] },
        }],
      },
    })

    assert.equal(result.action, 'consolidate_unmerged_work')
    assert.equal(result.status, 'dry_run')
    assert.equal(result.branchHygiene && typeof result.branchHygiene === 'object', true)
    assert.equal(result.plan?.goal, 'consolidate')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('branch hygiene exposes a consolidation fingerprint that tracks branch heads', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tanren-branch-fingerprint-'))
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
    writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', 'tanren/cycle/product-work'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'feature.txt'), 'feature\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'product feature'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })

    const policy = { canonicalBranch: 'main', consolidation: { mode: 'block-new-cycles' as const, maxUnmergedCycleBranches: 0 } }
    const first = auditBranchHygiene(repo, [], policy)
    assert.notEqual(first.consolidation.fingerprint, '')
    assert.match(first.consolidation.fingerprint, /^tanren\/cycle\/product-work@[0-9a-f]+$/)

    // re-audit without changes -> identical fingerprint
    assert.equal(auditBranchHygiene(repo, [], policy).consolidation.fingerprint, first.consolidation.fingerprint)

    // advance the branch head -> fingerprint changes
    execFileSync('git', ['checkout', 'tanren/cycle/product-work'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'feature.txt'), 'feature v2\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'product feature v2'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })
    assert.notEqual(auditBranchHygiene(repo, [], policy).consolidation.fingerprint, first.consolidation.fingerprint)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

function initRepoWithUnmergedCycleBranch(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'tanren@example.test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Tanren Test'], { cwd: repo })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'docs/base.md'), 'base\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['checkout', '-b', 'tanren/cycle/needs-review'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'docs/feature.md'), 'feature\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'feature'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })
  return repo
}

test('supervisor tick blocks with consolidation_stalled when the loop guard cap is reached', async () => {
  const repo = initRepoWithUnmergedCycleBranch('tanren-consolidation-stalled-')
  try {
    const mw = createOrchestrationMiddleware({
      cwd: repo,
      branchHygiene: {
        canonicalBranch: 'main',
        consolidation: {
          mode: 'block-new-cycles',
          maxUnmergedCycleBranches: 0,
          maxConsolidationAttempts: 0,
          consolidationFallthrough: false,
        },
      },
    })
    const result = await mw.supervisorTick({ dryRun: true, approval: { enforce: false } })
    assert.equal(result.action, 'consolidate_unmerged_work')
    assert.equal(result.status, 'blocked')
    assert.equal(result.error, 'consolidation_stalled')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('supervisor tick falls through to product work when consolidation is stalled', async () => {
  const repo = initRepoWithUnmergedCycleBranch('tanren-consolidation-fallthrough-')
  try {
    const mw = createOrchestrationMiddleware({
      cwd: repo,
      branchHygiene: {
        canonicalBranch: 'main',
        // maxConsolidationAttempts 0 stalls immediately; consolidationFallthrough defaults to true
        consolidation: { mode: 'block-new-cycles', maxUnmergedCycleBranches: 0, maxConsolidationAttempts: 0 },
      },
    })
    // stalled consolidation must not block forever: with no product-slice contract
    // the tick proceeds past consolidation to the product-slice path.
    const result = await mw.supervisorTick({ dryRun: true, approval: { enforce: false } })
    assert.notEqual(result.error, 'consolidation_required')
    assert.equal(result.error, 'missing_smallest_product_slice_contract')
  } finally {
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
    assert.equal(result.plan?.steps.length, 5)
    assert.deepEqual(mw.validateExecutionPolicy(result.plan!), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('supervisor tick starts next product slice after completed objective with no pending gates', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-completed-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const completedPlan: ActionPlan = {
      goal: 'completed consolidation',
      steps: [
        { id: 'verify', worker: 'reviewer', mode: 'verify', task: 'verify', dependsOn: [] },
      ],
    }
    mw.plans.set('plan-completed', {
      plan: completedPlan,
      status: 'completed',
      createdAt: new Date().toISOString(),
    })
    mw.buffer.submit({ id: 'verify', planId: 'plan-completed', worker: 'reviewer', task: 'verify' })
    mw.buffer.complete('verify', 'PASS', 'plan-completed')

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
    assert.equal(result.decision.targetPlanId, 'plan-completed')
    assert.equal(result.plan?.goal, 'demo slice')
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
    assert.equal(result.plan?.steps.length, 5)
    assert.equal(mw.runtimeTrace[0]?.type, 'approval.preflight')
    assert.equal(mw.runtimeTrace[1]?.type, 'supervisor.fallback_smallest_slice')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('supervisor circuit-breaks active repair plans with blocking fix failures', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-circuit-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const repairPlan: ActionPlan = {
      goal: 'repair demo',
      steps: [
        { id: 'fix-implement-slice', worker: 'reviewer', mode: 'write', task: 'fix', dependsOn: [], verifyCommand: 'true', artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] } },
        { id: 'fix-product-lane', worker: 'reviewer', mode: 'write', task: 'fix lane', dependsOn: [], verifyCommand: 'true', artifactContract: { allowedPaths: ['src'], expectedPaths: ['src/index.ts'] } },
      ],
    }
    mw.plans.set('repair-active', {
      plan: repairPlan,
      status: 'executing',
      createdAt: new Date().toISOString(),
      repairOf: 'plan-product',
      repairAttempt: 1,
      schedulerLock: false,
    })
    mw.buffer.submit({ id: 'fix-implement-slice', planId: 'repair-active', worker: 'reviewer', task: 'fix' })
    mw.buffer.start('fix-implement-slice', 'repair-active')
    mw.buffer.fail('fix-implement-slice', 'Verify failed: test -e docs/report.md', 'repair-active')
    mw.buffer.submit({ id: 'fix-product-lane', planId: 'repair-active', worker: 'reviewer', task: 'fix lane' })
    mw.buffer.start('fix-product-lane', 'repair-active')

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

    assert.equal(mw.plans.get('repair-active')?.status, 'failed')
    assert.equal(mw.buffer.get('fix-product-lane', 'repair-active')?.status, 'cancelled')
    assert.equal(result.status, 'dry_run')
    assert.equal(result.plan?.goal, 'demo slice')
    assert.equal(mw.runtimeTrace.some(event => event.type === 'repair.circuit_breaker.closed'), true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('supervisor circuit-breaks nested active repairs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-nested-repair-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const repairPlan: ActionPlan = {
      goal: 'repair product',
      steps: [{ id: 'repair-verify', worker: 'reviewer', mode: 'verify', task: 'verify', dependsOn: [] }],
    }
    const nestedRepairPlan: ActionPlan = {
      goal: 'repair repair',
      steps: [{ id: 'classify-repair-verify', worker: 'reviewer', mode: 'read', task: 'classify', dependsOn: [] }],
    }
    mw.plans.set('repair-parent', {
      plan: repairPlan,
      status: 'failed',
      createdAt: new Date().toISOString(),
      repairOf: 'plan-product',
      repairAttempt: 1,
    })
    mw.plans.set('repair-child', {
      plan: nestedRepairPlan,
      status: 'executing',
      createdAt: new Date().toISOString(),
      repairOf: 'repair-parent',
      repairAttempt: 2,
      schedulerLock: false,
    })
    mw.buffer.submit({ id: 'classify-repair-verify', planId: 'repair-child', worker: 'reviewer', task: 'classify' })
    mw.buffer.start('classify-repair-verify', 'repair-child')

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

    assert.equal(mw.plans.get('repair-child')?.status, 'failed')
    assert.equal(mw.buffer.get('classify-repair-verify', 'repair-child')?.status, 'cancelled')
    assert.equal(result.status, 'dry_run')
    assert.equal(result.plan?.goal, 'demo slice')
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

test('completed repair does not resume when original plan only has completed failing gates', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-supervisor-'))
  try {
    const mw = createOrchestrationMiddleware({ cwd })
    const productPlan: ActionPlan = {
      goal: 'demo product',
      steps: [
        { id: 'implement-slice', worker: 'shell', mode: 'write', task: 'true', dependsOn: [] },
        { id: 'review-slice', worker: 'shell', mode: 'verify', gate: 'review', task: 'printf FAIL', dependsOn: ['implement-slice'] },
        { id: 'qa-slice', worker: 'shell', mode: 'verify', gate: 'qa', task: 'printf BLOCKED', dependsOn: ['review-slice'] },
        { id: 'release-slice', worker: 'shell', mode: 'verify', gate: 'release', task: 'printf FAIL', dependsOn: ['qa-slice'] },
      ],
    }
    const repairPlan: ActionPlan = {
      goal: 'repair worktree boundary',
      steps: [{ id: 'repair-verify', worker: 'shell', mode: 'verify', task: 'printf PASS', dependsOn: [] }],
    }

    mw.plans.set('plan-product', { plan: productPlan, status: 'failed', createdAt: '2026-05-20T00:00:00.000Z', schedulerLock: false })
    for (const step of productPlan.steps) {
      mw.buffer.submit({ id: step.id, planId: 'plan-product', worker: step.worker, task: step.task })
      mw.buffer.start(step.id, 'plan-product')
      mw.buffer.complete(step.id, step.id === 'review-slice' ? 'FAIL' : step.id === 'qa-slice' ? 'BLOCKED' : step.id === 'release-slice' ? 'FAIL' : 'done', 'plan-product')
    }
    mw.buffer.submit({ id: 'worktree-boundary', planId: 'plan-product', worker: 'scheduler', task: 'boundary check' })
    mw.buffer.start('worktree-boundary', 'plan-product')
    mw.buffer.fail('worktree-boundary', 'Plan wrote outside isolated worktree', 'plan-product')

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

    const status = mw.objectiveStatus()
    assert.equal(status.blockedReason, 'review gate fail')
    assert.equal(status.lifecyclePhase, 'completed')

    const decision = mw.supervisorDecision()
    assert.notEqual(decision.action, 'resume_downstream')
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
