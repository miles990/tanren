import type { IncomingMessage, ServerResponse } from 'node:http'
import { LongTaskController, type LongTaskStatus } from './long-task.js'

export interface LongTaskHttpOptions {
  controller: LongTaskController
}

export async function handleLongTaskHttpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: LongTaskHttpOptions,
): Promise<boolean> {
  const controller = opts.controller

  if (url.pathname === '/tasks' && req.method === 'GET') {
    json(res, 200, {
      tasks: controller.list({
        status: (url.searchParams.get('status') as LongTaskStatus | null) ?? undefined,
        limit: parseInt(url.searchParams.get('limit') ?? '50', 10),
      }),
    })
    return true
  }

  if (url.pathname === '/tasks' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req)
      json(res, 202, controller.create(body))
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/tasks\/[^/]+$/) && req.method === 'GET') {
    const task = controller.get(decodeURIComponent(url.pathname.split('/')[2] ?? ''))
    if (!task) json(res, 404, { error: 'task not found' })
    else json(res, 200, task)
    return true
  }

  if (url.pathname.match(/^\/tasks\/[^/]+$/) && req.method === 'DELETE') {
    const task = controller.cancel(decodeURIComponent(url.pathname.split('/')[2] ?? ''))
    if (!task) json(res, 404, { error: 'task not found' })
    else json(res, 200, task)
    return true
  }

  if (url.pathname.match(/^\/tasks\/[^/]+\/resume$/) && req.method === 'POST') {
    try {
      json(res, 202, controller.resume(decodeURIComponent(url.pathname.split('/')[2] ?? '')))
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/tasks\/[^/]+\/events$/) && req.method === 'GET') {
    const taskId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
    if (!controller.get(taskId)) { json(res, 404, { error: 'task not found' }); return true }
    json(res, 200, { events: controller.events(taskId, parseInt(url.searchParams.get('limit') ?? '100', 10)) })
    return true
  }

  if (url.pathname.match(/^\/tasks\/[^/]+\/result$/) && req.method === 'GET') {
    const taskId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
    const result = controller.result(taskId)
    if (result == null) { json(res, 404, { error: 'task result not found' }); return true }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    res.end(result)
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
