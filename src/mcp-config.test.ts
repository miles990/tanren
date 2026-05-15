import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadMcpServersFromConfig } from './mcp-config.js'

describe('MCP config loader', () => {
  it('normalizes stdio server config and tool names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-mcp-'))
    try {
      const path = join(dir, 'mcp.json')
      writeFileSync(path, JSON.stringify({
        mcpServers: {
          kuro: { command: 'node', args: ['server.js'], cwd: dir, env: { A: '1' } },
        },
      }))
      const result = loadMcpServersFromConfig({ path, agentTools: ['agent_chat'] })
      assert.equal(result.loaded, true)
      assert.deepEqual(result.serverNames, ['kuro'])
      assert.deepEqual(result.mcpToolNames, ['mcp__kuro__agent_chat'])
      assert.deepEqual(result.mcpServers?.kuro, { type: 'stdio', command: 'node', args: [join(dir, 'server.js')], cwd: dir, env: { A: '1' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
