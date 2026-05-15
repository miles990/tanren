import type { PromptContentBlock } from './types.js'
import type { ArtifactJob, ArtifactKind, ArtifactRef, ArtifactRequest } from './artifact-types.js'

const ARTIFACT_KINDS = new Set<ArtifactKind>(['image', 'audio', 'video', 'file', 'three_d', 'embedding', 'data'])

export function parseArtifactRequest(input: Record<string, unknown>): ArtifactRequest {
  const type = String(input.type ?? input.kind ?? 'image') as ArtifactKind
  if (!ARTIFACT_KINDS.has(type)) throw new Error(`Invalid artifact type: ${type}`)
  const prompt = input.prompt ?? input.content ?? ''
  if (typeof prompt !== 'string' && !Array.isArray(prompt)) throw new Error('Artifact prompt must be a string or prompt content array')
  const options = parseArtifactOptions(input)
  const request: ArtifactRequest = {
    type,
    prompt,
    inputs: normalizeArtifactInputs(input),
    ...(options ? { options } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
  }
  return request
}

export function parseArtifactJob(value: unknown): ArtifactJob {
  if (!isRecord(value)) throw new Error('Artifact job must be an object')
  if (typeof value.id !== 'string') throw new Error('Artifact job id must be a string')
  if (typeof value.provider !== 'string') throw new Error('Artifact job provider must be a string')
  if (!Array.isArray(value.artifacts)) throw new Error('Artifact job artifacts must be an array')
  return value as unknown as ArtifactJob
}

function parseArtifactOptions(input: Record<string, unknown>): ArtifactRequest['options'] | undefined {
  const raw = isRecord(input.options) ? input.options : input
  const options: ArtifactRequest['options'] = {}
  for (const key of ['model', 'format', 'size', 'quality', 'voice'] as const) {
    if (typeof raw[key] === 'string') options[key] = raw[key]
  }
  if (typeof raw.durationSeconds === 'number') options.durationSeconds = raw.durationSeconds
  if (typeof raw.seed === 'number') options.seed = raw.seed
  if (typeof raw.n === 'number') options.n = raw.n
  if (typeof raw.partialImages === 'number') options.partialImages = raw.partialImages
  return Object.keys(options).length ? options : undefined
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

function artifactToPromptBlock(ref: ArtifactRef): PromptContentBlock {
  return { type: 'ref', uri: ref.uri, mediaType: ref.mediaType, label: ref.label }
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return isRecord(value)
    && typeof value.uri === 'string'
    && typeof value.kind === 'string'
    && typeof value.mediaType === 'string'
}

function isPromptBlock(value: unknown): value is PromptContentBlock {
  return isRecord(value) && typeof value.type === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
