import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActionHandler, Prompt, PromptContentBlock, StreamChunk } from './types.js'
import { promptToText } from './content-adapter.js'
import { writePolicyEvent } from './provider-policy.js'

export type ArtifactKind = 'image' | 'audio' | 'video' | 'file' | 'three_d' | 'embedding' | 'data'
export type ArtifactStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ArtifactRef {
  id: string
  uri: string
  kind: ArtifactKind
  mediaType: string
  label?: string
  metadata?: Record<string, unknown>
}

export interface ArtifactBlob {
  kind: ArtifactKind
  mediaType: string
  data: Buffer | string
  encoding?: 'base64' | 'utf-8'
  extension?: string
  label?: string
  metadata?: Record<string, unknown>
}

export interface ArtifactRequest {
  type: ArtifactKind
  prompt: Prompt
  instructions?: string
  inputs?: PromptContentBlock[]
  options?: {
    model?: string
    format?: string
    size?: string
    quality?: string
    voice?: string
    durationSeconds?: number
    seed?: number
    n?: number
    partialImages?: number
    [key: string]: unknown
  }
  metadata?: Record<string, unknown>
}

export interface ArtifactJob {
  id: string
  provider: string
  status: ArtifactStatus
  request: ArtifactRequest
  artifacts: ArtifactRef[]
  error?: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

export type ArtifactEvent =
  | { type: 'job.started'; job: ArtifactJob }
  | { type: 'job.running'; job: ArtifactJob }
  | { type: 'artifact.partial'; jobId: string; artifact: ArtifactRef; index?: number }
  | { type: 'artifact.completed'; job: ArtifactJob }
  | { type: 'job.failed'; job: ArtifactJob; error: string }
  | { type: 'job.cancelled'; job: ArtifactJob }

export interface ArtifactCapabilities {
  kinds: ArtifactKind[]
  streaming: boolean
  input: { image: boolean; audio: boolean; video: boolean; file: boolean }
  output: { base64: boolean; file: boolean; url: boolean }
  features?: string[]
}

export interface ArtifactProvider {
  name: string
  capabilities: ArtifactCapabilities
  submit(request: ArtifactRequest): Promise<ArtifactJob>
  submitStream?(request: ArtifactRequest): AsyncIterable<ArtifactEvent>
  get(jobId: string): Promise<ArtifactJob | null>
  stream?(jobId: string): AsyncIterable<ArtifactEvent>
  cancel?(jobId: string): Promise<void>
}

export interface ArtifactStore {
  put(artifact: ArtifactBlob): Promise<ArtifactRef>
  get(ref: ArtifactRef): Promise<ArtifactBlob>
}

export interface ArtifactJobStore {
  put(job: ArtifactJob): Promise<void>
  get(jobId: string): Promise<ArtifactJob | null>
  list?(filter?: { date?: string; provider?: string }): Promise<ArtifactJob[]>
}

export interface ArtifactPolicy {
  allowCloud?: boolean
  dailyCloudCallCap?: number
}

export interface ArtifactPolicyDecision {
  allowed: boolean
  reason: string
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ArtifactGraphNode {
  id: string
  provider: string
  request: ArtifactRequest
  dependsOn?: string[]
}

export interface ArtifactGraph {
  goal?: string
  nodes: ArtifactGraphNode[]
}

export interface ArtifactGraphResult {
  jobs: ArtifactJob[]
  artifacts: ArtifactRef[]
  summary: { completed: number; failed: number }
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private rootDir: string) {}

  async put(artifact: ArtifactBlob): Promise<ArtifactRef> {
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    const dir = resolve(this.rootDir, day)
    mkdirSync(dir, { recursive: true })
    const id = `artifact-${Date.now()}-${randomUUID().slice(0, 8)}`
    const ext = artifact.extension ?? extensionForMediaType(artifact.mediaType)
    const path = join(dir, `${id}${ext}`)
    const data = typeof artifact.data === 'string'
      ? Buffer.from(artifact.data, artifact.encoding === 'base64' ? 'base64' : 'utf-8')
      : artifact.data
    writeFileSync(path, data)
    const ref: ArtifactRef = {
      id,
      uri: path,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      label: artifact.label,
      metadata: { ...artifact.metadata, storedAt: now.toISOString(), sizeBytes: data.length },
    }
    writeFileSync(`${path}.json`, JSON.stringify(ref, null, 2), 'utf-8')
    return ref
  }

