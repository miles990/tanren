/**
 * Tanren — Working Memory Tests
 *
 * Verifies time-based decay, anchor behavior, and backward compatibility.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkingMemory } from './working-memory.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Working Memory', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tanren-wm-'))
    filePath = join(tmpDir, 'working-memory.json')
  })

  describe('time-based decay', () => {
    it('decays normal insights faster than anchored insights', () => {
      const wm = createWorkingMemory(filePath)
      wm.load()
      const state = wm.getState()

      const now = Date.now()
      // Add insights with known timestamps
      state.recentInsights = [
        { content: 'normal insight', tick: 1, relevance: 1.0, createdAt: now - 15 * 60 * 1000 },   // 15 min ago
        { content: 'anchored insight', tick: 1, relevance: 1.0, anchor: true, createdAt: now - 15 * 60 * 1000 },  // 15 min ago
      ]
      state.lastUpdated = 1

      wm.decay(2, now)

      const normal = state.recentInsights.find(i => i.content === 'normal insight')
      const anchored = state.recentInsights.find(i => i.content === 'anchored insight')

      assert.ok(normal, 'normal insight should still exist')
      assert.ok(anchored, 'anchored insight should still exist')

      // Normal: half-life 15min, so at 15min should be ~0.5
      assert.ok(normal.relevance < 0.6, `normal relevance ${normal.relevance} should be < 0.6 at half-life`)
      assert.ok(normal.relevance > 0.4, `normal relevance ${normal.relevance} should be > 0.4 at half-life`)

      // Anchored: half-life 60min, so at 15min should be ~0.84
      assert.ok(anchored.relevance > 0.7, `anchored relevance ${anchored.relevance} should be > 0.7 at 15min`)
    })

    it('removes insights below minimum relevance', () => {
      const wm = createWorkingMemory(filePath)
      wm.load()
      const state = wm.getState()

      const now = Date.now()
      state.recentInsights = [
        { content: 'very old', tick: 1, relevance: 1.0, createdAt: now - 120 * 60 * 1000 },  // 2 hours ago
      ]

      wm.decay(2, now)

      // 2 hours with 15min half-life = 0.5^8 ≈ 0.004 — well below 0.2 threshold
      assert.equal(state.recentInsights.length, 0, 'very old insight should be removed')
    })

    it('preserves fresh insights', () => {
      const wm = createWorkingMemory(filePath)
      wm.load()
      const state = wm.getState()

      const now = Date.now()
      state.recentInsights = [
        { content: 'just added', tick: 1, relevance: 1.0, createdAt: now - 1000 },  // 1 second ago
      ]

      wm.decay(2, now)

      assert.equal(state.recentInsights.length, 1)
      assert.ok(state.recentInsights[0].relevance > 0.99, 'fresh insight should have nearly full relevance')
    })
  })

  describe('legacy tick-based fallback', () => {
    it('uses tick-based decay when createdAt is missing', () => {
      const wm = createWorkingMemory(filePath)
      wm.load()
      const state = wm.getState()

      state.recentInsights = [
        { content: 'legacy insight', tick: 1, relevance: 1.0 },  // no createdAt
      ]

      wm.decay(2)

      // Should use tick-based decay: 1.0 * 0.85 = 0.85
      assert.ok(state.recentInsights[0].relevance < 0.9, 'should use tick-based fallback')
      assert.ok(state.recentInsights[0].relevance > 0.8, 'should use tick-based fallback (0.85)')
    })
  })

  describe('update adds createdAt', () => {
    it('new insights get createdAt timestamp', () => {
      const wm = createWorkingMemory(filePath)
      wm.load()
      // Clear any state from prior tests (EMPTY_STATE may be mutated — known issue)
      wm.getState().recentInsights = []

      const before = Date.now()
      wm.update(1, { insight: 'test insight' })
      const after = Date.now()

      const state = wm.getState()
      const insight = state.recentInsights.find(i => i.content === 'test insight')
      assert.ok(insight, 'insight should exist')
      assert.ok(insight.createdAt, 'should have createdAt')
      assert.ok(insight.createdAt! >= before)
      assert.ok(insight.createdAt! <= after)
    })
  })

  // Cleanup
  it('cleanup', () => {
    try { rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
  })
})
