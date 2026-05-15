import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_AGENT_TOOLS = [
  'agent_chat',
  'agent_ask',
  'agent_discuss',
  'agent_status',
  'agent_context',
  'agent_logs',
  'agent_memory_search',
  'agent_read_messages',
  'agent_activity',
  'agent_feature_toggle',
  'agent_get_mode',
  'agent_set_mode',
  'agent_loop_pause',
  'agent_loop_resume',
  'agent_loop_trigger',
]

export interface McpConfigLoadOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  envKey?: string
  defaultPath?: string
  agentTools?: string[]
  logger?: Pick<Console, 'log' | 'warn'>
}

export interface McpConfigSelection {
  loaded: boolean
  path: string
  mcpServers?: Record<string, unknown>
  mcpToolNames: string[]
  serverNames: string[]
  error?: string
}

export function loadMcpServersFromConfig(opts: McpConfigLoadOptions = {}): McpConfigSelection {
  const env = opts.env ?? process.env
  const path = opts.path ?? env[opts.envKey ?? 'KURO_MCP_CONFIG'] ?? opts.defaultPath ?? ''
  const agentTools = opts.agentTools ?? DEFAULT_AGENT_TOOLS
  if (!path || !existsSync(path)) return { loaded: false, path, mcpToolNames: [], serverNames: [] }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: Record<string, Record<string, unknown>> }
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') {
      return { loaded: false, path, mcpToolNames: [], serverNames: [], error: 'mcpServers missing' }
    }

    const mcpServers: Record<string, unknown> = {}
    const mcpToolNames: string[] = []
    for (const [name, cfg] of Object.entries(raw.mcpServers)) {
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
      const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : undefined
      const resolvedArgs = cwd
        ? args.map(a => (a && !a.startsWith('/') && !a.startsWith('-') ? join(cwd, a) : a))
        : args
      mcpServers[name] = {
        type: 'stdio',
        command: cfg.command,
        args: resolvedArgs,
        ...(cwd ? { cwd } : {}),
        ...(cfg.env ? { env: cfg.env } : {}),
      }
      for (const tool of agentTools) mcpToolNames.push(`mcp__${name}__${tool}`)
    }

    const serverNames = Object.keys(mcpServers)
    opts.logger?.log?.(`[tanren] Loaded MCP config from ${path}: ${serverNames.join(', ')}`)
    return { loaded: true, path, mcpServers, mcpToolNames, serverNames }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    opts.logger?.warn?.(`[tanren] MCP config load failed at ${path}: ${error}`)
    return { loaded: false, path, mcpToolNames: [], serverNames: [], error }
  }
}