  async get(ref: ArtifactRef): Promise<ArtifactBlob> {
    if (!existsSync(ref.uri)) throw new Error(`Artifact not found: ${ref.uri}`)
    return {
      kind: ref.kind,
      mediaType: ref.mediaType,
      data: readFileSync(ref.uri),
      extension: extname(ref.uri),
      label: ref.label,
      metadata: ref.metadata,
    }
  }
}

export class FileArtifactJobStore implements ArtifactJobStore {
  constructor(private rootDir: string) {}

  async put(job: ArtifactJob): Promise<void> {
    const day = job.createdAt.slice(0, 10)
    const dir = resolve(this.rootDir, 'jobs', day)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${safeFileName(job.id)}.json`), JSON.stringify(job, null, 2), 'utf-8')
  }

  async get(jobId: string): Promise<ArtifactJob | null> {
    const root = resolve(this.rootDir, 'jobs')
    if (!existsSync(root)) return null
    for (const day of readdirSync(root)) {
      const path = join(root, day, `${safeFileName(jobId)}.json`)
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as ArtifactJob
    }
    return null
  }

  async list(filter: { date?: string; provider?: string } = {}): Promise<ArtifactJob[]> {
    const root = resolve(this.rootDir, 'jobs')
    if (!existsSync(root)) return []
    const days = filter.date ? [filter.date] : readdirSync(root)
    const jobs: ArtifactJob[] = []
    for (const day of days) {
      const dir = join(root, day)
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir).filter(file => file.endsWith('.json'))) {
        const job = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ArtifactJob
        if (!filter.provider || job.provider === filter.provider) jobs.push(job)
      }
    }
    return jobs
  }
}

export interface OpenAIArtifactProviderOptions {
  apiKey?: string
  baseUrl?: string
  imageModel?: string
  audioModel?: string
  fetch?: FetchLike
  store: ArtifactStore
  jobStore?: ArtifactJobStore
}

export interface ArtifactProviderFromEnvOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  artifactDir?: string
  provider?: 'openai' | 'none'
  defaultProvider?: 'openai' | 'none'
  requireConfigured?: boolean
  artifactPolicy?: ArtifactPolicy
  policyStateDir?: string
}

export interface ArtifactProviderSelection {
  providers: Record<string, ArtifactProvider>
  defaultProvider?: string
  store: ArtifactStore
  jobStore: ArtifactJobStore
  policyDecision?: ArtifactPolicyDecision
  enabled: boolean
  reason?: string
}

export function createOpenAIArtifactProvider(opts: OpenAIArtifactProviderOptions): ArtifactProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const imageModel = opts.imageModel ?? 'gpt-image-1.5'
  const audioModel = opts.audioModel ?? 'gpt-4o-mini-tts'
  const fetchImpl = opts.fetch ?? fetch
  const jobStore = opts.jobStore
  const jobs = new Map<string, ArtifactJob>()
  const eventHistory = new Map<string, ArtifactEvent[]>()
  const waiters = new Map<string, Array<(event: ArtifactEvent) => void>>()

  const provider: ArtifactProvider = {
    name: 'openai-artifacts',
    capabilities: {
      kinds: ['image', 'audio'],
      streaming: true,
      input: { image: true, audio: false, video: false, file: true },
      output: { base64: true, file: true, url: true },
      features: ['image-generate', 'image-edit-via-responses', 'tts'],
    },

    async submit(request: ArtifactRequest): Promise<ArtifactJob> {
      let finalJob: ArtifactJob | null = null
      for await (const event of provider.submitStream!(request)) {
        if ('job' in event) finalJob = event.job
      }
      if (!finalJob) throw new Error('artifact provider returned no job')
      return finalJob
    },

    async *submitStream(request: ArtifactRequest): AsyncIterable<ArtifactEvent> {
      if (!apiKey) throw new Error('OPENAI_API_KEY not set')
      const job = createJob(provider.name, request)
      jobs.set(job.id, job)
      const started = { type: 'job.started', job: cloneJob(job) } satisfies ArtifactEvent
      emit(job.id, started)
      yield started
      job.status = 'running'
      job.updatedAt = new Date().toISOString()
      await saveJob(jobStore, job)
      const running = { type: 'job.running', job: cloneJob(job) } satisfies ArtifactEvent
      emit(job.id, running)
      yield running
      try {
        if (request.type === 'image') {
          job.artifacts = await generateOpenAIImage(request)
        } else if (request.type === 'audio') {
          job.artifacts = await generateOpenAIAudio(request)
        } else {
          throw new Error(`OpenAI artifact provider does not support ${request.type}`)
        }
        job.status = 'completed'
        job.updatedAt = new Date().toISOString()
        await saveJob(jobStore, job)
        job.artifacts.forEach((artifact, index) => {
          const event = { type: 'artifact.partial', jobId: job.id, artifact, index } satisfies ArtifactEvent
          emit(job.id, event)
        })
        for (const event of eventHistory.get(job.id)?.filter(event => event.type === 'artifact.partial') ?? []) yield event
        const completed = { type: 'artifact.completed', job: cloneJob(job) } satisfies ArtifactEvent
        emit(job.id, completed)
        yield completed
      } catch (err) {
        job.status = 'failed'
        job.error = err instanceof Error ? err.message : String(err)
        job.updatedAt = new Date().toISOString()
        await saveJob(jobStore, job)
        const failed = { type: 'job.failed', job: cloneJob(job), error: job.error } satisfies ArtifactEvent
        emit(job.id, failed)
        yield failed
      }
      job.updatedAt = new Date().toISOString()
      jobs.set(job.id, job)
      await saveJob(jobStore, job)
    },

    async get(jobId: string) {
      return jobs.get(jobId) ?? await jobStore?.get(jobId) ?? null
    },

    async *stream(jobId: string) {
      let seen = 0
      for (const event of eventHistory.get(jobId) ?? []) {
        seen++
        yield event
      }
      while (true) {
        const job = jobs.get(jobId) ?? await jobStore?.get(jobId) ?? null
        if (!job) return
        if (isTerminal(job.status)) {
          if (seen === 0) yield* streamCompletedJob(job)
          return
        }
        const event = await waitForEvent(jobId)
        const history = eventHistory.get(jobId) ?? []
        for (const next of history.slice(seen)) {
          seen++
          yield next
        }
        if (isTerminalEvent(event)) return
      }
    },
  }

  function emit(jobId: string, event: ArtifactEvent) {
    const history = eventHistory.get(jobId) ?? []
    history.push(event)
    eventHistory.set(jobId, history)
    for (const resolve of waiters.get(jobId) ?? []) resolve(event)
    waiters.delete(jobId)
  }

  function waitForEvent(jobId: string): Promise<ArtifactEvent> {
    return new Promise(resolve => {
      const list = waiters.get(jobId) ?? []
      list.push(resolve)
      waiters.set(jobId, list)
    })
  }

  async function generateOpenAIImage(request: ArtifactRequest): Promise<ArtifactRef[]> {
    const imageInputs = collectImageInputs(request)
    if (imageInputs.length) return editOpenAIImage(request, imageInputs)

    const response = await fetchImpl(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: request.options?.model ?? imageModel,
        prompt: promptToText(request.prompt),
        size: request.options?.size ?? '1024x1024',
        quality: request.options?.quality ?? 'medium',
        n: request.options?.n ?? 1,
        output_format: request.options?.format ?? 'png',
      }),
    })
    if (!response.ok) throw new Error(`OpenAI image API ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const data = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }
    const refs: ArtifactRef[] = []
    for (const item of data.data ?? []) {
      if (item.b64_json) {
        refs.push(await opts.store.put({
          kind: 'image',
          mediaType: `image/${request.options?.format ?? 'png'}`,
          data: item.b64_json,
          encoding: 'base64',
          extension: `.${request.options?.format ?? 'png'}`,
          metadata: { provider: provider.name, model: request.options?.model ?? imageModel, revisedPrompt: item.revised_prompt },
        }))
      } else if (item.url) {
        refs.push({ id: `artifact-${randomUUID().slice(0, 8)}`, uri: item.url, kind: 'image', mediaType: 'image/*', metadata: { provider: provider.name, model: request.options?.model ?? imageModel, revisedPrompt: item.revised_prompt } })
      }
    }
    return refs
  }

