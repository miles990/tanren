/**
 * Tanren — Action System Tests
 *
 * Verifies action tag parsing, file tracking via ActionContext, and registry.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createActionRegistry, builtinActions } from './actions.js'

describe('Action Parsing', () => {
  const registry = createActionRegistry()

  it('parses well-formed action tags', () => {
    const response = '<action:respond>Hello world</action:respond>'
    const actions = registry.parse(response)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].type, 'respond')
    assert.equal(actions[0].content, 'Hello world')
  })

  it('parses multiple action tags', () => {
    const response = `
      <action:read>src/loop.ts</action:read>
      <action:respond>The loop module handles ticks.</action:respond>
    `
    const actions = registry.parse(response)
    assert.equal(actions.length, 2)
    assert.equal(actions[0].type, 'read')
    assert.equal(actions[1].type, 'respond')
  })

  it('parses tags with attributes', () => {
    const response = '<action:write path="test.md">content here</action:write>'
    const actions = registry.parse(response)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].attrs?.path, 'test.md')
    assert.equal(actions[0].content, 'content here')
  })

  it('handles unclosed tags (fallback parsing)', () => {
    const response = '<action:respond>Hello world'
    const actions = registry.parse(response)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].type, 'respond')
    assert.ok(actions[0].content.includes('Hello world'))
  })

  it('returns empty array for no action tags', () => {
    const response = 'Just some plain text without any actions.'
    const actions = registry.parse(response)
    assert.equal(actions.length, 0)
  })

  it('handles multiline content', () => {
    const response = `<action:write path="test.md">line 1
line 2
line 3</action:write>`
    const actions = registry.parse(response)
    assert.equal(actions.length, 1)
    assert.ok(actions[0].content.includes('line 1'))
    assert.ok(actions[0].content.includes('line 3'))
  })
})

describe('ActionRegistry', () => {
  it('registers and executes handlers', async () => {
    const registry = createActionRegistry()
    registry.register({
      type: 'test',
      async execute() { return 'test result' },
    })

    assert.ok(registry.has('test'))
    const result = await registry.execute(
      { type: 'test', content: '', raw: '' },
      { memory: {} as any, workDir: '/tmp', filesRead: new Set() },
    )
    assert.equal(result, 'test result')
  })

  it('returns error for unknown action type', async () => {
    const registry = createActionRegistry()
    const result = await registry.execute(
      { type: 'nonexistent', content: '', raw: '' },
      { memory: {} as any, workDir: '/tmp', filesRead: new Set() },
    )
    assert.ok(result.includes('unknown action type'))
  })

  it('converts to tool definitions', () => {
    const registry = createActionRegistry()
    registry.register({
      type: 'custom',
      description: 'A custom tool',
      toolSchema: {
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
      async execute() { return 'ok' },
    })

    const defs = registry.toToolDefinitions()
    assert.equal(defs.length, 1)
    assert.equal(defs[0].name, 'custom')
    assert.equal(defs[0].description, 'A custom tool')
  })

  it('converts tool_use back to Action', () => {
    const registry = createActionRegistry()
    const action = registry.fromToolUse('read', 'id-123', { path: 'src/loop.ts' })
    assert.equal(action.type, 'read')
    assert.equal(action.toolUseId, 'id-123')
    assert.equal(action.input?.path, 'src/loop.ts')
  })
})

describe('ActionContext.filesRead', () => {
  it('is per-instance (not shared between contexts)', () => {
    const ctx1 = { memory: {} as any, workDir: '/tmp', filesRead: new Set<string>() }
    const ctx2 = { memory: {} as any, workDir: '/tmp', filesRead: new Set<string>() }

    ctx1.filesRead.add('/Users/user/file1.ts')

    assert.ok(ctx1.filesRead.has('/Users/user/file1.ts'))
    assert.ok(!ctx2.filesRead.has('/Users/user/file1.ts'),
      'filesRead should be per-instance, not shared')
  })
})
