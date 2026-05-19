import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RepoSchedulerLock, SchedulerLockError } from './scheduler-lock.js'

test('RepoSchedulerLock atomically rejects a second active objective', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-lock-'))
  try {
    const lock = new RepoSchedulerLock(cwd)
    const first = lock.acquire({ planId: 'plan-a', goal: 'A' })
    assert.throws(() => lock.acquire({ planId: 'plan-b', goal: 'B' }), SchedulerLockError)
    first.release()
    const second = lock.acquire({ planId: 'plan-b', goal: 'B' })
    second.release()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