  async function editOpenAIImage(request: ArtifactRequest, imageInputs: ImageInput[]): Promise<ArtifactRef[]> {
    const format = String(request.options?.format ?? 'png')
    const form = new FormData()
    form.append('model', String(request.options?.model ?? imageModel))
    form.append('prompt', promptToText(request.prompt))
    form.append('size', String(request.options?.size ?? '1024x1024'))
    form.append('quality', String(request.options?.quality ?? 'medium'))
    form.append('n', String(request.options?.n ?? 1))
    form.append('output_format', format)
    const first = imageInputs[0]
    form.append('image', new Blob([new Uint8Array(first.bytes)], { type: first.mediaType }), first.name)

    const response = await fetchImpl(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    })
    if (!response.ok) throw new Error(`OpenAI image edit API ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const data = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }
    const refs: ArtifactRef[] = []
    for (const item of data.data ?? []) {
      if (item.b64_json) {
        refs.push(await opts.store.put({
          kind: 'image',
          mediaType: `image/${format}`,
          data: item.b64_json,
          encoding: 'base64',
          extension: `.${format}`,
          metadata: {
            provider: provider.name,
            model: request.options?.model ?? imageModel,
            revisedPrompt: item.revised_prompt,
            inputArtifacts: imageInputs.map(input => input.name),
          },
        }))
      } else if (item.url) {
        refs.push({
          id: `artifact-${randomUUID().slice(0, 8)}`,
          uri: item.url,
          kind: 'image',
          mediaType: 'image/*',
          metadata: {
            provider: provider.name,
            model: request.options?.model ?? imageModel,
            revisedPrompt: item.revised_prompt,
            inputArtifacts: imageInputs.map(input => input.name),
          },
        })
      }
    }
    return refs
  }

  async function generateOpenAIAudio(request: ArtifactRequest): Promise<ArtifactRef[]> {
    const format = request.options?.format ?? 'mp3'
    const response = await fetchImpl(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: request.options?.model ?? audioModel,
        input: promptToText(request.prompt),
        voice: request.options?.voice ?? 'alloy',
        response_format: format,
      }),
    })
    if (!response.ok) throw new Error(`OpenAI audio API ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    return [await opts.store.put({
      kind: 'audio',
      mediaType: mediaTypeForAudioFormat(format),
      data: bytes,
      extension: `.${format}`,
      metadata: { provider: provider.name, model: request.options?.model ?? audioModel, voice: request.options?.voice ?? 'alloy' },
    })]
  }

