import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionHandler, PerceptionPlugin, TanrenConfig } from './types.js'
import { builtinActions } from './actions.js'
import { createAgoraCollaboration, type AgoraCollaboration } from './agora-collaboration.js'
import { createAnalysisWithoutActionGate, createOutputGate, createProductivityGate, createSymptomFixGate } from './gates.js'
import { createAutoVerifyHook, createClaimVerificationHook, type Hook } from './hooks.js'
import { createKgNotificationDiscussionPlugin } from './kg-collaboration.js'
import { loadMcpServersFromConfig, type McpConfigSelection } from './mcp-config.js'
import { createPeerBridge, type PeerBridge } from './peer-bridge.js'
import { createProviderFromEnv, type ProviderSelection, type ProviderKey } from './provider-registry.js'
import { createRoleContractPlugin } from './role-contract.js'
import { readUsageSummary } from './env.js'
import type { Gate } from './types.js'

export interface RuntimePresetOptions {
  baseDir?: string
  serviceName?: string
  memoryDir?: string
  messagesDir?: string
  identity?: string
  skillsDir?: string
  rolePath?: string
  peerName?: string
  peerRegistryText?: string
  searchPaths?: string[]
  mode?: string
  provider?: ProviderKey
  cloudFallbackEnabled?: boolean
  mcpConfigPath?: string
  mcpDefaultPath?: string
  kgUrl?: string
  enableAgora?: boolean
  enableKgNotifications?: boolean
  verifyCommand?: string
  feedbackRounds?: number
  tickInterval?: number
  extraPerceptionPlugins?: PerceptionPlugin[]
  extraActions?: ActionHandler[]
  extraHooks?: Hook[]
  extraGates?: Gate[]
}

export interface RuntimePreset {
  config: TanrenConfig
  peerBridge: PeerBridge
  agora?: AgoraCollaboration
  providerSelection: ProviderSelection
  mcpConfig: McpConfigSelection
  health: () => Record<string, unknown>
  capabilities: Record<string, unknown>
}

export function createAgentRuntimePreset(opts: RuntimePresetOptions = {}): RuntimePreset {
  const baseDir = opts.baseDir ?? '.'
  const memoryDir = opts.memoryDir ?? join(baseDir, 'memory')
  const messagesDir = opts.messagesDir ?? join(baseDir, 'messages')
  const serviceName = opts.serviceName ?? 'tanren-agent'
  const mode = opts.mode ?? process.env.AKARI_MODE ?? process.env.TANREN_MODE ?? 'cloud-research'
  const provider = opts.provider ?? (process.env.LLM_PROVIDER as ProviderKey | undefined)
    ?? (mode === 'local-review' ? 'omlx' : mode === 'codex' ? 'codex' : 'agent-sdk')
  const cloudFallbackEnabled = opts.cloudFallbackEnabled ?? process.env.AKARI_CLOUD_FALLBACK === '1'

  const peerBridge = createPeerBridge({
    messagesDir,
    peerName: opts.peerName ?? 'peer',
    registryText: opts.peerRegistryText,
  })
  const mcpConfig = loadMcpServersFromConfig({
    path: opts.mcpConfigPath,
    defaultPath: opts.mcpDefaultPath,
    logger: console,
  })
  const providerSelection = createProviderFromEnv({
    cwd: process.cwd(),
    stateDir: join(memoryDir, 'state'),
    mode,
    provider,
    cloudFallbackEnabled,
    agentSdk: mcpConfig.mcpServers ? { mcpServers: mcpConfig.mcpServers, mcpToolNames: mcpConfig.mcpToolNames } : undefined,
  })

  const perceptionPlugins: PerceptionPlugin[] = [
    {
      name: 'clock',
      category: 'environment',
      fn: () => `Current time: ${new Date().toISOString()}`,
    },
    ...peerBridge.perceptionPlugins,
    createRoleContractPlugin({ rolesPath: opts.rolePath ?? join(memoryDir, 'roles.md'), name: 'role-matrix' }),
    createTickHistoryPlugin(memoryDir),
    ...(opts.extraPerceptionPlugins ?? []),
  ]

  let agora: AgoraCollaboration | undefined
  if (opts.enableAgora ?? true) {
    agora = createAgoraCollaboration({
      stateDir: join(baseDir, 'agora-state'),
      agentName: serviceName,
      agentDescription: `${serviceName} Tanren agent`,
    })
    perceptionPlugins.push(...agora.perceptionPlugins)
  }

  if (opts.enableKgNotifications ?? true) {
    perceptionPlugins.push(createKgNotificationDiscussionPlugin({
      kgUrl: opts.kgUrl ?? process.env.KG_URL ?? 'http://localhost:3300',
      eventsDir: join(memoryDir, 'events', 'pending'),
      processedDir: join(memoryDir, 'events', 'processed'),
      sourceAgent: serviceName,
    }))
  }

  const capabilities = {
    provider: providerSelection.providerName,
    providerKey: providerSelection.providerKey,
    providerCloud: providerSelection.cloud,
    cloudFallbackEnabled: providerSelection.cloudFallbackEnabled,
    mcpServers: mcpConfig.serverNames,
    peerBridge: { enabled: true, peerName: opts.peerName ?? 'peer' },
    agora: { enabled: Boolean(agora) },
    kgNotifications: { enabled: opts.enableKgNotifications ?? true },
  }

  const config: TanrenConfig = {
    identity: opts.identity ?? './soul.md',
    memoryDir,
    searchPaths: opts.searchPaths,
    skillsDir: opts.skillsDir,
    perceptionPlugins,
    actions: [...builtinActions, ...peerBridge.actions, ...(agora?.actions ?? []), ...(opts.extraActions ?? [])],
    llm: providerSelection.provider,
    hooks: [
      ...peerBridge.hooks,
      createAutoVerifyHook(opts.verifyCommand ?? 'npx tsc --noEmit'),
      createClaimVerificationHook(),
      ...(opts.extraHooks ?? []),
    ],
    gates: [
      createOutputGate(3),
      createAnalysisWithoutActionGate(2),
      createProductivityGate(3),
      createSymptomFixGate(5),
      ...(opts.extraGates ?? []),
    ],
    feedbackRounds: opts.feedbackRounds ?? 5,
    toolDegradation: false,
    tickInterval: opts.tickInterval ?? 300_000,
  }

  return {
    config,
    peerBridge,
    agora,
    providerSelection,
    mcpConfig,
    capabilities,
    health: () => ({
      mode,
      ...capabilities,
      usage: readUsageSummary(join(memoryDir, 'state')),
    }),
  }
}

function createTickHistoryPlugin(memoryDir: string): PerceptionPlugin {
  return {
    name: 'tick-history',
    category: 'self-awareness',
    fn: () => {
      const journalPath = join(memoryDir, 'journal', 'ticks.jsonl')
      if (!existsSync(journalPath)) return '(no tick history - this may be your first tick)'
      const lines = readFileSync(journalPath, 'utf-8').trim().split('\n').filter(Boolean)
      const recent = lines.slice(-5)
      return `Your last ${recent.length} ticks:\n${recent.map(l => {
        try {
          const t = JSON.parse(l) as { t?: string; actions?: Array<{ type: string }>; observation?: { quality?: number } }
          const date = t.t ? new Date(t.t).toISOString() : '?'
          const actions = t.actions?.map(a => a.type).join(', ') || 'none'
          return `- [${date}] actions: ${actions} | quality: ${t.observation?.quality ?? '?'}`
        } catch {
          return '- (parse error)'
        }
      }).join('\n')}`
    },
  }
}
