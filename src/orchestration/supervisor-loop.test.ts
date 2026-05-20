import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSupervisorLoopResult, runSupervisorLoop } from './supervisor-loop.js'
import type { SupervisorTickResult } from './supervisor.js'

test('runSupervisorLoop submits ticks until maxTicks', async () => {
  const results: SupervisorTickResult[] = [
    { action: 'wait', decision: { action: 'wait', failureType: 'none', reason: 'busy', requiresBoss: false }, status: 'no_action' },
    { action: 'start_smallest_product_slice', decision: { action: 'start_smallest_product_slice', failureType: 'none', reason: 'idle', requiresBoss: false }, status: 'executing', submittedPlanId: 'plan-1' },
  ]
  let index = 0
  const summary = await runSupervisorLoop({
    pollMs: 0,
    maxTicks: 2,
    tick: async () => results[index++],
  })

  assert.equal(summary.ticks, 2)
  assert.deepEqual(summary.submittedPlans, ['plan-1'])
  assert.equal(summary.stoppedReason, 'max_ticks')
})

test('runSupervisorLoop can stop after submitting a plan', async () => {
  let ticks = 0
  const summary = await runSupervisorLoop({
    pollMs: 0,
    maxTicks: 10,
    stopOnSubmitted: true,
    tick: async () => {
      ticks += 1
      return {
        action: 'start_smallest_product_slice',
        decision: { action: 'start_smallest_product_slice', failureType: 'none', reason: 'idle', requiresBoss: false },
        status: 'executing',
        submittedPlanId: 'plan-2',
      }
    },
  })

  assert.equal(ticks, 1)
  assert.equal(summary.stoppedReason, 'submitted')
  assert.deepEqual(summary.submittedPlans, ['plan-2'])
})

test('formatSupervisorLoopResult includes action, status, and submitted plan', () => {
  const line = formatSupervisorLoopResult(3, {
    action: 'start_smallest_product_slice',
    decision: { action: 'start_smallest_product_slice', failureType: 'verification', reason: 'repair loop', requiresBoss: false },
    status: 'executing',
    submittedPlanId: 'plan-x',
  })

  assert.match(line, /tick=3/)
  assert.match(line, /action=start_smallest_product_slice/)
  assert.match(line, /submitted=plan-x/)
})