  return provider
}

export function createArtifactGraphExecutor(providers: Record<string, ArtifactProvider>) {
  return async function execute(graph: ArtifactGraph): Promise<ArtifactGraphResult> {
    const remaining = new Map(graph.nodes.map(node => [node.id, node]))
    const completed = new Map<string, ArtifactJob>()
    const jobs: ArtifactJob[] = []
    const failed = new Set<string>()

    while (remaining.size > 0) {
      const ready = [...remaining.values()].filter(node => (node.dependsOn ?? []).every(dep => completed.has(dep) || failed.has(dep)))
      if (ready.length === 0) throw new Error(`Artifact graph deadlock: ${[...remaining.keys()].join(', ')}`)

      const wave = await Promise.all(ready.map(async node => {
        remaining.delete(node.id)
        if ((node.dependsOn ?? []).some(dep => failed.has(dep))) {
          const job = failedJob(node, 'dependency failed')
          failed.add(node.id)
          return job
        }
        const provider = providers[node.provider]
        if (!provider) {
          const job = failedJob(node, `unknown provider: ${node.provider}`)
          failed.add(node.id)
          return job
        }
        const depArtifacts = (node.dependsOn ?? []).flatMap(dep => completed.get(dep)?.artifacts ?? [])
        const request: ArtifactRequest = {
          ...node.request,
          inputs: [...(node.request.inputs ?? []), ...depArtifacts.map(artifactToPromptBlock)],
        }
        const job = await provider.submit(request)
        if (job.status !== 'completed') failed.add(node.id)
        else completed.set(node.id, job)
        return job
      }))
      jobs.push(...wave)
    }

    return {
      jobs,
      artifacts: jobs.flatMap(job => job.artifacts),
      summary: { completed: jobs.filter(job => job.status === 'completed').length, failed: jobs.filter(job => job.status === 'failed').length },
    }
  }
}

