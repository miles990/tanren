import { promptToText } from './content-adapter.js'
import { TEXT_ONLY_CAPABILITIES } from './provider-capabilities.js'
import type { ArtifactRequest, ArtifactJob, ArtifactProvider } from './artifact-types.js'
import type { LLMProvider, Prompt, ProviderCapabilities, StreamChunk, StructuredResponse } from './types.js'

export interface ModelRequest {
  prompt: Prompt
  systemPrompt?: string
  metadata?: Record<string, unknown>
}

export interface ModelResponse extends StructuredResponse {
  provider?: string
}

export interface ModelIO {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  generate(request: ModelRequest): Promise<ModelResponse>
  stream(request: ModelRequest): AsyncIterable<StreamChunk>
}

export type GenerationRequest =
  | { modality: 'model'; request: ModelRequest }
  | { modality: 'artifact'; request: ArtifactRequest }

export type GenerationResponse =
  | { modality: 'model'; response: ModelResponse }
  | { modality: 'artifact'; job: ArtifactJob }

export interface GenerationIO {
  readonly name: string
  generate(request: GenerationRequest): Promise<GenerationResponse>
}

export interface ModelRouteRequirement {
  output?: Partial<ProviderCapabilities['output']>
  streaming?: Partial<ProviderCapabilities['streaming']>
}

export interface ModelRouteDecision {
  selected?: ModelIO
  rejected: Array<{ name: string; reason: string }>
}

export function createGenerationIO(opts: { name: string; model?: ModelIO; artifactProvider?: ArtifactProvider }): GenerationIO {
  return {
    name: opts.name,
    async generate(request) {
      if (request.modality === 'model') {
        if (!opts.model) throw new Error('GenerationIO has no model adapter')
        return { modality: 'model', response: await opts.model.generate(request.request) }
      }
      if (!opts.artifactProvider) throw new Error('GenerationIO has no artifact adapter')
      return { modality: 'artifact', job: await opts.artifactProvider.submit(request.request) }
    },
  }
}

export function createModelIO(name: string, provider: LLMProvider): ModelIO {
  const capabilities = provider.capabilities ?? TEXT_ONLY_CAPABILITIES

  return {
    name,
    capabilities,

    async generate(request: ModelRequest): Promise<ModelResponse> {
      const systemPrompt = request.systemPrompt ?? ''
      if (provider.thinkStructured) {
        const response = await provider.thinkStructured(request.prompt, systemPrompt)
        return { ...response, provider: name, metadata: { ...response.metadata, ...request.metadata } }
      }
      return {
        text: await provider.think(promptToText(request.prompt), systemPrompt),
        provider: name,
        metadata: { degradedToText: true, ...request.metadata },
      }
    },

    async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
      const systemPrompt = request.systemPrompt ?? ''
      if (provider.thinkStream) {
        yield* provider.thinkStream(request.prompt, systemPrompt)
        return
      }
      const response = await this.generate(request)
      if (response.text) yield { type: 'text_delta', text: response.text }
      for (const output of response.outputs ?? []) yield { type: 'content_block', content: output }
      yield { type: 'done', metadata: response.metadata }
    },
  }
}

export async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<StructuredResponse> {
  let text = ''
  const outputs: NonNullable<StructuredResponse['outputs']> = []
  const metadata: Record<string, unknown> = {}

  for await (const chunk of stream) {
    if (chunk.type === 'text_delta' || chunk.type === 'structured_delta') text += chunk.text ?? ''
    if ((chunk.type === 'content_block' || chunk.type === 'media_delta') && chunk.content) outputs.push(chunk.content)
    if (chunk.metadata) Object.assign(metadata, chunk.metadata)
    if (chunk.type === 'error') throw new Error(chunk.error ?? 'Model stream error')
  }

  return { text, outputs: outputs.length ? outputs : undefined, metadata }
}

export function supportsModelRequest(model: ModelIO, request: ModelRequest, requirement: ModelRouteRequirement = {}): { ok: boolean; reason: string } {
  const prompt = Array.isArray(request.prompt) ? request.prompt : [{ type: 'text' as const, text: request.prompt }]
  for (const block of prompt) {
    if (block.type === 'text' && !model.capabilities.input.text) return { ok: false, reason: 'text input unsupported' }
    if (block.type === 'media') {
      if (block.mediaType.startsWith('image/') && !model.capabilities.input.image) return { ok: false, reason: 'image input unsupported' }
      if (block.mediaType.startsWith('audio/') && !model.capabilities.input.audio) return { ok: false, reason: 'audio input unsupported' }
      if (block.mediaType === 'application/pdf' && !model.capabilities.input.pdf) return { ok: false, reason: 'pdf input unsupported' }
      if (!block.mediaType.startsWith('image/') && !block.mediaType.startsWith('audio/') && block.mediaType !== 'application/pdf' && !model.capabilities.input.file) {
        return { ok: false, reason: 'file input unsupported' }
      }
      if (block.source.type === 'url' && !model.capabilities.input.url) return { ok: false, reason: 'url input unsupported' }
      if (block.source.type === 'file' && !model.capabilities.input.file) return { ok: false, reason: 'file input unsupported' }
    }
    if (block.type === 'stream' && !model.capabilities.input.streamRef) return { ok: false, reason: 'stream input unsupported' }
    if (block.type === 'ref') {
      if (block.mediaType?.startsWith('image/') && !model.capabilities.input.image) return { ok: false, reason: 'image ref unsupported' }
      if (block.mediaType?.startsWith('audio/') && !model.capabilities.input.audio) return { ok: false, reason: 'audio ref unsupported' }
      if (!model.capabilities.input.url && !model.capabilities.input.file) return { ok: false, reason: 'ref input unsupported' }
    }
  }

  for (const [key, required] of Object.entries(requirement.output ?? {}) as Array<[keyof ProviderCapabilities['output'], boolean | undefined]>) {
    if (required && !model.capabilities.output[key]) return { ok: false, reason: `${key} output unsupported` }
  }
  for (const [key, required] of Object.entries(requirement.streaming ?? {}) as Array<[keyof ProviderCapabilities['streaming'], boolean | undefined]>) {
    if (required && !model.capabilities.streaming[key]) return { ok: false, reason: `${key} streaming unsupported` }
  }

  return { ok: true, reason: 'supported' }
}

export function routeModelRequest(models: ModelIO[], request: ModelRequest, requirement: ModelRouteRequirement = {}): ModelRouteDecision {
  const rejected: ModelRouteDecision['rejected'] = []
  for (const model of models) {
    const decision = supportsModelRequest(model, request, requirement)
    if (decision.ok) return { selected: model, rejected }
    rejected.push({ name: model.name, reason: decision.reason })
  }
  return { rejected }
}
