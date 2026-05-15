import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createArtifactRequestFromInput } from './artifact-io.js'
import type { ArtifactEvent, ArtifactJob, ArtifactProviderSelection } from './artifact-types.js'
import { readPolicyEvents, writePolicyEvent } from './provider-policy.js'

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
  if (url.pathname === '/policy/events' && req.method === 'GET') {
    json(res, 200, {
      events: readPolicyEvents(join(opts.memoryDir, 'state'), {
        limit: parseInt(url.searchParams.get('limit') ?? '100', 10),
        domain: (url.searchParams.get('domain') as 'llm' | 'artifact' | null) ?? undefined,
        provider: url.searchParams.get('provider') ?? undefined,
      }),
    })
    return true
  }

  if (url.pathname === '/artifacts' && req.method === 'GET') {
    try {
      const selection = opts.artifacts
      if (!selection?.jobStore.list) { json(res, 200, { jobs: [] }); return true }
      const jobs = await selection.jobStore.list({
        date: url.searchParams.get('date') ?? undefined,
        provider: url.searchParams.get('provider') ?? undefined,
      })
      json(res, 200, { jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname === '/artifacts' && req.method === 'POST') {
    try {
      const parsed = await readJsonBody(req)
      const provider = selectArtifactProvider(opts, parsed.provider)
      const job = await provider.submit(createArtifactRequestFromInput(parsed))
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
      const provider = selectArtifactProvider(opts, parsed.provider)
      sse(res, 'job.submitted', { provider: provider.name })
      const request = createArtifactRequestFromInput(parsed)
      let finalJob: ArtifactJob | null = null
      const stream = provider.submitStream?.(request) ?? streamCompletedJob(await provider.submit(request))
      for await (const event of stream) {
        if ('job' in event) finalJob = event.job
        sse(res, event.type, event)
      }
      sse(res, 'done', { jobId: finalJob?.id, status: finalJob?.status ?? 'unknown' })
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
      const job = await getArtifactJob(opts, jobId, url.searchParams.get('provider'))
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
      const selection = opts.artifacts
      const job = await getArtifactJob(opts, jobId, url.searchParams.get('provider'))
      if (!job) { json(res, 404, { error: 'artifact job not found' }); return true }
      const provider = selection?.providers[url.searchParams.get('provider') ?? job.provider]
      await provider?.cancel?.(jobId)
      const cancelled: ArtifactJob = { ...job, status: 'cancelled', updatedAt: new Date().toISOString() }
      await selection?.jobStore.put(cancelled)
      json(res, 200, cancelled)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (url.pathname.match(/^\/artifacts\/[^/]+\/file$/) && req.method === 'GET') {
    try {
      const jobId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
      const job = await getArtifactJob(opts, jobId, url.searchParams.get('provider'))
      if (!job) { json(res, 404, { error: 'artifact job not found' }); return true }
      const index = parseInt(url.searchParams.get('index') ?? '0', 10)
      const artifact = job.artifacts[index]
      if (!artifact) { json(res, 404, { error: 'artifact not found' }); return true }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(artifact.uri) || !existsSync(artifact.uri)) {
        json(res, 400, { error: 'artifact is not a local file', artifact })
        return true
      }
      res.writeHead(200, { 'Content-Type': artifact.mediaType, 'Content-Disposition': `inline; filename="${artifact.id}"` })
      res.end(readFileSync(artifact.uri))
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
      const provider = selectArtifactProvider(opts, url.searchParams.get('provider') ?? undefined)
      const stream = provider.stream?.(jobId) ?? streamCompletedJob(await provider.get(jobId))
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

function selectArtifactProvider(opts: ArtifactHttpOptions, providerName?: unknown) {
  const selection = opts.artifacts
  if (!selection?.enabled || !selection.defaultProvider) {
    writePolicyEvent(join(opts.memoryDir, 'state'), {
      domain: 'artifact',
      provider: String(providerName ?? 'default'),
      allowed: false,
      reason: selection?.reason ?? selection?.policyDecision?.reason ?? 'artifact provider disabled',
    })
    throw new Error('artifact provider disabled')
  }
  const name = String(providerName ?? selection.defaultProvider)
  const provider = selection.providers[name]
  if (!provider) throw new Error(`Unknown artifact provider: ${name}`)
  return provider
}

async function getArtifactJob(opts: ArtifactHttpOptions, jobId: string, providerName?: string | null): Promise<ArtifactJob | null> {
  const selection = opts.artifacts
  const provider = selection?.enabled && selection.defaultProvider
    ? selection.providers[String(providerName ?? selection.defaultProvider)]
    : undefined
  return await provider?.get(jobId) ?? await selection?.jobStore.get(jobId) ?? null
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

async function* streamCompletedJob(job: ArtifactJob | null): AsyncIterable<ArtifactEvent> {
  if (!job) return
  yield { type: 'job.started', job }
  for (const [index, artifact] of job.artifacts.entries()) {
    yield { type: 'artifact.partial', jobId: job.id, artifact, index }
  }
  if (job.status === 'failed') yield { type: 'job.failed', job, error: job.error ?? 'failed' }
  else if (job.status === 'cancelled') yield { type: 'job.cancelled', job }
  else if (job.status === 'completed') yield { type: 'artifact.completed', job }
}