export function createArtifactActions(opts: { providers: Record<string, ArtifactProvider>; defaultProvider?: string }): ActionHandler[] {
  const defaultProvider = opts.defaultProvider ?? Object.keys(opts.providers)[0]

  const executeGenerate = async (input: Record<string, unknown>) => {
    const providerName = String(input.provider ?? defaultProvider)
    const provider = opts.providers[providerName]
    if (!provider) throw new Error(`Unknown artifact provider: ${providerName}`)
    const request = createArtifactRequestFromInput(input)
    const job = await provider.submit(request)
    return JSON.stringify(job, null, 2)
  }

  return [
    {
      type: 'artifact_generate',
      description: 'Generate an artifact such as image, audio, video, file, 3D asset, embedding, or data through an artifact provider.',
      toolSchema: {
        properties: {
          type: { type: 'string', description: 'Artifact kind: image, audio, video, file, three_d, embedding, data' },
          prompt: { type: 'string', description: 'Generation prompt' },
          provider: { type: 'string', description: 'Artifact provider name' },
          model: { type: 'string', description: 'Provider model override' },
          format: { type: 'string', description: 'Output format, e.g. png, webp, mp3, wav' },
          size: { type: 'string', description: 'Image/video size' },
          quality: { type: 'string', description: 'Output quality' },
          voice: { type: 'string', description: 'Audio voice' },
          refs: { type: 'array', description: 'Input artifact refs or URIs to pass to the provider' },
          inputs: { type: 'array', description: 'Prompt content blocks used as multimodal inputs' },
        },
        required: ['type', 'prompt'],
      },
      async execute(action) { return executeGenerate(action.input ?? { content: action.content }) },
    },
    {
      type: 'image_generate',
      description: 'Generate an image artifact. Alias for artifact_generate with type=image.',
      toolSchema: {
        properties: {
          prompt: { type: 'string', description: 'Image prompt' },
          provider: { type: 'string', description: 'Artifact provider name' },
          model: { type: 'string', description: 'Image model override' },
          format: { type: 'string', description: 'png, jpeg, webp' },
          size: { type: 'string', description: 'Image size' },
          quality: { type: 'string', description: 'low, medium, high' },
          refs: { type: 'array', description: 'Input image artifact refs or URIs for edit/variation workflows' },
          inputs: { type: 'array', description: 'Prompt content blocks used as multimodal inputs' },
        },
        required: ['prompt'],
      },
      async execute(action) { return executeGenerate({ ...(action.input ?? { prompt: action.content }), type: 'image' }) },
    },
    {
      type: 'audio_generate',
      description: 'Generate an audio artifact. Alias for artifact_generate with type=audio.',
      toolSchema: {
        properties: {
          prompt: { type: 'string', description: 'Speech/audio prompt' },
          provider: { type: 'string', description: 'Artifact provider name' },
          model: { type: 'string', description: 'Audio model override' },
          format: { type: 'string', description: 'mp3, wav, opus' },
          voice: { type: 'string', description: 'Voice name' },
          refs: { type: 'array', description: 'Input audio/file artifact refs or URIs for transformation workflows' },
          inputs: { type: 'array', description: 'Prompt content blocks used as multimodal inputs' },
        },
        required: ['prompt'],
      },
      async execute(action) { return executeGenerate({ ...(action.input ?? { prompt: action.content }), type: 'audio' }) },
    },
  ]
}

