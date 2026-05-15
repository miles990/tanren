import type { ArtifactJobStore, ArtifactPolicy, ArtifactProvider, ArtifactRequest } from './artifact-types.js'

export interface ArtifactRouteDecision {
  provider: ArtifactProvider
  providerName: string
  reason: string
  candidates: string[]
}

export interface ArtifactRouterOptions {
  providers: Record<string, ArtifactProvider>
  defaultProvider?: string
  policy?: ArtifactPolicy
  jobStore?: ArtifactJobStore
}

export async function routeArtifactRequestAsync(request: ArtifactRequest, opts: ArtifactRouterOptions): Promise<ArtifactRouteDecision> {
  const explicit = request.metadata?.provider
  if (typeof explicit === 'string') {
    const provider = opts.providers[explicit]
    if (!provider) throw new Error(`Unknown artifact provider: ${explicit}`)
    if (!supportsArtifactRequest(provider, request)) throw new Error(`Artifact provider "${explicit}" does not support ${request.type}`)
    await assertPolicyAllows(provider, opts)
    return { provider, providerName: explicit, reason: 'explicit provider', candidates: [explicit] }
  }

  const candidates = Object.entries(opts.providers).filter(([, provider]) => supportsArtifactRequest(provider, request))
  const preferred = opts.defaultProvider ? opts.providers[opts.defaultProvider] : undefined
  if (preferred && supportsArtifactRequest(preferred, request) && await policyAllows(preferred, opts)) {
    return { provider: preferred, providerName: opts.defaultProvider!, reason: 'default provider', candidates: candidates.map(([name]) => name) }
  }

  for (const [name, provider] of candidates) {
    if (await policyAllows(provider, opts)) return { provider, providerName: name, reason: opts.policy ? 'capability and policy match' : 'capability match', candidates: candidates.map(([candidateName]) => candidateName) }
  }

  throw new Error(`No artifact provider supports ${request.type}`)
}

export function routeArtifactRequest(request: ArtifactRequest, opts: ArtifactRouterOptions): ArtifactRouteDecision {
  const explicit = request.metadata?.provider
  if (typeof explicit === 'string') {
    const provider = opts.providers[explicit]
    if (!provider) throw new Error(`Unknown artifact provider: ${explicit}`)
    if (!supportsArtifactRequest(provider, request)) throw new Error(`Artifact provider "${explicit}" does not support ${request.type}`)
    assertPolicyAllowsSync(provider, opts)
    return { provider, providerName: explicit, reason: 'explicit provider', candidates: [explicit] }
  }

  const candidates = Object.entries(opts.providers).filter(([, provider]) => supportsArtifactRequest(provider, request))
  const preferred = opts.defaultProvider ? opts.providers[opts.defaultProvider] : undefined
  if (preferred && supportsArtifactRequest(preferred, request) && policyAllowsSync(preferred, opts)) {
    return { provider: preferred, providerName: opts.defaultProvider!, reason: 'default provider', candidates: candidates.map(([name]) => name) }
  }
  for (const [name, provider] of candidates) {
    if (policyAllowsSync(provider, opts)) return { provider, providerName: name, reason: opts.policy ? 'capability and policy match' : 'capability match', candidates: candidates.map(([candidateName]) => candidateName) }
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

async function assertPolicyAllows(provider: ArtifactProvider, opts: ArtifactRouterOptions): Promise<void> {
  if (!await policyAllows(provider, opts)) throw new Error(`Artifact provider "${provider.name}" blocked by policy`)
}

function assertPolicyAllowsSync(provider: ArtifactProvider, opts: ArtifactRouterOptions): void {
  if (!policyAllowsSync(provider, opts)) throw new Error(`Artifact provider "${provider.name}" blocked by policy`)
}

async function policyAllows(provider: ArtifactProvider, opts: ArtifactRouterOptions): Promise<boolean> {
  if (opts.policy?.allowCloud === false) return false
  if (opts.policy?.dailyCloudCallCap !== undefined && opts.jobStore?.list) {
    const today = new Date().toISOString().slice(0, 10)
    const calls = (await opts.jobStore.list({ date: today, provider: provider.name })).length
    return calls < opts.policy.dailyCloudCallCap
  }
  return true
}

function policyAllowsSync(_provider: ArtifactProvider, opts: ArtifactRouterOptions): boolean {
  return opts.policy?.allowCloud !== false
}
