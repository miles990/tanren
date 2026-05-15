import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DotEnvLoadOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  override?: boolean
}

export function loadDotEnvFile(opts: DotEnvLoadOptions = {}): Record<string, string> {
  const env = opts.env ?? process.env
  const path = opts.path ?? '.env'
  const loaded: Record<string, string> = {}
  if (!existsSync(path)) return loaded

  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=\s]+?)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const key = match[1]
    const value = match[2].replace(/^["']|["']$/g, '')
    if (!opts.override && env[key] !== undefined) continue
    env[key] = value
    loaded[key] = value
  }
  return loaded
}

export function readUsageSummary(stateDir = join(process.cwd(), 'memory', 'state')): Record<string, unknown> {
  const path = join(stateDir, 'llm-usage-summary.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