export function decideArtifactProviderUse(
  selection: Pick<ArtifactProviderSelection, 'enabled' | 'jobStore'>,
  opts: { policy?: ArtifactPolicy; provider?: string } = {},
): ArtifactPolicyDecision {
  const policy = opts.policy ?? {}
  if (!selection.enabled) return { allowed: true, reason: 'artifact provider disabled' }
  if (policy.allowCloud === false) return { allowed: false, reason: 'artifact cloud providers disabled by policy' }
  if (policy.dailyCloudCallCap !== undefined && selection.jobStore.list) {
    const today = new Date().toISOString().slice(0, 10)
    // Synchronous callers get a conservative decision from persisted jobs loaded elsewhere.
    return { allowed: true, reason: `daily artifact cap configured (${policy.dailyCloudCallCap}); enforced by guarded provider` }
  }
  return { allowed: true, reason: 'policy allowed' }
}

export function wrapArtifactProviderWithPolicy(
  provider: ArtifactProvider,
  opts: { policy?: ArtifactPolicy; jobStore?: ArtifactJobStore; policyStateDir?: string },
): ArtifactProvider {
  const guard = async () => {
    const policy = opts.policy ?? {}
    if (policy.allowCloud === false) {
      writePolicyEvent(opts.policyStateDir, {
        domain: 'artifact',
        provider: provider.name,
        allowed: false,
        reason: 'artifact cloud providers disabled by policy',
      })
      throw new Error('Artifact provider blocked by policy: artifact cloud providers disabled by policy')
    }
    if (policy.dailyCloudCallCap !== undefined && opts.jobStore?.list) {
      const today = new Date().toISOString().slice(0, 10)
      const calls = (await opts.jobStore.list({ date: today, provider: provider.name })).length
      if (calls >= policy.dailyCloudCallCap) {
        writePolicyEvent(opts.policyStateDir, {
          domain: 'artifact',
          provider: provider.name,
          allowed: false,
          reason: `daily artifact call cap reached (${calls}/${policy.dailyCloudCallCap})`,
        })
        throw new Error(`Artifact provider blocked by policy: daily artifact call cap reached (${calls}/${policy.dailyCloudCallCap})`)
      }
    }
  }

  return {
    ...provider,
    async submit(request) {
      await guard()
      return provider.submit(request)
    },
    async *submitStream(request) {
      await guard()
      if (provider.submitStream) yield* provider.submitStream(request)
      else yield* streamCompletedJob(await provider.submit(request))
    },
  }
}

export function createArtifactRequestFromInput(input: Record<string, unknown>): ArtifactRequest {
  return {
    type: String(input.type ?? input.kind ?? 'image') as ArtifactKind,
    prompt: String(input.prompt ?? input.content ?? ''),
    inputs: normalizeArtifactInputs(input),
    options: (input.options as ArtifactRequest['options']) ?? {
      model: input.model as string | undefined,
      format: input.format as string | undefined,
      size: input.size as string | undefined,
      quality: input.quality as string | undefined,
      voice: input.voice as string | undefined,
    },
    metadata: (input.metadata as Record<string, unknown> | undefined),
  }
}

