/**
 * Tanren — Worker Runtime
 *
 * Pure worker execution module with no HTTP dependency. Apps can expose it via
 * Hono, MCP, CLI, or any other transport.
 */

import { execSync } from 'node:child_process'
import type { LLMProvider, PromptContentBlock } from '../types.js'
import { promptToText } from '../content-adapter.js'
import { createModelIO } from '../model-io.js'
import { createAgentSdkProvider } from '../llm/agent-sdk.js'
import { createProvider } from '../provider-registry.js'
import { createGateway, type ACPGateway } from './acp-gateway.js'
import { WORKERS, type WorkerDefinition } from './workers.js'

export interface WorkerRuntimeOptions {
  cwd?: string
  workers?: Record<string, WorkerDefinition>
  acpGateway?: ACPGateway
}

export interface WorkerRuntime {
  executeWorker(worker: string, task: string | PromptContentBlock[], timeoutMs: number): Promise<string>
  workerProviders: Map<string, LLMProvider>
  acpGateway: ACPGateway
  allWorkers(): Record<string, WorkerDefinition>
}

export function createWorkerRuntime(opts: WorkerRuntimeOptions = {}): WorkerRuntime {
  const cwd = opts.cwd ?? process.cwd()
  const customWorkers = opts.workers ?? {}
  const acpGateway = opts.acpGateway ?? createGateway()
  const workerProviders = new Map<string, LLMProvider>()

  const allWorkers = () => ({ ...WORKERS, ...customWorkers })

  for (const [name, def] of Object.entries(allWorkers())) {
    if (def.backend !== 'sdk' && def.backend !== 'acp') continue
    const vendor = def.vendor ?? 'agent-sdk'
    if (vendor === 'agent-sdk') {
      const skillsPrompt = def.skills?.length ? `\n\n<skills>\n${def.skills.join('\n---\n')}\n</skills>` : ''
      workerProviders.set(name, createAgentSdkProvider({
        model: def.agent.model ?? 'sonnet',
        cwd,
        allowedTools: def.agent.tools as string[] | undefined,
        maxTurns: def.agent.maxTurns,
        maxBudgetUsd: 5,
        mcpServers: def.mcpServers,
      }))
      if (skillsPrompt) def.agent.prompt = (def.agent.prompt ?? '') + skillsPrompt
    } else {
      workerProviders.set(name, createProvider({ provider: vendor, model: def.agent.model }))
    }
  }

  async function executeWorker(worker: string, task: string | PromptContentBlock[], timeoutMs: number): Promise<string> {
    const def = allWorkers()[worker]
    if (!def) throw new Error(`Unknown worker: ${worker}`)

    switch (def.backend) {
      case 'sdk': {
        const provider = workerProviders.get(worker)
        if (!provider) throw new Error(`No SDK provider for worker: ${worker}`)
        const maxTurns = def.agent.maxTurns ?? 10
        const safetyTimeout = Math.max(timeoutMs, maxTurns * 120_000)
        return Promise.race([
          createModelIO(worker, provider).generate({ prompt: task, systemPrompt: def.agent.prompt ?? '' }).then(result => result.text),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Worker ${worker} timeout after ${safetyTimeout}ms (maxTurns=${maxTurns})`)), safetyTimeout),
          ),
        ])
      }
      case 'shell': {
        try {
          const command = promptToText(task)
          return execSync(command, { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
        } catch (err) {
          throw new Error(`Shell error: ${err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)}`)
        }
      }
      case 'acp': {
        return acpGateway.dispatch(def.acpCommand ?? 'claude', promptToText(task), timeoutMs)
      }
      case 'webhook': {
        const wh = def.webhook
        if (!wh?.url) throw new Error(`Worker ${worker}: webhook.url not configured`)
        const method = wh.method ?? 'GET'
        const taskText = promptToText(task)
        const body = method !== 'GET' ? (wh.bodyTemplate ? wh.bodyTemplate.replace('{{input}}', taskText) : taskText) : undefined
        const response = await fetch(wh.url, {
          method,
          headers: { 'Content-Type': 'application/json', ...wh.headers },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw new Error(`Webhook ${wh.url} returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
        const text = await response.text()
        if (!wh.resultPath) return text
        try {
          const json = JSON.parse(text)
          const value = wh.resultPath.split('.').reduce((obj: unknown, key) => (obj as Record<string, unknown>)?.[key], json)
          return typeof value === 'string' ? value : JSON.stringify(value)
        } catch {
          return text
        }
      }
      case 'logic': {
        if (!def.logicFn) throw new Error(`Worker ${worker}: logicFn not configured`)
        const fn = new Function('input', 'context', def.logicFn) as (input: string, context: Record<string, unknown>) => unknown
        const value = fn(promptToText(task), { cwd, worker })
        const resolved = value instanceof Promise ? await value : value
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
      }
      case 'middleware': {
        if (!def.middlewareUrl) throw new Error(`Worker ${worker}: middlewareUrl not configured`)
        const response = await fetch(`${def.middlewareUrl}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worker: def.middlewareWorker ?? worker, task, timeout: timeoutMs / 1000 }),
        })
        const { taskId } = await response.json() as { taskId: string }
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          const statusResponse = await fetch(`${def.middlewareUrl}/status/${taskId}`)
          const status = await statusResponse.json() as { status: string; result?: unknown; error?: string }
          if (status.status === 'completed') return typeof status.result === 'string' ? status.result : JSON.stringify(status.result)
          if (status.status === 'failed') throw new Error(status.error ?? 'Upstream task failed')
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
        throw new Error(`Upstream middleware timeout after ${timeoutMs}ms`)
      }
    }
  }

  return { executeWorker, workerProviders, acpGateway, allWorkers }
}
