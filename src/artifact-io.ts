import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActionHandler, Prompt, PromptContentBlock, StreamChunk } from './types.js'
import { promptToText } from './content-adapter.js'

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
  | { type: 'artifact.partial'; jobId: string; artifact: ArtifactRef; index?: number }
  | { type: 'artifact.completed'; job: ArtifactJob }
  | { type: 'job.failed'; job: ArtifactJob; error: string }

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
  get(jobId: string): Promise<ArtifactJob | null>
  stream?(jobId: string): AsyncIterable<ArtifactEvent>
  cancel?(jobId: string): Promise<void>
}

export interface ArtifactStore {
  put(artifact: ArtifactBlob): Promise<ArtifactRef>
  get(ref: ArtifactRef): Promise<ArtifactBlob>
}

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

export interface OpenAIArtifactProviderOptions {
  apiKey?: string
  baseUrl?: string
  imageModel?: string
  audioModel?: string
  store: ArtifactStore
}

export function createOpenAIArtifactProvider(opts: OpenAIArtifactProviderOptions): ArtifactProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const imageModel = opts.imageModel ?? 'gpt-image-1.5'
  const audioModel = opts.audioModel ?? 'gpt-4o-mini-tts'
  const jobs = new Map<string, ArtifactJob>()

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
      if (!apiKey) throw new Error('OPENAI_API_KEY not set')
      const job = createJob(provider.name, request)
      jobs.set(job.id, job)
      job.status = 'running'
      job.updatedAt = new Date().toISOString()
      try {
        if (request.type === 'image') {
          job.artifacts = await generateOpenAIImage(request)
        } else if (request.type === 'audio') {
          job.artifacts = await generateOpenAIAudio(request)
        } else {
          throw new Error(`OpenAI artifact provider does not support ${request.type}`)
        }
        job.status = 'completed'
      } catch (err) {
        job.status = 'failed'
        job.error = err instanceof Error ? err.message : String(err)
      }
      job.updatedAt = new Date().toISOString()
      jobs.set(job.id, job)
      return job
    },

    async get(jobId: string) {
      return jobs.get(jobId) ?? null
    },

    async *stream(jobId: string) {
      const job = jobs.get(jobId)
      if (!job) return
      yield { type: 'job.started', job }
      if (job.status === 'completed') {
        yield { type: 'artifact.completed', job }
      } else if (job.status === 'failed') {
        yield { type: 'job.failed', job, error: job.error ?? 'failed' }
      }
    },
  }

  async function generateOpenAIImage(request: ArtifactRequest): Promise<ArtifactRef[]> {
    const response = await fetch(`${baseUrl}/images/generations`, {
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

  async function generateOpenAIAudio(request: ArtifactRequest): Promise<ArtifactRef[]> {
    const format = request.options?.format ?? 'mp3'
    const response = await fetch(`${baseUrl}/audio/speech`, {
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
    const request: ArtifactRequest = {
      type: String(input.type ?? input.kind ?? 'image') as ArtifactKind,
      prompt: String(input.prompt ?? input.content ?? ''),
      options: (input.options as ArtifactRequest['options']) ?? {
        model: input.model as string | undefined,
        format: input.format as string | undefined,
        size: input.size as string | undefined,
        quality: input.quality as string | undefined,
        voice: input.voice as string | undefined,
      },
    }
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
        },
        required: ['prompt'],
      },
      async execute(action) { return executeGenerate({ ...(action.input ?? { prompt: action.content }), type: 'audio' }) },
    },
  ]
}

function createJob(provider: string, request: ArtifactRequest): ArtifactJob {
  const now = new Date().toISOString()
  return { id: `job-${Date.now()}-${randomUUID().slice(0, 8)}`, provider, status: 'queued', request, artifacts: [], createdAt: now, updatedAt: now }
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
