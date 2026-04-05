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
      const alreadyCleared = ctx.allActions.some(a => a.type === 'clear-inbox')
      if (alreadyCleared) return
      return [{ type: 'clear-inbox', content: '', raw: '', input: {} }]
    },
  },
]

/**
 * Auto-verify hook for TypeScript files.
 * Claude Code pattern: don't ASK the model to verify, MAKE the framework verify.
 * After edit/write on .ts files, auto-run build and return errors as tool result.
 */
export function createAutoVerifyHook(buildCommand = 'npx tsc --noEmit'): Hook {
  return {
    name: 'auto-verify-ts',
    phase: 'postAction',
    handler: (ctx) => {
      const action = ctx.action
      if (!action) return
      // Only fire for edit/write actions on .ts files
      if (action.type !== 'edit' && action.type !== 'write') return
      const path = (action.input?.path as string) ?? ''
      if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return

      // Inject a shell action to run build verification
      return [{
        type: 'shell',
        content: buildCommand,
        raw: buildCommand,
        input: { command: buildCommand },
      }]
    },
  }
}
