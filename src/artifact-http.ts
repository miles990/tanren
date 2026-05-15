import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ArtifactProviderSelection } from './artifact-types.js'
import { ArtifactController, ArtifactFileServer, PolicyEventController } from './artifact-controller.js'

export interface ArtifactHttpOptions {
  artifacts?: ArtifactProviderSelection
  memoryDir: string
}

export async function handleArtifactHttpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: ArtifactHttpOptions,
): Promise<boolean> {
  const controller = new ArtifactController(opts)
  const fileServer = new ArtifactFileServer(controller)
  const policyEvents = new PolicyEventController(join(opts.memoryDir, 'state'))
  if (url.pathname === '/policy/events' && req.method === 'GET') {
    json(res, 200, {
      events: policyEvents.list({
        limit: parseInt(url.searchParams.get('limit') ?? '100', 10),
        domain: (url.searchParams.get('domain') as 'llm' | 'artifact' | null) ?? undefined,
        provider: url.searchParams.get('provider') ?? undefined,
      }),
    })
    return true
  }

  if (url.pathname === '/artifacts' && req.method === 'GET') {
    try {
      const jobs = await controller.list({
        date: url.searchParams.get('date') ?? undefined,
        provider: url.searchParams.get('provider') ?? undefined,
      })
      json(res, 200, { jobs })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname === '/artifacts' && req.method === 'POST') {
    try {
      const parsed = await readJsonBody(req)
      const job = await controller.submit(parsed)
      json(res, job.status === 'failed' ? 500 : 200, job)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname === '/artifacts/stream' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    try {
      const parsed = await readJsonBody(req)
      const stream = await controller.submitStream(parsed)
      sse(res, 'job.submitted', {})
      let finalJobId: string | undefined
      let finalStatus = 'unknown'
      for await (const event of stream) {
        if ('job' in event) {
          finalJobId = event.job.id
          finalStatus = event.job.status
        }
        sse(res, event.type, event)
      }
      sse(res, 'done', { jobId: finalJobId, status: finalStatus })
    } catch (err) {
      sse(res, 'error', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      res.end()
    }
    return true
  }

  if (url.pathname.match(/^\/artifacts\/[^/]+$/) && req.method === 'GET') {
    try {
      const jobId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
      const job = await controller.get(jobId, url.searchParams.get('provider'))
      if (!job) { json(res, 404, { error: 'artifact job not found' }); return true }
      json(res, 200, job)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/artifacts\/[^/]+$/) && req.method === 'DELETE') {
    try {
      const jobId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
      const job = await controller.cancel(jobId, url.searchParams.get('provider'))
      if (!job) { json(res, 404, { error: 'artifact job not found' }); return true }
      json(res, 200, job)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/artifacts\/[^/]+\/file$/) && req.method === 'GET') {
    try {
      const jobId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
      const index = parseInt(url.searchParams.get('index') ?? '0', 10)
      const file = await fileServer.read(jobId, index, url.searchParams.get('provider'))
      if (!file) { json(res, 404, { error: 'artifact file not found' }); return true }
      res.writeHead(200, { 'Content-Type': file.mediaType, 'Content-Disposition': `inline; filename="${file.filename}"` })
      res.end(file.bytes)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/artifacts\/[^/]+\/stream$/) && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    try {
      const jobId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
      const stream = controller.follow(jobId, url.searchParams.get('provider') ?? undefined)
      for await (const event of stream) sse(res, event.type, event)
      sse(res, 'done', { jobId })
    } catch (err) {
      sse(res, 'error', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      res.end()
    }
    return true
  }

  return false
}

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const sse = (res: ServerResponse, event: string, data: unknown) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const readJsonBody = async <T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body) as T
}
