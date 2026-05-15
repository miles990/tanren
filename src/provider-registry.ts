/**
 * Tanren — Provider Registry
 *
 * One framework seam for choosing LLM providers, cloud fallback, and token
 * usage telemetry. Agents should configure policy; they should not reimplement
 * provider switch statements.
 */

import { join } from 'node:path'
import type { LLMProvider } from './types.js'
import { createAgentSdkProvider, type AgentSdkOptions } from './llm/agent-sdk.js'
import { createAnthropicProvider, type AnthropicProviderOptions } from './llm/anthropic.js'
import { createClaudeCliProvider, type ClaudeCliOptions } from './llm/claude-cli.js'
import { createCodexCliProvider, type CodexCliOptions } from './llm/codex-cli.js'
import { createOpenAIProvider, createFallbackProvider, type OpenAIProviderOptions } from './llm/openai.js'
import { createGoogleProvider, type GoogleProviderOptions } from './llm/google.js'
import { createManagedAgentProvider, type ManagedAgentProviderOptions } from './llm/managed-agent.js'
import { wrapProviderWithUsageLedger } from './usage-ledger.js'

export type BuiltinProviderKey =
  | 'agent-sdk'
  | 'anthropic'
  | 'anthropic-managed'
  | 'openai'
  | 'google'
  | 'local'
  | 'omlx'
  | 'codex'
  | 'claude-cli'

export type ProviderKey = BuiltinProviderKey | (string & {})

const PROVIDER_KEYS: BuiltinProviderKey[] = [
  'agent-sdk',
  'anthropic',
  'anthropic-managed',
  'openai',
  'google',
  'local',
  'omlx',
  'codex',
  'claude-cli',
]

function isProviderKey(value: string | undefined): value is ProviderKey {
  ensureBuiltinProviderFactories()
  return !!value && providerFactories.has(value)
}

export interface ProviderConfig {
  provider: ProviderKey
  model?: string
  cloud?: boolean
  options?: Record<string, unknown>
}

export interface ProviderFactoryContext {
  model?: string
  options: Record<string, unknown>
  env: NodeJS.ProcessEnv
  cwd?: string
}

export type ProviderFactory = (context: ProviderFactoryContext) => LLMProvider

const providerFactories = new Map<string, ProviderFactory>()
const providerDescriptions = new Map<string, { provider: ProviderKey; cloud: boolean; description: string }>()
let builtinsRegistered = false

export function registerProviderFactory(
  provider: ProviderKey,
  factory: ProviderFactory,
  metadata: { cloud: boolean; description: string },
): void {
  providerFactories.set(provider, factory)
  providerDescriptions.set(provider, { provider, ...metadata })
}

export interface ProviderSelection {
  provider: LLMProvider
  providerKey: ProviderKey
  providerName: string
  model?: string
  cloud: boolean
  cloudFallbackEnabled: boolean
  mode: string
}

export interface ProviderFromEnvOptions {
  cwd?: string
  stateDir?: string
  env?: NodeJS.ProcessEnv
  serviceEnvPrefix?: string
  mode?: string
  provider?: ProviderKey
  defaultMode?: string
  defaultProvider?: ProviderKey
  localReviewProvider?: ProviderKey
  codexModeProvider?: ProviderKey
  cloudFallbackEnabled?: boolean
  agentSdk?: Partial<AgentSdkOptions> & { mcpToolNames?: string[] }
}

export function createProvider(config: ProviderConfig): LLMProvider {
  ensureBuiltinProviderFactories()
  const model = config.model
  const options = config.options ?? {}
  const factory = providerFactories.get(config.provider)
  if (!factory) throw new Error(`Unknown provider "${config.provider}". Use ${[...providerFactories.keys()].join(', ')}.`)
  return factory({ model, options, env: process.env })
}

export function listProviders(): Array<{ provider: ProviderKey; cloud: boolean; description: string }> {
  ensureBuiltinProviderFactories()
  return [...providerDescriptions.values()]
}

