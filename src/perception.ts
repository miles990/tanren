/**
 * Tanren — Perception Module
 *
 * Plugin-based environment sensing with tiered injection (virtual memory model).
 *
 * T1 (full inject): small, decision-critical — always loaded
 * T2 (index + auto-expand): large but important — index always, detail if budget allows
 * T3 (index only): reference material — index only, agent queries manually
 *
 * Budget scheduling: T1 first, then T2 sorted by priority (expandCost ascending), T3 last.
 */

import type { PerceptionPlugin, PerceptionTier } from './types.js'

interface PluginState {
  plugin: PerceptionPlugin
  lastRun: number
  cachedOutput: string
  cachedIndex: string
}

export interface PerceiveOptions {
  categories?: string[]
  contextBudget?: number
  expandSections?: string[]
}

export interface PerceptionSystem {
  register(plugin: PerceptionPlugin): void
  perceive(options?: PerceiveOptions): Promise<string>
  getPluginNames(): string[]
}

export function createPerception(
  plugins: PerceptionPlugin[] = [],
): PerceptionSystem {
  const states: PluginState[] = plugins.map((p) => ({
    plugin: p,
    lastRun: 0,
    cachedOutput: '',
    cachedIndex: '',
  }))

  return {
    register(plugin) {
      states.push({ plugin, lastRun: 0, cachedOutput: '', cachedIndex: '' })
    },

    getPluginNames() {
      return states.map(s => s.plugin.name)
    },

    async perceive(options?: PerceiveOptions) {
      const now = Date.now()
      const categoryFilter = options?.categories?.length ? new Set(options.categories) : null
      const budget = options?.contextBudget ?? Infinity

      // Phase 1: Gather all plugins (full output for T1, index for T2/T3)
      await Promise.all(
        states.map(async (state) => {
          const interval = state.plugin.interval ?? 0
          const stale = now - state.lastRun >= interval
          if (!stale) return

          const tier = state.plugin.tier ?? 1
          try {
            if (tier === 1 || !state.plugin.gatherIndex) {
              state.cachedOutput = await state.plugin.fn()
            } else {
              state.cachedIndex = await state.plugin.gatherIndex()
              state.cachedOutput = ''
            }
            state.lastRun = now
          } catch (err) {
            const msg = `[error: ${err instanceof Error ? err.message : String(err)}]`
            if (tier === 1) state.cachedOutput = msg
            else state.cachedIndex = msg
            state.lastRun = now
          }
        }),
      )

      // Phase 2: Tiered assembly with budget
      const t1States: PluginState[] = []
      const t2States: PluginState[] = []
      const t3States: PluginState[] = []

      for (const state of states) {
        if (categoryFilter && !categoryFilter.has(state.plugin.category ?? 'environment')) continue
        const tier = state.plugin.tier ?? 1
        if (tier === 1) t1States.push(state)
        else if (tier === 2) t2States.push(state)
        else t3States.push(state)
      }

      // Sort T2 by expandCost ascending (cheapest first = most likely to fit)
      t2States.sort((a, b) => (a.plugin.expandCost ?? 1000) - (b.plugin.expandCost ?? 1000))
      const forceExpand = new Set(options?.expandSections ?? [])

      let charCount = 0
      const byCategory = new Map<string, string[]>()

      const addSection = (state: PluginState, content: string) => {
        if (!content) return
        const cat = state.plugin.category ?? 'environment'
        if (!byCategory.has(cat)) byCategory.set(cat, [])
        byCategory.get(cat)!.push(
          `<${state.plugin.name}>\n${content}\n</${state.plugin.name}>`,
        )
        charCount += content.length
      }

      // T1: always full inject
      for (const state of t1States) {
        addSection(state, state.cachedOutput)
      }

      // T2: index always, auto-expand if budget allows or forced by previous tick's expand action
      for (const state of t2States) {
        const indexContent = state.cachedIndex || state.cachedOutput
        if (!indexContent) continue

        const forced = forceExpand.has(state.plugin.name)
        const expandCost = state.plugin.expandCost ?? 1000
        if ((forced || charCount + expandCost < budget) && state.plugin.expand) {
          try {
            const expanded = await state.plugin.expand()
            addSection(state, expanded)
          } catch {
            addSection(state, indexContent)
          }
        } else if (charCount + expandCost < budget && state.cachedOutput) {
          addSection(state, state.cachedOutput)
        } else {
          addSection(state, indexContent)
        }
      }

      // T3: index only
      for (const state of t3States) {
        const indexContent = state.cachedIndex || state.cachedOutput
        if (indexContent && charCount + indexContent.length < budget) {
          addSection(state, indexContent)
        }
      }

      // Assemble by category
      const sections: string[] = []
      for (const [category, outputs] of byCategory) {
        sections.push(`<${category}>\n${outputs.join('\n')}\n</${category}>`)
      }

      return sections.join('\n\n')
    },
  }
}