export function createArtifactProviderFromEnv(opts: ArtifactProviderFromEnvOptions = {}): ArtifactProviderSelection {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const providerKey = opts.provider ?? (env.TANREN_ARTIFACT_PROVIDER as 'openai' | 'none' | undefined) ?? opts.defaultProvider ?? 'openai'
  const artifactDir = opts.artifactDir ?? env.TANREN_ARTIFACT_DIR ?? join(cwd, 'memory', 'artifacts')
  const store = new FileArtifactStore(artifactDir)
  const jobStore = new FileArtifactJobStore(artifactDir)
  const artifactPolicy = opts.artifactPolicy ?? readArtifactPolicyFromEnv(env)
  const policyDecision = decideArtifactProviderUse({ enabled: providerKey !== 'none', jobStore }, { policy: artifactPolicy })

  if (!policyDecision.allowed) return { providers: {}, store, jobStore, policyDecision, enabled: false, reason: policyDecision.reason }
  if (providerKey === 'none') return { providers: {}, store, jobStore, policyDecision, enabled: false, reason: 'artifact provider disabled' }
  if (providerKey !== 'openai') {
    if (opts.requireConfigured) throw new Error(`Unknown TANREN_ARTIFACT_PROVIDER="${providerKey}"`)
    return { providers: {}, store, jobStore, policyDecision, enabled: false, reason: `unknown provider: ${providerKey}` }
  }
  if (!env.OPENAI_API_KEY) {
    if (opts.requireConfigured) throw new Error('TANREN_ARTIFACT_PROVIDER=openai requires OPENAI_API_KEY')
    return { providers: {}, store, jobStore, policyDecision, enabled: false, reason: 'OPENAI_API_KEY not set' }
  }

  const provider = wrapArtifactProviderWithPolicy(createOpenAIArtifactProvider({
    store,
    jobStore,
    apiKey: env.OPENAI_API_KEY,
    baseUrl: env.OPENAI_BASE_URL,
    imageModel: env.TANREN_IMAGE_MODEL,
    audioModel: env.TANREN_AUDIO_MODEL,
  }), { policy: artifactPolicy, jobStore, policyStateDir: opts.policyStateDir })
  return { providers: { [provider.name]: provider, openai: provider }, defaultProvider: provider.name, store, jobStore, policyDecision, enabled: true }
}

export function createArtifactActionsFromEnv(opts: ArtifactProviderFromEnvOptions = {}): ActionHandler[] {
  const selection = createArtifactProviderFromEnv(opts)
  if (!selection.enabled || !selection.defaultProvider) return []
  return createArtifactActions({ providers: selection.providers, defaultProvider: selection.defaultProvider })
}

function createJob(provider: string, request: ArtifactRequest): ArtifactJob {
  const now = new Date().toISOString()
  return { id: `job-${Date.now()}-${randomUUID().slice(0, 8)}`, provider, status: 'queued', request, artifacts: [], createdAt: now, updatedAt: now }
}

async function saveJob(store: ArtifactJobStore | undefined, job: ArtifactJob): Promise<void> {
  if (store) await store.put(cloneJob(job))
}

async function* streamCompletedJob(job: ArtifactJob): AsyncIterable<ArtifactEvent> {
  yield { type: 'job.started', job }
  if (job.status === 'running') yield { type: 'job.running', job }
  for (const [index, artifact] of job.artifacts.entries()) yield { type: 'artifact.partial', jobId: job.id, artifact, index }
  if (job.status === 'completed') yield { type: 'artifact.completed', job }
  if (job.status === 'failed') yield { type: 'job.failed', job, error: job.error ?? 'failed' }
  if (job.status === 'cancelled') yield { type: 'job.cancelled', job }
}

function readArtifactPolicyFromEnv(env: NodeJS.ProcessEnv): ArtifactPolicy | undefined {
  const policy: ArtifactPolicy = {}
  if (env.TANREN_ALLOW_ARTIFACT_CLOUD != null) policy.allowCloud = env.TANREN_ALLOW_ARTIFACT_CLOUD === '1'
  if (env.TANREN_DAILY_ARTIFACT_CALL_CAP) policy.dailyCloudCallCap = parseInt(env.TANREN_DAILY_ARTIFACT_CALL_CAP, 10)
  return Object.keys(policy).length ? policy : undefined
}

function safeFileName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function failedJob(node: ArtifactGraphNode, error: string): ArtifactJob {
  const job = createJob(node.provider, node.request)
  job.status = 'failed'
  job.error = error
  job.updatedAt = new Date().toISOString()
  return job
}

function artifactToPromptBlock(ref: ArtifactRef): PromptContentBlock {
  return { type: 'ref', uri: ref.uri, mediaType: ref.mediaType, label: ref.label }
}