export function createProviderFromEnv(opts: ProviderFromEnvOptions = {}): ProviderSelection {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const mode = opts.mode ?? readScopedEnv(env, 'MODE', opts.serviceEnvPrefix) ?? opts.defaultMode ?? 'cloud-research'
  const rawProvider = opts.provider ?? env.TANREN_LLM_PROVIDER ?? env.LLM_PROVIDER
  if (rawProvider && !isProviderKey(rawProvider)) {
    throw new Error(`Unknown LLM_PROVIDER="${rawProvider}". Use ${[...providerFactories.keys()].join(', ')}.`)
  }
  const providerKey: ProviderKey = (rawProvider as ProviderKey | undefined)
    ?? (mode === 'local-review'
      ? (opts.localReviewProvider ?? 'omlx')
      : mode === 'codex'
        ? (opts.codexModeProvider ?? 'codex')
        : (opts.defaultProvider ?? 'agent-sdk'))
  const cloudFallbackEnabled = opts.cloudFallbackEnabled ?? (readScopedEnv(env, 'CLOUD_FALLBACK', opts.serviceEnvPrefix) === '1')
  const model = readScopedEnv(env, 'MODEL', opts.serviceEnvPrefix)

  let provider: LLMProvider
  let providerName: string = providerKey
  let cloud = !['local', 'omlx'].includes(providerKey)

  if (providerKey === 'agent-sdk') {
    const baseTools = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent']
    provider = createAgentSdkProvider({
      cwd,
      model: model || 'claude-sonnet-4-6',
      allowedTools: [...baseTools, ...(opts.agentSdk?.mcpToolNames ?? [])],
      ...opts.agentSdk,
    })
    providerName = 'Agent SDK (subscription)'
    cloud = true
  } else if (providerKey === 'omlx' || providerKey === 'local') {
    const localModel = env.LOCAL_LLM_MODEL || model || 'Qwen3.5-4B-MLX-4bit'
    const localProvider = createProvider({
      provider: providerKey,
      model: localModel,
      options: {
        apiKey: env.LOCAL_LLM_KEY || 'local',
        baseUrl: `${env.LOCAL_LLM_URL || 'http://localhost:8000'}/v1`,
      },
    })
    if (cloudFallbackEnabled) {
      provider = createFallbackProvider(localProvider as any, createClaudeCliProvider({ model: 'claude-sonnet-4-6' }), `${providerKey}->claude-cli`)
      providerName = `${providerKey} local (${localModel}) + cloud fallback`
      cloud = true
    } else {
      provider = localProvider
      providerName = `${providerKey} local (${localModel}, no cloud fallback)`
      cloud = false
    }
  } else if (providerKey === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY')
    provider = createProvider({ provider: 'anthropic', model: model || 'claude-sonnet-4-6', options: { apiKey: env.ANTHROPIC_API_KEY } })
    providerName = 'Anthropic API'
    cloud = true
  } else if (providerKey === 'codex') {
    provider = createCodexCliProvider({
      cwd,
      ...(model ? { model } : {}),
      profile: env.CODEX_PROFILE,
      sandbox: (env.CODEX_SANDBOX as CodexCliOptions['sandbox']) || 'read-only',
      oss: env.CODEX_OSS === '1',
      localProvider: env.CODEX_LOCAL_PROVIDER as CodexCliOptions['localProvider'],
    })
    providerName = model ? `Codex CLI (${model})` : 'Codex CLI'
    cloud = env.CODEX_OSS !== '1'
  } else {
    provider = createProvider({ provider: providerKey, model })
    providerName = providerKey
    cloud = !['local', 'omlx'].includes(providerKey)
  }

  if (opts.stateDir) {
    provider = wrapProviderWithUsageLedger(provider, {
      stateDir: opts.stateDir || join(cwd, 'memory', 'state'),
      provider: cloudFallbackEnabled && (providerKey === 'omlx' || providerKey === 'local') ? `${providerKey}-fallback` : providerKey,
      model,
      cloud,
    })
  }

  return { provider, providerKey, providerName, model, cloud, cloudFallbackEnabled, mode }
}

