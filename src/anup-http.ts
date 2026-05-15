import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ArtifactController, PolicyEventController } from './artifact-controller.js'
import type { ArtifactProviderSelection } from './artifact-types.js'
import {
  FileAgentUIStore,
  buildAnupOverview,
  createAgentUIEnvelope,
  createDemoAnupEnvelope,
  longTaskToAnupEnvelope,
  type AgentUIBlock,
  type AgentUIEnvelope,
  type HumanAction,
} from './anup.js'
import type { LongTaskController } from './long-task.js'

export interface AnupHttpOptions {
  memoryDir: string
  serviceName?: string
  longTasks?: LongTaskController
  artifacts?: ArtifactProviderSelection
  capabilities?: unknown
}

export async function handleAnupHttpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: AnupHttpOptions,
): Promise<boolean> {
  const store = new FileAgentUIStore(join(opts.memoryDir, 'state', 'anup'))
  const agentId = opts.serviceName ?? 'tanren'

  if (url.pathname === '/demo/anup' && req.method === 'POST') {
    const run = createDemoAnupEnvelope(agentId)
    store.put(run)
    store.appendEvent({ event: 'run.started', run_id: run.run_id, timestamp: run.timestamp })
    json(res, 201, run)
    return true
  }

  if (url.pathname === '/anup/overview' && req.method === 'GET') {
    try {
      const artifactController = new ArtifactController({ artifacts: opts.artifacts, memoryDir: opts.memoryDir })
      const policyController = new PolicyEventController(join(opts.memoryDir, 'state'))
      const run = buildAnupOverview({
        agentId,
        tasks: opts.longTasks?.list({ limit: parseInt(url.searchParams.get('taskLimit') ?? '20', 10) }) ?? [],
        artifacts: await artifactController.list({ provider: url.searchParams.get('provider') ?? undefined }),
        policyEvents: policyController.list({ limit: parseInt(url.searchParams.get('policyLimit') ?? '50', 10) }),
        capabilities: opts.capabilities,
      })
      json(res, 200, run)
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/anup\/tasks\/[^/]+$/) && req.method === 'GET') {
    const taskId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    const task = opts.longTasks?.get(taskId)
    if (!task || !opts.longTasks) {
      json(res, 404, { error: 'task not found' })
      return true
    }
    json(res, 200, longTaskToAnupEnvelope(task, opts.longTasks.events(taskId, 200), {
      agentId,
      result: opts.longTasks.result(taskId),
    }))
    return true
  }

  if (url.pathname === '/anup/runs' && req.method === 'GET') {
    json(res, 200, { runs: store.list(parseInt(url.searchParams.get('limit') ?? '50', 10)) })
    return true
  }

  if (url.pathname === '/anup/runs' && req.method === 'POST') {
    try {
      const body = await readJsonBody<Partial<AgentUIEnvelope> & { blocks?: AgentUIBlock[] }>(req)
      const run = createAgentUIEnvelope({
        runId: body.run_id,
        agentId: body.agent_id ?? agentId,
        blocks: body.blocks ?? [],
        metadata: body.metadata,
      })
      store.put(run)
      store.appendEvent({ event: 'run.started', run_id: run.run_id, timestamp: run.timestamp })
      json(res, 201, run)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/anup\/runs\/[^/]+$/) && req.method === 'GET') {
    const runId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    const stored = store.get(runId)
    if (!stored) json(res, 404, { error: 'ANUP run not found' })
    else json(res, 200, stored)
    return true
  }

  if (url.pathname.match(/^\/anup\/runs\/[^/]+\/blocks$/) && req.method === 'POST') {
    try {
      const runId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      const body = await readJsonBody<{ block: AgentUIBlock }>(req)
      json(res, 200, store.appendBlock(runId, body.block))
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/anup\/runs\/[^/]+\/actions$/) && req.method === 'POST') {
    try {
      const runId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      if (!store.get(runId)) {
        json(res, 404, { error: 'ANUP run not found' })
        return true
      }
      const body = await readJsonBody<Partial<HumanAction>>(req)
      const action: HumanAction = {
        type: 'human_action',
        run_id: runId,
        source_block_id: String(body.source_block_id ?? ''),
        action_id: String(body.action_id ?? ''),
        payload: body.payload,
        timestamp: new Date().toISOString(),
      }
      if (!action.source_block_id || !action.action_id) throw new Error('source_block_id and action_id are required')
      store.appendHumanAction(action)
      json(res, 202, { action })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname === '/anup/approvals' && req.method === 'GET') {
    json(res, 200, { approvals: store.pendingApprovals() })
    return true
  }

  return false
}

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const readJsonBody = async <T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body) as T
}
