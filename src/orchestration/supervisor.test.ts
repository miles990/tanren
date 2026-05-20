import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSmallestProductSlicePlan, classifySupervisorFailure, evaluateSupervisor, selectSmallestProductSliceWorkers, type SupervisorInput } from './supervisor.js'

const baseInput = (overrides: Partial<SupervisorInput> = {}): SupervisorInput => ({
  objective: {
    currentObjective: { planId: 'plan-a', goal: 'demo', status: 'failed' },
    activePlans: [],
    blockedReason: 'blocking step repair-verify failed',
    repairAttempt: 3,
    mergeReady: false,
    nextMergeGate: null,
  },
  plans: [{
    planId: 'plan-a',
    goal: 'demo',
    status: 'failed',
    steps: [
      { id: 'repair-verify', worker: 'qa', status: 'failed', output: 'Claude Code returned an error result: Reached maximum number of turns (12)' },
    ],
  }],
  ...overrides,
})

test('classifySupervisorFailure separates execution failures', () => {
  assert.equal(classifySupervisorFailure('API Error: The socket connection was closed unexpectedly'), 'transient')
  assert.equal(classifySupervisorFailure('Reached maximum number of turns'), 'max_turns')
  assert.equal(classifySupervisorFailure('Plan wrote outside isolated worktree'), 'workspace')
})

test('supervisor waits while an active plan is executing', () => {
  const result = evaluateSupervisor(baseInput({
    objective: {
      currentObjective: { planId: 'plan-a', goal: 'demo', status: 'executing' },
      activePlans: [{ planId: 'plan-a', status: 'executing' }],
      blockedReason: null,
      repairAttempt: 0,
      mergeReady: false,
      nextMergeGate: null,
    },
  }))
  assert.equal(result.action, 'wait')
})

test('supervisor resumes downstream when a repair plan completed', () => {
  const result = evaluateSupervisor(baseInput({
    objective: {
      currentObjective: { planId: 'repair-a', goal: 'repair demo', status: 'completed', repairOf: 'plan-a' },
      activePlans: [],
      blockedReason: 'repair repair-a completed; original plan plan-a needs downstream resume',
      repairAttempt: 1,
      mergeReady: false,
      nextMergeGate: { gate: 'review', status: 'pending', verdict: 'unknown' },
    },
    plans: [
      {
        planId: 'plan-a',
        goal: 'demo',
        status: 'failed',
        steps: [
          { id: 'implement-slice', worker: 'gameplay-engineer', status: 'failed', output: 'Reached maximum number of turns' },
          { id: 'review-slice', worker: 'reviewer', status: 'pending', gate: 'review' },
        ],
      },
      {
        planId: 'repair-a',
        goal: 'repair demo',
        status: 'completed',
        repairOf: 'plan-a',
        repairAttempt: 1,
        steps: [{ id: 'repair-verify', worker: 'qa', status: 'completed', output: 'PASS' }],
      },
    ],
  }))
  assert.equal(result.action, 'resume_downstream')
  assert.equal(result.targetPlanId, 'plan-a')
  assert.equal(result.targetStepId, 'repair-a')
})

test('supervisor decomposes max-turn failures', () => {
  const result = evaluateSupervisor(baseInput({ objective: { ...baseInput().objective, repairAttempt: 1 } }))
  assert.equal(result.action, 'decompose_failed_step')
  assert.equal(result.requiresBoss, false)
})

test('supervisor repairs workspace failures before escalation', () => {
  const result = evaluateSupervisor(baseInput({
    objective: { ...baseInput().objective, blockedReason: 'worktree-boundary failed', repairAttempt: 3 },
    plans: [{ planId: 'plan-a', goal: 'demo', status: 'failed', steps: [{ id: 'worktree-boundary', worker: 'scheduler', status: 'failed', output: 'Plan wrote outside isolated worktree' }] }],
  }))
  assert.equal(result.action, 'repair_workspace')
  assert.equal(result.requiresBoss, false)
})

test('supervisor bypasses repair loops with no product progress', () => {
  const result = evaluateSupervisor(baseInput({
    objective: { ...baseInput().objective, blockedReason: 'blocking step repair-verify failed', repairAttempt: 3 },
    plans: [{ planId: 'plan-a', goal: 'demo', status: 'failed', steps: [{ id: 'repair-verify', worker: 'qa', status: 'failed', output: 'Verify failed: test -e docs/report.md' }] }],
  }))
  assert.equal(result.action, 'start_smallest_product_slice')
  assert.equal(result.requiresBoss, false)
})

