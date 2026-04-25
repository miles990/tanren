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
  /** Results parallel to allActions (postAction only). Use for cross-checking
   *  claims in later actions against earlier action outcomes. */
  allResults?: string[]
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
 * Claim Verification hook — fires postAction on respond.
 *
 * Catches "pre-committed respond" drift: the LLM claims completed work
 * ("已 X", "posted Y", "wrote Z") in a respond action whose content was
 * synthesized in the same pass as the http_request actions. If the http_request
 * results show the underlying call failed (404, 5xx) or never happened, the
 * respond claim is unverified.
 *
 * The hook injects a corrective `respond` (which overwrites the prior one,
 * per Tanren's "later respond overwrites earlier" rule) noting the mismatch.
 *
 * Patterns detected (case-insensitive substring match):
 *   - 已 + (POST|發|寫入|posted|wrote|created|sent|published)
 *   - posted to / wrote to / I have written / I have posted
 * If any of these appear in respond content AND no POST/PUT/PATCH in
 * allResults returned 2xx, the hook flags drift.
 */
export function createClaimVerificationHook(): Hook {
  const CLAIM_PATTERNS = [
    /已[^\s]{0,2}(POST|發|寫入|貼|送出|published|created|更新|加入|回覆|提交)/i,
    /已經(更新|加入|回覆|送出|提交|寫入|貼|發)/i,
    /(I (have )?)?(posted|wrote|created|sent|published|saved|submitted|added|updated|replied) to/i,
    /(已|是)?在 ?(KG|knowledge graph|discussion).*(發|posted|貼)/i,
    /Position posted/i,
    /successfully (posted|wrote|created|sent|saved|submitted|added|updated|replied)/i,
    /回覆了 ?(KG|discussion|message)/i,
  ]
  const SUCCESS_RE = /\[HTTP\s+20\d\b/

  return {
    name: 'claim-verification',
    phase: 'postAction',
    actionType: 'respond',
    handler: (ctx) => {
      const action = ctx.action
      if (!action) return
      const content =
        (action.input?.content as string | undefined) ??
        action.content ?? ''
      if (!content) return

      // Did respond claim a write/POST happened?
      const claimedAction = CLAIM_PATTERNS.some(re => re.test(content))
      if (!claimedAction) return

      // Inspect prior http_request results (if any). Treat 2xx as success.
      const results = ctx.allResults ?? []
      const httpRequestIdxs = ctx.allActions
        .map((a, i) => (a.type === 'http_request' ? i : -1))
        .filter(i => i >= 0)
      const anyHttpSuccess = httpRequestIdxs.some(i => {
        const r = results[i] ?? ''
        return SUCCESS_RE.test(r)
      })

      if (anyHttpSuccess) return // claim is plausibly grounded

      // Drift detected: respond claims write/POST but no http_request returned 2xx
      const httpFailures = httpRequestIdxs
        .map(i => (results[i] ?? '').slice(0, 200))
        .filter(r => r.length > 0)
        .slice(0, 3)
      const failureSummary =
        httpFailures.length > 0
          ? `\nObserved http_request results (first 3, truncated):\n${httpFailures.join('\n---\n')}`
          : '\nNo http_request actions executed in this tick.'

      const corrective =
        `[claim-verification] CORRECTION: my prior respond claimed I had completed an external write/POST, but no http_request in this tick returned 2xx. The original claim is RETRACTED.${failureSummary}\n\nThis correction is auto-injected by Tanren's claim-verification hook. The drift was: pre-committed respond text generated in the same pass as the http_request actions, before any of them ran. Next tick: re-execute the intended write and verify the response status before claiming success.`

      return [
        {
          type: 'respond',
          content: corrective,
          raw: corrective,
          input: { content: corrective },
        },
      ]
    },
  }
}

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
