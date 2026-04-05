/**
 * Tanren — Hook System
 *
 * Event-driven automation. Hooks fire at lifecycle points and can
 * inject follow-up actions — automating mechanical patterns.
 *
 * Claude Code pattern: hooks automate repetitive sequences so the
 * agent's cognitive budget goes to thinking, not bookkeeping.
 *
 * Example: auto-clear-inbox after respond (Akari's 96% repetitive pattern)
 */

import type { Action } from './types.js'

export type HookPhase = 'preTick' | 'postTick' | 'postAction'

export interface Hook {
  name: string
  phase: HookPhase
  /** For postAction: only fire after this action type */
  actionType?: string
  /** Return actions to auto-execute, or void for observation-only */
  handler: (context: HookContext) => Action[] | void
}

export interface HookContext {
  tickCount: number
  /** The action that just completed (postAction only) */
  action?: Action
  /** Result of the action (postAction only) */
  result?: string
  /** All actions executed so far in this tick */
  allActions: Action[]
}

export function createHookSystem(hooks: Hook[] = []) {
  function run(phase: HookPhase, context: HookContext, actionType?: string): Action[] {
    const injected: Action[] = []

    for (const hook of hooks) {
      if (hook.phase !== phase) continue
      if (hook.actionType && hook.actionType !== actionType) continue

      try {
        const result = hook.handler(context)
        if (result && result.length > 0) {
          injected.push(...result)
        }
      } catch (err) {
        console.error(`[tanren] Hook ${hook.name} failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    return injected
  }

  return { run }
}

/** Built-in hooks — common patterns that most agents need */
export const builtinHooks: Hook[] = [
  {
    // Akari's #1 pain: respond → clear-inbox is 96% repetitive
    name: 'auto-clear-inbox',
    phase: 'postAction',
    actionType: 'respond',
    handler: (ctx) => {
      // Auto-clear inbox after responding (if inbox action exists and hasn't been called yet)
      const alreadyCleared = ctx.allActions.some(a => a.type === 'clear-inbox')
      if (alreadyCleared) return
      return [{ type: 'clear-inbox', content: '', raw: '', input: {} }]
    },
  },
]