test('supervisor escalates only strategic failures', () => {
  const result = evaluateSupervisor(baseInput({
    objective: { ...baseInput().objective, blockedReason: 'credential required for external service' },
    plans: [{ planId: 'plan-a', goal: 'demo', status: 'failed', steps: [{ id: 'deploy', worker: 'release', status: 'failed', output: 'credential required' }] }],
  }))
  assert.equal(result.action, 'escalate_boss')
  assert.equal(result.requiresBoss, true)
})

test('buildSmallestProductSlicePlan creates a gated writer contract', () => {
  const plan = buildSmallestProductSlicePlan({
    goal: 'Playable demo slice',
    implementationTask: 'Implement one visible gameplay improvement.',
    allowedPaths: ['game'],
    expectedPaths: ['game/project.godot'],
    verifyCommand: 'test -e game/project.godot',
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer', 'product-owner']))

  assert.equal(plan.steps.length, 5)
  assert.equal(plan.steps[0].worker, 'gameplay-engineer')
  assert.equal(plan.steps[0].mode, 'write')
  assert.deepEqual(plan.steps[0].artifactContract?.allowedPaths, ['game'])
  assert.equal(plan.steps[1].gate, 'review')
  assert.equal(plan.steps[2].worker, 'qa-reality-checker')
  assert.equal(plan.steps[2].gate, 'qa')
  assert.equal(plan.steps[3].gate, 'release')
  assert.equal(plan.steps[4].gate, 'boss-report')
  assert.equal(plan.steps[4].worker, 'product-owner')
  assert.deepEqual(plan.steps[4].artifactContract?.expectedPaths, ['docs/boss-report.md', 'docs/product-brief-current.md', 'docs/roadmap-current.md'])
})

test('buildSmallestProductSlicePlan lets Product Owner own boss communication', () => {
  const plan = buildSmallestProductSlicePlan({
    goal: 'Playable demo slice',
    implementationTask: 'Implement one visible gameplay improvement.',
    allowedPaths: ['game'],
    expectedPaths: ['game/project.godot'],
    verifyCommand: 'test -e game/project.godot',
    bossLiaisonWorker: 'product-owner',
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer', 'product-owner', 'autopilot-producer']))

  const report = plan.steps.find(step => step.id === 'publish-product-status')
  assert.equal(report?.worker, 'product-owner')
  assert.match(String(report?.task), /communication window between the team and the boss/)
})

test('buildSmallestProductSlicePlan includes professional support briefs before implementation', () => {
  const plan = buildSmallestProductSlicePlan({
    goal: 'Playable demo slice',
    implementationTask: 'Implement one visible gameplay improvement.',
    allowedPaths: ['game', 'docs'],
    expectedPaths: ['game/project.godot'],
    verifyCommand: 'test -e game/project.godot',
    supportWorkers: ['game-designer', 'ui-ux-designer'],
    supportWorkerTasks: {
      'game-designer': 'Create docs/support-game-designer-brief.md with card-design acceptance checks.',
    },
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer', 'game-designer', 'ui-ux-designer']))

  assert.equal(plan.steps[0].id, 'support-game-designer')
  assert.equal(plan.steps[0].worker, 'game-designer')
  assert.equal(plan.steps[0].mode, 'report')
  assert.equal(plan.steps[0].blocking, true)
  assert.deepEqual(plan.steps[0].artifactContract?.expectedPaths, ['docs/support-game-designer-brief.md'])
  assert.equal(plan.steps[1].id, 'support-ui-ux-designer')
  assert.deepEqual(plan.steps[2].dependsOn, ['support-game-designer', 'support-ui-ux-designer'])
  assert.match(String(plan.steps[2].task), /discipline briefs/)
})

test('buildSmallestProductSlicePlan supports parallel product lanes before review', () => {
  const plan = buildSmallestProductSlicePlan({
    goal: 'Playable demo slice',
    implementationTask: 'Implement one visible gameplay improvement.',
    allowedPaths: ['game', 'docs'],
    expectedPaths: ['game/project.godot'],
    verifyCommand: 'test -e game/project.godot',
    supportWorkers: ['game-designer'],
    implementationDependsOnSupport: false,
    parallelTracks: [
      {
        id: 'product-plan',
        worker: 'game-director',
        task: 'Create docs/product-slice-plan-current.md.',
        allowedPaths: ['docs'],
        expectedPaths: ['docs/product-slice-plan-current.md'],
        verifyCommand: 'test -e docs/product-slice-plan-current.md',
      },
      {
        id: 'art-direction',
        worker: 'art-director',
        task: 'Create docs/art-direction-current.md.',
        allowedPaths: ['docs'],
        expectedPaths: ['docs/art-direction-current.md'],
        verifyCommand: 'test -e docs/art-direction-current.md',
      },
    ],
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer', 'game-designer', 'game-director', 'art-director']))

  const implementation = plan.steps.find(step => step.id === 'implement-slice')
  const review = plan.steps.find(step => step.id === 'review-slice')
  assert.deepEqual(implementation?.dependsOn, [])
  assert.ok(plan.steps.some(step => step.id === 'parallel-product-plan' && step.worker === 'game-director'))
  assert.ok(plan.steps.some(step => step.id === 'parallel-art-direction' && step.worker === 'art-director'))
  assert.deepEqual(review?.dependsOn, ['implement-slice', 'support-game-designer', 'parallel-product-plan', 'parallel-art-direction'])
})

test('buildSmallestProductSlicePlan can gate review on spec alignment for fast assembly', () => {
  const plan = buildSmallestProductSlicePlan({
    goal: 'Playable demo slice',
    implementationTask: 'Implement one visible gameplay improvement.',
    allowedPaths: ['game', 'docs'],
    expectedPaths: ['game/project.godot'],
    verifyCommand: 'test -e game/project.godot',
    implementationDependsOnSupport: false,
    parallelTracks: [{
      id: 'product-plan',
      worker: 'game-director',
      task: 'Create docs/product-slice-plan-current.md.',
      allowedPaths: ['docs'],
      expectedPaths: ['docs/product-slice-plan-current.md'],
      verifyCommand: 'test -e docs/product-slice-plan-current.md',
    }],
    specAlignment: {
      worker: 'autopilot-producer',
      path: 'docs/spec-alignment-current.md',
    },
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer', 'game-director', 'autopilot-producer']))

  const alignment = plan.steps.find(step => step.id === 'spec-alignment')
  const review = plan.steps.find(step => step.id === 'review-slice')
  assert.deepEqual(alignment?.dependsOn, ['implement-slice', 'parallel-product-plan'])
  assert.deepEqual(alignment?.artifactContract?.expectedPaths, ['docs/spec-alignment-current.md'])
  assert.deepEqual(review?.dependsOn, ['spec-alignment'])
})

test('buildSmallestProductSlicePlan can require a final direction decision before assembly', () => {
  const plan = buildSmallestProductSlicePlan({
    goal: 'Playable demo slice',
    implementationTask: 'Implement one visible gameplay improvement.',
    allowedPaths: ['game', 'docs'],
    expectedPaths: ['game/project.godot'],
    verifyCommand: 'test -e game/project.godot',
    implementationDependsOnSupport: false,
    parallelTracks: [{
      id: 'art-direction',
      worker: 'art-director',
      task: 'Create docs/art-direction-current.md.',
      allowedPaths: ['docs'],
      expectedPaths: ['docs/art-direction-current.md'],
      verifyCommand: 'test -e docs/art-direction-current.md',
    }],
    finalDecision: {
      worker: 'game-director',
      path: 'docs/final-product-decision-current.md',
    },
    specAlignment: {
      worker: 'autopilot-producer',
      path: 'docs/spec-alignment-current.md',
    },
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer', 'game-director', 'art-director', 'autopilot-producer']))

  const decision = plan.steps.find(step => step.id === 'final-product-decision')
  const alignment = plan.steps.find(step => step.id === 'spec-alignment')
  const review = plan.steps.find(step => step.id === 'review-slice')
  assert.equal(decision?.worker, 'game-director')
  assert.deepEqual(decision?.dependsOn, ['implement-slice', 'parallel-art-direction'])
  assert.deepEqual(decision?.artifactContract?.expectedPaths, ['docs/final-product-decision-current.md'])
  assert.deepEqual(alignment?.dependsOn, ['final-product-decision'])
  assert.deepEqual(review?.dependsOn, ['spec-alignment'])
})

test('selectSmallestProductSliceWorkers keeps support workers dynamic and optional', () => {
  const selected = selectSmallestProductSliceWorkers({}, new Set(['coder', 'reviewer', 'game-designer']))
  assert.equal(selected.implementationWorker, 'coder')
  assert.equal(selected.reviewWorker, 'reviewer')
  assert.deepEqual(selected.supportWorkers, ['game-designer'])
})
