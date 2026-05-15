import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionHandler, PerceptionPlugin } from './types.js'

export interface InboxPluginOptions {
  inboxDir?: string
  category?: string
  name?: string
}

export interface OutboxHistoryPluginOptions {
  outboxDir?: string
  limit?: number
  previewChars?: number
  category?: string
  name?: string
}

export interface PeerMessageOptions {
  messagesDir?: string
  fromPeerFile?: string
  toPeerFile?: string
  peerName?: string
}

export function createInboxPlugin(opts: InboxPluginOptions = {}): PerceptionPlugin {
  const inboxDir = opts.inboxDir ?? join(process.cwd(), 'memory', 'inbox')
  return {
    name: opts.name ?? 'inbox',
    category: opts.category ?? 'tasks',
    fn: () => {
      if (!existsSync(inboxDir)) return '<inbox>No pending tasks.</inbox>'
      const files = readdirSync(inboxDir).filter(f => f.endsWith('.md')).sort()
      if (files.length === 0) return '<inbox>No pending tasks.</inbox>'
      const tasks = files.map(f => `<inbox-task file="${f}">\n${readFileSync(join(inboxDir, f), 'utf-8')}\n</inbox-task>`)
      return `<inbox>\n${tasks.join('\n\n')}\n</inbox>`
    },
  }
}

export function createOutboxHistoryPlugin(opts: OutboxHistoryPluginOptions = {}): PerceptionPlugin {
  const outboxDir = opts.outboxDir ?? join(process.cwd(), 'memory', 'outbox')
  const limit = opts.limit ?? 3
  const previewChars = opts.previewChars ?? 500
  return {
    name: opts.name ?? 'outbox-history',
    category: opts.category ?? 'context',
    fn: () => {
      if (!existsSync(outboxDir)) return ''
      const files = readdirSync(outboxDir).filter(f => f.endsWith('.md')).sort().slice(-limit)
      if (files.length === 0) return ''
      const briefs = files.map(f => `<previous-brief file="${f}">\n${readFileSync(join(outboxDir, f), 'utf-8').slice(0, previewChars)}\n</previous-brief>`)
      return `<outbox-history>\n${briefs.join('\n')}\n</outbox-history>`
    },
  }
}

export function createPeerMessagePlugin(opts: PeerMessageOptions = {}): PerceptionPlugin {
  const messagesDir = opts.messagesDir ?? join(process.cwd(), 'messages')
  const peerName = opts.peerName ?? 'peer'
  const fromPeerFile = opts.fromPeerFile ?? `from-${peerName}.md`
  return {
    name: `${peerName}-message`,
    category: 'input',
    fn: () => {
      const msgPath = join(messagesDir, fromPeerFile)
      if (!existsSync(msgPath)) return ''
      const msg = readFileSync(msgPath, 'utf-8').trim()
      if (!msg) return ''
      return `<peer-message from="${peerName}">\n${msg}\n</peer-message>\n\nRespond with the respond action, then use clear-inbox to mark it read.`
    },
  }
}

export function createPeerMessageActions(opts: PeerMessageOptions = {}): ActionHandler[] {
  const messagesDir = opts.messagesDir ?? join(process.cwd(), 'messages')
  const peerName = opts.peerName ?? 'peer'
  const toPeerFile = opts.toPeerFile ?? `to-${peerName}.md`
  const fromPeerFile = opts.fromPeerFile ?? `from-${peerName}.md`
  return [
    {
      type: 'respond',
      description: `Send a response to ${peerName}.`,
      toolSchema: {
        properties: { content: { type: 'string', description: `Response message to ${peerName}` } },
        required: ['content'],
      },
      async execute(action) {
        const content = (action.input?.content as string) ?? action.content
        mkdirSync(messagesDir, { recursive: true })
        writeFileSync(join(messagesDir, toPeerFile), content, 'utf-8')
        return `Response written to ${join(messagesDir, toPeerFile)}`
      },
    },
    {
      type: 'clear-inbox',
      description: `Clear ${peerName}'s inbound message after responding.`,
      toolSchema: { properties: {} },
      async execute() {
        const inboxPath = join(messagesDir, fromPeerFile)
        if (existsSync(inboxPath)) writeFileSync(inboxPath, '', 'utf-8')
        return 'Inbox cleared.'
      },
    },
  ]
}
