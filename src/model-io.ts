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
