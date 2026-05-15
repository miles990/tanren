import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

export interface OrchestrationMcpOptions {
  middlewareUrl?: string
  name?: string
  version?: string
}

async function mwFetch(baseUrl: string, path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  })
  return res.json()
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

export function createOrchestrationMcpServer(opts: OrchestrationMcpOptions = {}): McpServer {
  const middlewareUrl = opts.middlewareUrl ?? process.env.MIDDLEWARE_URL ?? 'http://localhost:3100'
  const server = new McpServer(
    { name: opts.name ?? 'tanren-orchestration', version: opts.version ?? '0.3.0' },
    { capabilities: { logging: {}, tools: {} } },
  )

  server.tool(
    'middleware_dispatch',
    'Dispatch a task to a worker. Task may be text or a JSON array of Tanren PromptContentBlock objects for multimodal input.',
    {
      worker: z.string(),
      task: z.union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())),
      ]),
      timeout: z.number().optional(),
    },
    async ({ worker, task, timeout }) => textResult(await mwFetch(middlewareUrl, '/dispatch', {
      method: 'POST',
      body: JSON.stringify({ worker, task, timeout, caller: 'mcp' }),
    })),
  )

  server.tool(
    'middleware_plan',
    'Submit a DAG action plan for parallel execution.',
    {
      goal: z.string(),
      acceptance: z.string().optional(),
      steps: z.array(z.object({
        id: z.string(),
        worker: z.string(),
        task: z.string(),
        label: z.string().optional(),
        dependsOn: z.array(z.string()).default([]),
        retry: z.object({ maxRetries: z.number(), backoffMs: z.number().optional(), onExhausted: z.enum(['skip', 'fail']) }).optional(),
        verifyCommand: z.string().optional(),
      })),
    },
    async args => textResult(await mwFetch(middlewareUrl, '/plan', {
      method: 'POST',
      body: JSON.stringify({ ...args, caller: 'mcp' }),
    })),
  )

  server.tool(
    'middleware_plan_validate',
    'Validate a plan without executing it.',
    {
      goal: z.string(),
      steps: z.array(z.object({
        id: z.string(),
        worker: z.string(),
        task: z.string(),
        dependsOn: z.array(z.string()).default([]),
      })),
    },
    async args => textResult(await mwFetch(middlewareUrl, '/plan/validate', {
      method: 'POST',
      body: JSON.stringify(args),
    })),
  )

  server.tool(
    'middleware_status',
    'Check status of a task or plan.',
    { id: z.string() },
    async ({ id }) => textResult(await mwFetch(middlewareUrl, id.startsWith('plan-') ? `/plan/${id}` : `/status/${id}`)),
  )

  server.tool(
    'middleware_result',
    'Get task result. wait=true polls until complete.',
    { id: z.string(), wait: z.boolean().optional() },
    async ({ id, wait }, extra) => {
      if (!wait) return textResult(await mwFetch(middlewareUrl, `/status/${id}`))
      const start = Date.now()
      let lastStatus = ''
      while (Date.now() - start < 120_000) {
        const task = await mwFetch(middlewareUrl, `/status/${id}`) as Record<string, unknown>
        if (task.status !== lastStatus) {
          lastStatus = String(task.status ?? '')
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: id, progress: lastStatus === 'completed' ? 1 : 0, total: 1, message: `Status: ${lastStatus}` },
            })
          } catch { /* client may not support progress */ }
        }
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout') return textResult(task)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
      return textResult({ error: 'timeout', id })
    },
  )

  server.tool('middleware_workers', 'List workers.', {}, async () => textResult(await mwFetch(middlewareUrl, '/workers')))
  server.tool('middleware_presets', 'List worker presets.', {}, async () => textResult(await mwFetch(middlewareUrl, '/presets')))
  server.tool('middleware_gateway', 'ACP gateway status.', {}, async () => textResult(await mwFetch(middlewareUrl, '/gateway')))
  server.tool('middleware_templates', 'List plan templates.', {}, async () => textResult(await mwFetch(middlewareUrl, '/templates')))

  server.tool(
    'middleware_create_worker',
    'Create a custom worker.',
    {
      name: z.string(),
      description: z.string(),
      prompt: z.string(),
      preset: z.string().optional(),
      tools: z.array(z.string()).optional(),
      model: z.string().optional(),
      backend: z.string().optional(),
      vendor: z.string().optional(),
      timeout: z.number().optional(),
      maxTurns: z.number().optional(),
      webhookUrl: z.string().optional(),
      webhookMethod: z.string().optional(),
      logicFn: z.string().optional(),
    },
    async args => {
      let preset: Record<string, unknown> = {}
      if (args.preset) {
        try {
          const presets = await mwFetch(middlewareUrl, '/presets') as { presets?: Array<Record<string, unknown>> }
          preset = presets.presets?.find(p => p.name === args.preset) ?? {}
        } catch { /* no preset */ }
      }
      return textResult(await mwFetch(middlewareUrl, '/workers', {
        method: 'POST',
        body: JSON.stringify({
          name: args.name,
          description: args.description,
          prompt: args.prompt,
          tools: args.tools ?? preset.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
          model: args.model ?? preset.model ?? 'sonnet',
          backend: args.backend ?? preset.backend ?? 'sdk',
          vendor: args.vendor ?? preset.vendor ?? 'agent-sdk',
          timeout: args.timeout ?? preset.timeout ?? 120,
          maxTurns: args.maxTurns ?? preset.maxTurns ?? 10,
          ...(args.webhookUrl ? { webhook: { url: args.webhookUrl, method: args.webhookMethod ?? 'GET' } } : {}),
          ...(args.logicFn ? { logicFn: args.logicFn } : {}),
        }),
      }))
    },
  )

  server.tool('middleware_delete_worker', 'Delete a custom worker.', { name: z.string() }, async ({ name }) => textResult(await mwFetch(middlewareUrl, `/workers/${name}`, { method: 'DELETE' })))
  server.tool(
    'middleware_create_preset',
    'Create a custom worker preset.',
    {
      name: z.string(),
      description: z.string(),
      tools: z.array(z.string()).optional(),
      model: z.string().optional(),
      vendor: z.string().optional(),
      backend: z.string().optional(),
      timeout: z.number().optional(),
      maxTurns: z.number().optional(),
    },
    async args => textResult(await mwFetch(middlewareUrl, '/presets', { method: 'POST', body: JSON.stringify(args) })),
  )
  server.tool('middleware_delete_preset', 'Delete a custom preset.', { name: z.string() }, async ({ name }) => textResult(await mwFetch(middlewareUrl, `/presets/${name}`, { method: 'DELETE' })))
  server.tool(
    'middleware_plan_from_template',
    'Create and execute a plan from a template.',
    { template: z.string(), params: z.record(z.string(), z.string()) },
    async args => textResult(await mwFetch(middlewareUrl, '/plan/from-template', {
      method: 'POST',
      body: JSON.stringify({ ...args, caller: 'mcp' }),
    })),
  )

  return server
}

export async function startOrchestrationMcpServer(opts: OrchestrationMcpOptions = {}): Promise<void> {
  const server = createOrchestrationMcpServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[mcp] ${opts.name ?? 'Tanren orchestration'} running (stdio)`)
}
