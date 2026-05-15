import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadDotEnvFile, readUsageSummary } from './env.js'

describe('env helpers', () => {
  it('loads dotenv values without overriding existing env by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-env-'))
    try {
      const path = join(dir, '.env')
      writeFileSync(path, 'A=1\nB="two"\n')
      const env = { B: 'existing' } as NodeJS.ProcessEnv
      const loaded = loadDotEnvFile({ path, env })
      assert.equal(env.A, '1')
      assert.equal(env.B, 'existing')
      assert.deepEqual(loaded, { A: '1' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads usage summary best effort', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-usage-'))
    try {
      writeFileSync(join(dir, 'llm-usage-summary.json'), '{"tokens":12}')
      assert.deepEqual(readUsageSummary(dir), { tokens: 12 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
