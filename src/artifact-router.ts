import type { ArtifactProvider, ArtifactRequest } from './artifact-types.js'

export interface ArtifactRouteDecision {
  provider: ArtifactProvider
  providerName: string
  reason: string
}

export interface ArtifactRouterOptions {
  providers: Record<string, ArtifactProvider>
  defaultProvider?: string
}

export function routeArtifactRequest(request: ArtifactRequest, opts: ArtifactRouterOptions): ArtifactRouteDecision {
  const explicit = request.metadata?.provider
  if (typeof explicit === 'string') {
    const provider = opts.providers[explicit]
    if (!provider) throw new Error(`Unknown artifact provider: ${explicit}`)
    if (!supportsArtifactRequest(provider, request)) throw new Error(`Artifact provider "${explicit}" does not support ${request.type}`)
    return { provider, providerName: explicit, reason: 'explicit provider' }
  }

  const preferred = opts.defaultProvider ? opts.providers[opts.defaultProvider] : undefined
  if (preferred && supportsArtifactRequest(preferred, request)) {
    return { provider: preferred, providerName: opts.defaultProvider!, reason: 'default provider' }
  }

  for (const [name, provider] of Object.entries(opts.providers)) {
    if (supportsArtifactRequest(provider, request)) return { provider, providerName: name, reason: 'capability match' }
  }

  throw new Error(`No artifact provider supports ${request.type}`)
}

export function supportsArtifactRequest(provider: ArtifactProvider, request: ArtifactRequest): boolean {
  if (!provider.capabilities.kinds.includes(request.type)) return false
  for (const input of request.inputs ?? []) {
    if (input.type === 'media') {
      if (input.mediaType.startsWith('image/') && !provider.capabilities.input.image) return false
      if (input.mediaType.startsWith('audio/') && !provider.capabilities.input.audio) return false
      if (input.mediaType.startsWith('video/') && !provider.capabilities.input.video) return false
      if (!input.mediaType.startsWith('image/') && !input.mediaType.startsWith('audio/') && !input.mediaType.startsWith('video/') && !provider.capabilities.input.file) return false
    }
    if (input.type === 'ref' && !provider.capabilities.input.file) return false
  }
  return true
}
