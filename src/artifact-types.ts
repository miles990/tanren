import type { Prompt, PromptContentBlock } from './types.js'

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
