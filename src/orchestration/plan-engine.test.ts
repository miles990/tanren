import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PlanEngine, type ActionPlan } from './plan-engine.js'

function gitInit(cwd: string) {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
}

test('PlanEngine fails a step that changes files outside artifactContract.allowedPaths', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tanren-plan-'))
  try {
    gitInit(cwd)
    mkdirSync(join(cwd, 'allowed'), { recursive: true })
    const engine = new PlanEngine(async () => {
      writeFileSync(join(cwd, 'outside.txt'), 'not allowed', 'utf-8')
      return 'wrote outside file'
    }, { cwd })

    const plan: ActionPlan = {
      goal: 'artifact guard',
      steps: [{
        id: 'write',
        worker: 'writer',
        task: 'write',
        dependsOn: [],
        artifactContract: { allowedPaths: ['allowed'] },
      }],
    }

    const result = await engine.execute(plan)
    assert.equal(result.summary.failed, 1)
    assert.match(result.steps[0].output, /ARTIFACT CONTRACT FAILED/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

