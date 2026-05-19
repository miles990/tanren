import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PlanEventLog } from './plan-events.js'

test('PlanEventLog replays plan state from append-only events', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-events-'))
  try {
    const log = new PlanEventLog(cwd)
    log.append({
      type: 'plan.created',
      planId: 'plan-a',
      plan: { goal: 'A', steps: [] },
    })
    log.append({ type: 'plan.started', planId: 'plan-a', attempt: 0 })
    log.append({ type: 'plan.completed', planId: 'plan-a', status: 'completed' })

    const replayed = log.replay()
    assert.equal(replayed.get('plan-a')?.plan.goal, 'A')
    assert.equal(replayed.get('plan-a')?.status, 'completed')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

