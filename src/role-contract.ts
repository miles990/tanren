import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PerceptionPlugin } from './types.js'

export interface RoleContractPluginOptions {
  rolesPath?: string
  memoryDir?: string
  interval?: number
  name?: string
}

export function createRoleContractPlugin(opts: RoleContractPluginOptions = {}): PerceptionPlugin {
  const memoryDir = opts.memoryDir ?? 'memory'
  const rolesPath = opts.rolesPath ?? join(memoryDir, 'roles.md')
  return {
    name: opts.name ?? 'role-contract',
    category: 'self-awareness',
    interval: opts.interval ?? 600_000,
    fn: () => {
      if (!existsSync(rolesPath)) return ''
      const content = readFileSync(rolesPath, 'utf-8').trim()
      if (!content) return ''
      return `<role-contract>\n${content}\n</role-contract>`
    },
  }
}
