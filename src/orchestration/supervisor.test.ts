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
  }, new Set(['gameplay-engineer', 'qa-reality-checker', 'reviewer']))

  assert.equal(plan.steps.length, 4)
  assert.equal(plan.steps[0].worker, 'gameplay-engineer')
  assert.equal(plan.steps[0].mode, 'write')
  assert.deepEqual(plan.steps[0].artifactContract?.allowedPaths, ['game'])
  assert.equal(plan.steps[1].gate, 'review')
  assert.equal(plan.steps[2].worker, 'qa-reality-checker')
  assert.equal(plan.steps[2].gate, 'qa')
  assert.equal(plan.steps[3].gate, 'release')
})

test('selectSmallestProductSliceWorkers keeps support workers dynamic and optional', () => {
  const selected = selectSmallestProductSliceWorkers({}, new Set(['coder', 'reviewer', 'game-designer']))
  assert.equal(selected.implementationWorker, 'coder')
  assert.equal(selected.reviewWorker, 'reviewer')
  assert.deepEqual(selected.supportWorkers, ['game-designer'])
})
