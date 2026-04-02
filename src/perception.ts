/**
 * Tanren — Perception Module
 *
 * Plugin-based environment sensing. Each plugin returns a string.
 * No built-in plugins — that's user-land.
 */

import type { PerceptionPlugin } from './types.js'

interface PluginState {
  plugin: PerceptionPlugin
  lastRun: number
  cachedOutput: string
}

export interface PerceptionSystem {
  register(plugin: PerceptionPlugin): void
  perceive(): Promise<string>
  getPluginNames(): string[]
}

export function createPerception(
  plugins: PerceptionPlugin[] = [],
): PerceptionSystem {
  const states: PluginState[] = plugins.map((p) => ({
    plugin: p,
    lastRun: 0,
    cachedOutput: '',
  }))

  return {
    register(plugin) {
      states.push({ plugin, lastRun: 0, cachedOutput: '' })
    },

    getPluginNames() {
      return states.map(s => s.plugin.name)
    },

    async perceive() {
      const now = Date.now()
      const sections: string[] = []

      await Promise.all(
        states.map(async (state) => {
          const interval = state.plugin.interval ?? 0 // 0 = every tick
          const stale = now - state.lastRun >= interval

          if (stale) {
            try {
              const output = await state.plugin.fn()
              state.cachedOutput = output
              state.lastRun = now
            } catch (err) {
              state.cachedOutput = `[error: ${err instanceof Error ? err.message : String(err)}]`
              state.lastRun = now
            }
          }
        }),
      )

      // Assemble context grouped by category
      const byCategory = new Map<string, string[]>()
      for (const state of states) {
        if (!state.cachedOutput) continue
        const cat = state.plugin.category ?? 'environment'
        if (!byCategory.has(cat)) byCategory.set(cat, [])
        byCategory.get(cat)!.push(
          `<${state.plugin.name}>\n${state.cachedOutput}\n</${state.plugin.name}>`,
        )
      }

      for (const [category, outputs] of byCategory) {
        sections.push(`<${category}>\n${outputs.join('\n')}\n</${category}>`)
      }

      return sections.join('\n\n')
    },
  }
}
