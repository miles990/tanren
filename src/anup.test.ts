import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertAgentUIBlock,
  artifactJobToAnupBlocks,
  buildAnupOverview,
  chatResultToAnupEnvelope,
  createAgentUIEnvelope,
  createAnupApprovalGuard,
  createDemoAnupEnvelope,
  FileAgentUIStore,
  longTaskToAnupEnvelope,
  type AgentUIBlock,
} from './anup.js'
import type { ArtifactJob } from './artifact-types.js'
import type { LongTaskRecord } from './long-task.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ANUP', () => {
  it('validates the white-listed block vocabulary', () => {
    assert.doesNotThrow(() => assertAgentUIBlock({
      type: 'media_ref',
      id: 'media-1',
      title: 'Input image',
      source: 'input',
      kind: 'image',
      media_type: 'image/png',
      uri: 'data:image/png;base64,abc',
    }))

    assert.throws(() => assertAgentUIBlock({
      type: 'raw_html',
      id: 'unsafe',
      html: '<script>alert(1)</script>',
    } as unknown as AgentUIBlock), /Unsupported ANUP block type/)
  })

  it('projects long tasks into task, state, trace, and result blocks', () => {
    const task: LongTaskRecord = {
      id: 'task-1',
      kind: 'generic',
      goal: 'Build a workbench',
      acceptance: 'ANUP blocks are visible',
      plan: {
        goal: 'Build a workbench',
        acceptance: 'ANUP blocks are visible',
        steps: [
          { id: 'step-1', worker: 'architect', task: 'Define schema', dependsOn: [] },
          { id: 'step-2', worker: 'coder', task: 'Implement API', dependsOn: ['step-1'] },
        ],
      },
      status: 'running',
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:01:00.000Z',
      checkpointCount: 1,
    }

    const envelope = longTaskToAnupEnvelope(task, [
      { timestamp: '2026-05-15T00:00:00.000Z', taskId: task.id, type: 'task.created', data: { goal: task.goal } },
    ], { result: '# Result' })

    assert.equal(envelope.protocol, 'anup')
    assert.equal(envelope.run_id, 'task:task-1')
    assert.ok(envelope.blocks.some(block => block.type === 'task_contract'))
    assert.ok(envelope.blocks.some(block => block.type === 'agent_state'))
    assert.ok(envelope.blocks.some(block => block.type === 'tool_trace'))
    assert.ok(envelope.blocks.some(block => block.type === 'artifact'))
  })

  it('projects artifact jobs into artifact and media_ref blocks', () => {
    const job: ArtifactJob = {
      id: 'job-1',
      provider: 'openai',
      status: 'completed',
      request: { type: 'image', prompt: 'draw' },
      artifacts: [{ id: 'img-1', uri: '/tmp/out.png', kind: 'image', mediaType: 'image/png' }],
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:01:00.000Z',
    }
    const blocks = artifactJobToAnupBlocks(job)

    assert.equal(blocks[0]?.type, 'artifact')
    assert.equal(blocks[1]?.type, 'media_ref')
    assert.equal(blocks[1]?.uri, '/artifacts/job-1/file?index=0')
  })

  it('builds an overview envelope from runtime projections', () => {
    const envelope = buildAnupOverview({
      agentId: 'akari',
      capabilities: { llm: { provider: 'agent-sdk', input: { image: false } } },
      policyEvents: [{ timestamp: '2026-05-15T00:00:00.000Z', domain: 'artifact', provider: 'openai', allowed: false, reason: 'disabled' }],
    })

    assert.equal(envelope.run_id, 'overview')
    assert.ok(envelope.blocks.some(block => block.type === 'agent_state'))
    assert.ok(envelope.blocks.some(block => block.type === 'context_summary'))
    assert.ok(envelope.blocks.some(block => block.type === 'constraint_panel'))
  })

  it('creates persisted run envelopes for explicit agent UI output', () => {
    const envelope = createAgentUIEnvelope({
      agentId: 'akari',
      blocks: [{
        type: 'task_contract',
        id: 'task',
        title: 'Task',
        goal: 'Goal',
        inputs: ['user'],
        success_criteria: ['done'],
        constraints: ['no raw html'],
      }],
    })

    assert.equal(envelope.protocol, 'anup')
    assert.equal(envelope.blocks.length, 1)
  })

  it('projects chat results into response artifacts and high-risk approvals', () => {
    const envelope = chatResultToAnupEnvelope({
      agentId: 'akari',
      from: 'web',
      text: 'run a command',
      result: {
        response: 'done',
        thought: 'hidden',
        actions: ['respond', 'shell'],
        duration: 25,
        quality: 3,
        meta: { mode: 'execution', filesRead: [], filesWritten: [], toolsUsed: ['shell'], hypotheses: 0, contextChars: 10 },
      },
    })

    assert.ok(envelope.blocks.some(block => block.type === 'artifact'))
    assert.ok(envelope.blocks.some(block => block.type === 'approval_request'))
  })

  it('creates demo runs with decision, approval, trace, and media blocks', () => {
    const envelope = createDemoAnupEnvelope('akari')
    assert.ok(envelope.blocks.some(block => block.type === 'decision_card'))
    assert.ok(envelope.blocks.some(block => block.type === 'approval_request'))
    assert.ok(envelope.blocks.some(block => block.type === 'tool_trace'))
    assert.ok(envelope.blocks.some(block => block.type === 'media_ref'))
  })

  it('creates approval runs when high-risk actions are checked before execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-anup-approval-'))
    try {
      const store = new FileAgentUIStore(dir)
      const guard = createAnupApprovalGuard({ store, agentId: 'akari' })
      const decision = await guard.check(
        { type: 'shell', content: 'rm -rf tmp', raw: '<action:shell>rm -rf tmp</action:shell>' },
        {
          memory: {} as never,
          workDir: '.',
          filesRead: new Set<string>(),
        },
      )
      assert.equal(decision.approved, false)
      assert.match(decision.reason, /approval/)
      assert.equal(store.list().length, 1)
      assert.ok(store.list()[0]?.blocks.some(block => block.type === 'approval_request'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows a high-risk action after a matching approval response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-anup-approval-'))
    try {
      const store = new FileAgentUIStore(dir)
      const guard = createAnupApprovalGuard({ store, agentId: 'akari' })
      const action = { type: 'shell', content: 'pnpm test', raw: '<action:shell>pnpm test</action:shell>' }
      const first = await guard.check(action, {
        memory: {} as never,
        workDir: '.',
        filesRead: new Set<string>(),
      })
      assert.equal(first.approved, false)
      const run = store.list()[0]
      const block = run?.blocks.find(candidate => candidate.type === 'approval_request')
      assert.ok(run)
      assert.ok(block)
      store.appendHumanAction({
        type: 'human_action',
        run_id: run.run_id,
        source_block_id: block.id,
        action_id: 'approve',
        timestamp: new Date().toISOString(),
      })

      const second = await guard.check(action, {
        memory: {} as never,
        workDir: '.',
        filesRead: new Set<string>(),
      })
      assert.equal(second.approved, true)
      assert.equal(second.approvalId, run.run_id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
