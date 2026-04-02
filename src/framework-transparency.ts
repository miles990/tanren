/**
 * Tanren — Framework Transparency
 *
 * Makes ALL internal boundaries and state visible to the agent.
 * The agent should see truth, including the framework's own mechanics.
 *
 * "所有的內部邊界和內部資訊對 agent 都要是可見的"
 */

import { resolve, basename } from 'node:path'
import type { PerceptionPlugin } from './types.js'

interface TransparencyConfig {
  memoryDir: string
  workDir: string
  tickCount: () => number
  isRunning: () => boolean
  complexity?: () => string
  contextMode?: () => string
  feedbackRounds?: () => number
}

export function createTransparencyPlugin(config: TransparencyConfig): PerceptionPlugin {
  return {
    name: 'framework-state',
    category: 'system',
    fn: () => {
      const lines = ['<framework-state>']

      // File system boundaries — agent knows where paths resolve to
      lines.push(`  memoryDir: ${resolve(config.memoryDir)}`)
      lines.push(`  memoryDirName: ${basename(resolve(config.memoryDir))}`)
      lines.push(`  workDir: ${resolve(config.workDir)}`)
      lines.push(`  NOTE: write/read paths are relative to memoryDir. "plans/x.md" → ${resolve(config.memoryDir, 'plans/x.md')}`)

      // Tick state
      lines.push(`  tick: ${config.tickCount()}`)
      lines.push(`  running: ${config.isRunning()}`)

      // Classification results — agent sees how framework categorized the input
      if (config.complexity) {
        lines.push(`  complexity: ${config.complexity()}`)
      }
      if (config.contextMode) {
        lines.push(`  contextMode: ${config.contextMode()}`)
      }
      if (config.feedbackRounds) {
        lines.push(`  maxFeedbackRounds: ${config.feedbackRounds()}`)
      }

      lines.push('</framework-state>')
      return lines.join('\n')
    },
  }
}
