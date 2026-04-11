/**
 * Tanren — Context Mode Detection Tests
 *
 * Verifies mode classification correctness, especially edge cases
 * that caused misclassification before the robustness fix.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectContextMode } from './context-modes.js'

describe('detectContextMode', () => {
  // === Interaction mode ===

  it('classifies greetings as interaction', () => {
    assert.equal(detectContextMode('hi').mode, 'interaction')
    assert.equal(detectContextMode('hello there').mode, 'interaction')
    assert.equal(detectContextMode('hey').mode, 'interaction')
    assert.equal(detectContextMode('good morning').mode, 'interaction')
  })

  it('classifies short messages without signals as interaction', () => {
    assert.equal(detectContextMode('ok').mode, 'interaction')
    assert.equal(detectContextMode('thanks').mode, 'interaction')
    assert.equal(detectContextMode('got it').mode, 'interaction')
  })

  // === Execution mode ===

  it('classifies direct commands as execution', () => {
    assert.equal(detectContextMode('fix the login bug in auth.ts').mode, 'execution')
    assert.equal(detectContextMode('create a new user model').mode, 'execution')
    assert.equal(detectContextMode('delete the old migration files').mode, 'execution')
    assert.equal(detectContextMode('deploy to production').mode, 'execution')
  })

  it('classifies Chinese commands as execution', () => {
    // CJK characters don't match \b in regex — patterns must not use \b for CJK
    // Also need enough length (>50 chars) to avoid short-message filter
    assert.equal(detectContextMode('修改 loop.ts 的 tick 函式，把 feedback loop 的邏輯抽出到獨立模組').mode, 'execution')
    assert.equal(detectContextMode('幫我實作一個新的 gate 系統來偵測重複的 action pattern，放在 gates 目錄').mode, 'execution')
  })

  // === Research mode ===

  it('classifies analysis requests as research', () => {
    assert.equal(detectContextMode('analyze the performance bottleneck in the loop module and explain the root cause').mode, 'research')
    assert.equal(detectContextMode('explain how the gate system works in detail and compare it with other approaches').mode, 'research')
    assert.equal(detectContextMode('why does the context mode detection fail on certain edge cases in the framework?').mode, 'research')
  })

  it('classifies questions as research (not execution)', () => {
    assert.equal(detectContextMode('how does the feedback loop handle idle rounds?').mode, 'research')
    assert.equal(detectContextMode('what happens when two agents share memory?').mode, 'research')
  })

  // === Verification mode ===

  it('classifies verification requests as verification', () => {
    assert.equal(detectContextMode('verify that the edit was applied correctly').mode, 'verification')
    assert.equal(detectContextMode('did you mentioned this earlier?').mode, 'verification')
    assert.equal(detectContextMode('confirm the fix is correct').mode, 'verification')
  })

  // === Robustness: negative patterns prevent misclassification ===

  it('does NOT classify "write me a poem" as execution', () => {
    const mode = detectContextMode('write me a poem about verification')
    assert.notEqual(mode.mode, 'execution',
      '"write me a poem" should not be execution — negative pattern should cancel first-word match')
  })

  it('does NOT classify "create a summary of" as execution', () => {
    const mode = detectContextMode('create a summary of the recent changes')
    assert.notEqual(mode.mode, 'execution',
      '"create a summary" should not be execution — it is a content generation request')
  })

  it('does NOT classify questions ending with ? as execution', () => {
    const mode = detectContextMode('can you write this differently?')
    assert.notEqual(mode.mode, 'execution',
      'questions should never be execution mode')
  })

  // === Confidence gap: ambiguous messages default to research ===

  it('falls back to research for ambiguous long messages', () => {
    const mode = detectContextMode(
      'I need to understand the architecture before making changes to the deployment pipeline'
    )
    // This could be research or execution — ambiguous should prefer research
    assert.equal(mode.mode, 'research')
  })

  // === Empty / edge cases ===

  it('handles empty string as interaction', () => {
    assert.equal(detectContextMode('').mode, 'interaction')
  })

  it('handles very long messages', () => {
    const longMsg = 'analyze '.repeat(100) + 'the entire codebase architecture'
    const mode = detectContextMode(longMsg)
    assert.equal(mode.mode, 'research')
  })
})
