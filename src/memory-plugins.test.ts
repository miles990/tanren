import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createInboxPlugin, createOutboxHistoryPlugin, createPeerMessageActions, createPeerMessagePlugin } from './memory-plugins.js'

describe('memory plugins', () => {
  it('reads inbox and outbox history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-memory-plugins-'))
    try {
      const inbox = join(dir, 'inbox')
      const outbox = join(dir, 'outbox')
      mkdirSync(inbox)
      mkdirSync(outbox)
      writeFileSync(join(inbox, 'task.md'), 'do work')
      writeFileSync(join(outbox, 'brief.md'), 'done work')
      assert.match(await createInboxPlugin({ inboxDir: inbox }).fn(), /do work/)
      assert.match(await createOutboxHistoryPlugin({ outboxDir: outbox }).fn(), /done work/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads and writes peer messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-peer-'))
    try {
      writeFileSync(join(dir, 'from-kuro.md'), 'hello')
      assert.match(await createPeerMessagePlugin({ messagesDir: dir, peerName: 'kuro' }).fn(), /hello/)
      const [respond, clear] = createPeerMessageActions({ messagesDir: dir, peerName: 'kuro' })
      await respond.execute({ type: 'respond', content: '', raw: '', input: { content: 'hi' } }, {} as never)
      assert.equal(readFileSync(join(dir, 'to-kuro.md'), 'utf-8'), 'hi')
      await clear.execute({ type: 'clear-inbox', content: '', raw: '' }, {} as never)
      assert.equal(readFileSync(join(dir, 'from-kuro.md'), 'utf-8'), '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