function normalizeArtifactInputs(input: Record<string, unknown>): PromptContentBlock[] | undefined {
  const blocks: PromptContentBlock[] = []
  if (Array.isArray(input.inputs)) {
    for (const item of input.inputs) {
      if (isPromptBlock(item)) blocks.push(item)
      else if (typeof item === 'string') blocks.push({ type: 'ref', uri: item })
    }
  }
  for (const item of normalizeRefList(input.refs ?? input.ref ?? input.sourceArtifactIds)) {
    blocks.push(typeof item === 'string' ? { type: 'ref', uri: item } : artifactToPromptBlock(item))
  }
  return blocks.length ? blocks : undefined
}

function normalizeRefList(value: unknown): Array<string | ArtifactRef> {
  if (!value) return []
  const raw = Array.isArray(value) ? value : [value]
  const refs: Array<string | ArtifactRef> = []
  for (const item of raw) {
    if (typeof item === 'string' || isArtifactRef(item)) refs.push(item)
  }
  return refs
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return !!value && typeof value === 'object'
    && typeof (value as ArtifactRef).uri === 'string'
    && typeof (value as ArtifactRef).kind === 'string'
    && typeof (value as ArtifactRef).mediaType === 'string'
}

function isPromptBlock(value: unknown): value is PromptContentBlock {
  return !!value && typeof value === 'object' && typeof (value as PromptContentBlock).type === 'string'
}

function cloneJob(job: ArtifactJob): ArtifactJob {
  return { ...job, artifacts: [...job.artifacts] }
}

interface ImageInput {
  name: string
  bytes: Buffer
  mediaType: string
}

function collectImageInputs(request: ArtifactRequest): ImageInput[] {
  const inputs: ImageInput[] = []
  for (const block of request.inputs ?? []) {
    const input = imageInputFromBlock(block)
    if (input) inputs.push(input)
  }
  return inputs
}

function imageInputFromBlock(block: PromptContentBlock): ImageInput | null {
  if (block.type === 'ref') {
    if (!isImageMediaType(block.mediaType) && block.mediaType) return null
    if (!isLocalFile(block.uri) || !existsSync(block.uri)) return null
    const mediaType = block.mediaType ?? mediaTypeForPath(block.uri)
    if (!isImageMediaType(mediaType)) return null
    return { name: basename(block.uri), bytes: readFileSync(block.uri), mediaType }
  }
  if (block.type === 'media') {
    if (!isImageMediaType(block.mediaType)) return null
    if (block.source.type === 'base64') {
      return {
        name: `${block.label ?? 'input'}${extensionForMediaType(block.mediaType)}`,
        bytes: Buffer.from(block.source.data, 'base64'),
        mediaType: block.mediaType,
      }
    }
    if (block.source.type === 'file' && existsSync(block.source.path)) {
      return { name: basename(block.source.path), bytes: readFileSync(block.source.path), mediaType: block.mediaType }
    }
  }
  return null
}

function isLocalFile(uri: string): boolean {
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || uri.startsWith('file:')
}

function mediaTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

function isImageMediaType(mediaType: string | undefined): boolean {
  return !!mediaType && mediaType.startsWith('image/')
}

function isTerminal(status: ArtifactStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isTerminalEvent(event: ArtifactEvent): boolean {
  return event.type === 'artifact.completed' || event.type === 'job.failed' || event.type === 'job.cancelled'
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType.includes('png')) return '.png'
  if (mediaType.includes('jpeg') || mediaType.includes('jpg')) return '.jpg'
  if (mediaType.includes('webp')) return '.webp'
  if (mediaType.includes('mpeg') || mediaType.includes('mp3')) return '.mp3'
  if (mediaType.includes('wav')) return '.wav'
  if (mediaType.includes('mp4')) return '.mp4'
  if (mediaType.includes('json')) return '.json'
  if (mediaType.includes('pdf')) return '.pdf'
  return '.bin'
}

function mediaTypeForAudioFormat(format: string): string {
  if (format === 'wav') return 'audio/wav'
  if (format === 'opus') return 'audio/opus'
  if (format === 'aac') return 'audio/aac'
  if (format === 'flac') return 'audio/flac'
  return 'audio/mpeg'
}
