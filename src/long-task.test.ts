import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileLongTaskStore, LongTaskController } from './long-task.js'

test('LongTaskController persists checkpoints and resumes from completed steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tanren-long-task-'))
  const controller = new LongTaskController({ memoryDir: dir, cwd: dir })
  const task = controller.create({
    start: false,
    goal: 'test shell plan',
    plan: {
      goal: 'test shell plan',
      steps: [
        { id: 'first', worker: 'shell', task: 'printf first', dependsOn: [] },
        { id: 'second', worker: 'shell', task: 'printf second after {{first.result}}', dependsOn: ['first'] },
      ],
    },
  })

  await controller.start(task.id)

  const completed = controller.get(task.id)
  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.checkpointCount, 2)
  assert.match(controller.result(task.id) ?? '', /first/)

  controller.resume(task.id)
  for (let i = 0; i < 20 && controller.get(task.id)?.status !== 'completed'; i++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(controller.get(task.id)?.status, 'completed')
})

test('FileLongTaskStore lists records and events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tanren-long-task-store-'))
  const store = new FileLongTaskStore(dir)
  const task = store.create({
    kind: 'generic',
    goal: 'persist me',
    plan: { goal: 'persist me', steps: [] },
  })

  store.appendEvent(task.id, 'custom.event', { ok: true })

  assert.equal(store.get(task.id)?.goal, 'persist me')
  assert.equal(store.list().length, 1)
  assert.equal(store.listEvents(task.id).at(-1)?.type, 'custom.event')
})
