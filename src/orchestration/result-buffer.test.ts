import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ResultBuffer } from './result-buffer.js'

test('ResultBuffer keys plan tasks by planId and step id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tanren-buffer-'))
  try {
    const buffer = new ResultBuffer()
    buffer.enablePersistence(dir)

    buffer.submit({ id: 'shared-step', planId: 'plan-a', worker: 'shell', task: 'a' })
    buffer.submit({ id: 'shared-step', planId: 'plan-b', worker: 'shell', task: 'b' })
    buffer.start('shared-step', 'plan-a')
    buffer.complete('shared-step', 'done-a', 'plan-a')

    assert.equal(buffer.get('shared-step', 'plan-a')?.status, 'completed')
    assert.equal(buffer.get('shared-step', 'plan-b')?.status, 'pending')
    assert.equal(buffer.list({ planId: 'plan-a' }).length, 1)
    assert.equal(buffer.list({ planId: 'plan-b' }).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

