import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createPeerBridge } from './peer-bridge.js'

describe('peer bridge', () => {
  it('writes inbound chat and applies thought fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-peer-'))
    try {
      const bridge = createPeerBridge({ messagesDir: dir, peerName: 'kuro' })
      bridge.onBeforeChat('Alex', 'hello')
      assert.match(readFileSync(join(dir, 'from-kuro.md'), 'utf-8'), /hello/)
      const applied = bridge.applyWriteBackFallback({
        perception: '',
        thought: 'x'.repeat(250),
        actions: [],
        observation: { outputExists: false, outputQuality: 0, confidenceCalibration: 0, actionsExecuted: 0, actionsFailed: 0, duration: 0 },
        timestamp: Date.now(),
        gateResults: [],
      })
      assert.equal(applied, true)
      assert.equal(existsSync(join(dir, 'to-kuro.md')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