export function readScopedEnv(env: NodeJS.ProcessEnv, key: string, serviceEnvPrefix?: string): string | undefined {
  const prefix = normalizeEnvPrefix(serviceEnvPrefix)
  return env[`TANREN_${key}`]
    ?? (prefix ? env[`${prefix}${key}`] : undefined)
    ?? env[`AKARI_${key}`]
}

export function normalizeEnvPrefix(prefix?: string): string | undefined {
  if (!prefix) return undefined
  const normalized = prefix.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized ? `${normalized}_` : undefined
}

function ensureBuiltinProviderFactories(): void {
  if (builtinsRegistered) return
  builtinsRegistered = true
  registerProviderFactory('agent-sdk', ({ model, options }) =>
    createAgentSdkProvider({ model: model ?? 'claude-sonnet-4-6', ...(options as Partial<AgentSdkOptions>) }), {
      cloud: true,
      description: 'Claude Agent SDK via local subscription auth',
    })
  registerProviderFactory('anthropic', ({ model, options, env }) =>
    createAnthropicProvider({
      apiKey: String(options.apiKey ?? env.ANTHROPIC_API_KEY ?? ''),
      model: model ?? 'claude-sonnet-4-6',
      ...(options as Partial<AnthropicProviderOptions>),
    } as AnthropicProviderOptions), {
      cloud: true,
      description: 'Anthropic Messages API',
    })
  registerProviderFactory('anthropic-managed', ({ model, options }) =>
    createManagedAgentProvider({ model: model ?? 'claude-sonnet-4-6', ...(options as Partial<ManagedAgentProviderOptions>) }), {
      cloud: true,
      description: 'Anthropic cloud managed agent/container',
    })
  registerProviderFactory('openai', ({ model, options, env }) =>
    createOpenAIProvider({
      ...(options as Partial<OpenAIProviderOptions>),
      apiKey: String(options.apiKey ?? env.OPENAI_API_KEY ?? ''),
      model: model ?? 'gpt-4o',
    } as OpenAIProviderOptions), {
      cloud: true,
      description: 'OpenAI-compatible cloud API',
    })
  registerProviderFactory('google', ({ model, options }) =>
    createGoogleProvider({ model: model ?? 'gemini-2.0-flash', ...(options as Partial<GoogleProviderOptions>) }), {
      cloud: true,
      description: 'Google Gemini API',
    })
  registerProviderFactory('local', createLocalProvider, {
    cloud: false,
    description: 'OpenAI-compatible local model',
  })
  registerProviderFactory('omlx', createLocalProvider, {
    cloud: false,
    description: 'omlx/MLX local model',
  })
  registerProviderFactory('codex', ({ model, options }) =>
    createCodexCliProvider({ model, ...(options as Partial<CodexCliOptions>) }), {
      cloud: true,
      description: 'Codex CLI, cloud unless CODEX_OSS=1',
    })
  registerProviderFactory('claude-cli', ({ model, options }) =>
    createClaudeCliProvider({ model: model ?? 'claude-sonnet-4-6', ...(options as Partial<ClaudeCliOptions>) }), {
      cloud: true,
      description: 'Claude CLI via local subscription auth',
    })
}

function createLocalProvider({ model, options, env }: ProviderFactoryContext): LLMProvider {
  return createOpenAIProvider({
    ...(options as Partial<OpenAIProviderOptions>),
    apiKey: String(options.apiKey ?? env.LOCAL_LLM_KEY ?? 'local'),
    baseUrl: String(options.baseUrl ?? `${env.LOCAL_LLM_URL ?? 'http://localhost:8000'}/v1`),
    model: model ?? env.LOCAL_LLM_MODEL ?? 'Qwen3.5-4B-MLX-4bit',
    maxTokens: 4096,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  } as OpenAIProviderOptions)
}
