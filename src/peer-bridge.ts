import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionHandler, PerceptionPlugin, TickResult } from './types.js'
import type { Hook } from './hooks.js'
import { createPeerMessageActions, createPeerMessagePlugin, type PeerMessageOptions } from './memory-plugins.js'

export interface PeerBridgeOptions extends PeerMessageOptions {
  registryText?: string
  autoClearAfterRespond?: boolean
}

export interface PeerBridge {
  perceptionPlugins: PerceptionPlugin[]
  actions: ActionHandler[]
  hooks: Hook[]
  onBeforeChat(from: string, text: string): void
  applyWriteBackFallback(result: TickResult): boolean
}

export function createPeerBridge(opts: PeerBridgeOptions = {}): PeerBridge {
  const messagesDir = opts.messagesDir ?? join(process.cwd(), 'messages')
  const peerName = opts.peerName ?? 'peer'
  const fromPeerFile = opts.fromPeerFile ?? `from-${peerName}.md`
  const toPeerFile = opts.toPeerFile ?? `to-${peerName}.md`
  const inboundPath = join(messagesDir, fromPeerFile)
  const outboundPath = join(messagesDir, toPeerFile)
  const autoClear = opts.autoClearAfterRespond ?? true

  const perceptionPlugins = [
    createPeerMessagePlugin({ ...opts, messagesDir, peerName, fromPeerFile, toPeerFile }),
    ...(opts.registryText
      ? [{
          name: 'agent-registry',
          category: 'self-awareness',
          interval: 600_000,
          fn: () => opts.registryText ?? '',
        } satisfies PerceptionPlugin]
      : []),
  ]

  const hooks: Hook[] = autoClear
    ? [{
        name: `auto-clear-${peerName}-inbox`,
        phase: 'postAction',
        actionType: 'respond',
        handler: (ctx) => {
          if (ctx.allActions.some(a => a.type === 'clear-inbox')) return
          return [{ type: 'clear-inbox', content: '', raw: '', input: {} }]
        },
      }]
    : []

  return {
    perceptionPlugins,
    actions: createPeerMessageActions({ ...opts, messagesDir, peerName, fromPeerFile, toPeerFile }),
    hooks,
    onBeforeChat(from: string, text: string) {
      mkdirSync(messagesDir, { recursive: true })
      writeFileSync(outboundPath, '', 'utf-8')
      writeFileSync(inboundPath, `# From ${from}\n\n${text}\n`, 'utf-8')
    },
    applyWriteBackFallback(result: TickResult): boolean {
      const hadMessage = existsSync(inboundPath) && readFileSync(inboundPath, 'utf-8').trim().length > 0
      const hadRespondAction = result.actions.some(a => a.type === 'respond')
      if (!hadMessage || hadRespondAction || result.thought.length <= 200) return false
      mkdirSync(messagesDir, { recursive: true })
      const header = '<!-- auto-extracted: LLM produced thought but no respond action -->\n\n'
      writeFileSync(outboundPath, header + result.thought, 'utf-8')
      return true
    },
  }
}
