import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createArtifactRequestFromInput } from './artifact-io.js'
import type { ArtifactEvent, ArtifactJob, ArtifactProviderSelection } from './artifact-types.js'
import { readPolicyEvents, writePolicyEvent, type PolicyEvent } from './provider-policy.js'

export class ArtifactController {
  constructor(private opts: { artifacts?: ArtifactProviderSelection; memoryDir: string }) {}

  async list(filter: { date?: string; provider?: string } = {}): Promise<ArtifactJob[]> {
    const jobs = await this.opts.artifacts?.jobStore.list?.(filter) ?? []
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async submit(input: Record<string, unknown>): Promise<ArtifactJob> {
    const provider = this.selectProvider(input.provider)
    return provider.submit(createArtifactRequestFromInput(input))
  }

  async submitStream(input: Record<string, unknown>): Promise<AsyncIterable<ArtifactEvent>> {
    const provider = this.selectProvider(input.provider)
    const request = createArtifactRequestFromInput(input)
    return provider.submitStream?.(request) ?? streamCompletedJob(await provider.submit(request))
  }

  async get(jobId: string, providerName?: string | null): Promise<ArtifactJob | null> {
    const selection = this.opts.artifacts
    const provider = selection?.enabled && selection.defaultProvider
      ? selection.providers[String(providerName ?? selection.defaultProvider)]
      : undefined
    return await provider?.get(jobId) ?? await selection?.jobStore.get(jobId) ?? null
  }

  async cancel(jobId: string, providerName?: string | null): Promise<ArtifactJob | null> {
    const selection = this.opts.artifacts
    const job = await this.get(jobId, providerName)
    if (!job) return null
    const provider = selection?.providers[providerName ?? job.provider]
    await provider?.cancel?.(jobId)
    const cancelled: ArtifactJob = { ...job, status: 'cancelled', updatedAt: new Date().toISOString() }
    await selection?.jobStore.put(cancelled)
    return cancelled
  }

  follow(jobId: string, providerName?: string | null): AsyncIterable<ArtifactEvent> {
    const provider = this.selectProvider(providerName ?? undefined)
    return provider.stream?.(jobId) ?? this.replay(jobId, providerName)
  }

  private async *replay(jobId: string, providerName?: string | null): AsyncIterable<ArtifactEvent> {
    yield* streamCompletedJob(await this.get(jobId, providerName))
  }

  private selectProvider(providerName?: unknown) {
    const selection = this.opts.artifacts
    if (!selection?.enabled || !selection.defaultProvider) {
      writePolicyEvent(join(this.opts.memoryDir, 'state'), {
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
}

export class ArtifactFileServer {
  constructor(private controller: ArtifactController) {}

  async read(jobId: string, index = 0, providerName?: string | null): Promise<{ mediaType: string; filename: string; bytes: Buffer; uri: string } | null> {
    const job = await this.controller.get(jobId, providerName)
    if (!job) return null
    const artifact = job.artifacts[index]
    if (!artifact) return null
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(artifact.uri) || !existsSync(artifact.uri)) {
      throw new Error('artifact is not a local file')
    }
    return { mediaType: artifact.mediaType, filename: artifact.id, bytes: readFileSync(artifact.uri), uri: artifact.uri }
  }
}

export class PolicyEventController {
  constructor(private stateDir: string) {}

  list(opts: { limit?: number; domain?: PolicyEvent['domain']; provider?: string } = {}): PolicyEvent[] {
    return readPolicyEvents(this.stateDir, opts)
  }
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
