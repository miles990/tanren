import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionHandler, PerceptionPlugin } from './types.js'

export interface AgoraCollaborationOptions {
  agoraUrl?: string
  stateDir?: string
  agentName?: string
  agentDescription?: string
  interval?: number
  timeoutMs?: number
}

export interface AgoraCollaboration {
  perceptionPlugins: PerceptionPlugin[]
  actions: ActionHandler[]
}

export function createAgoraCollaboration(opts: AgoraCollaborationOptions = {}): AgoraCollaboration {
  const agoraUrl = opts.agoraUrl ?? process.env.AGORA_URL ?? 'http://127.0.0.1:3003'
  const stateDir = opts.stateDir ?? join(process.cwd(), 'agora-state')
  const agentName = opts.agentName ?? 'agent'
  const timeoutMs = opts.timeoutMs ?? 10_000
  mkdirSync(stateDir, { recursive: true })

  const keyFile = join(stateDir, 'api-key.json')
  const cursorFile = join(stateDir, 'cursors.json')
  let apiKey: string | null = null
  let cursors: Record<string, string> = {}
  if (existsSync(keyFile)) { try { apiKey = (JSON.parse(readFileSync(keyFile, 'utf-8')) as { apiKey?: string }).apiKey ?? null } catch {} }
  if (existsSync(cursorFile)) { try { cursors = JSON.parse(readFileSync(cursorFile, 'utf-8')) as Record<string, string> } catch {} }

  async function agoraFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${agoraUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}), ...init?.headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  async function ensureRegistered(): Promise<boolean> {
    if (apiKey) return true
    try {
      const res = await agoraFetch('/agents/register', {
        method: 'POST',
        body: JSON.stringify({
          name: agentName,
          type: 'agent',
          description: opts.agentDescription ?? `${agentName} Tanren agent`,
        }),
      })
      if (!res.ok) return false
      const data = await res.json() as { apiKey: string }
      apiKey = data.apiKey
      writeFileSync(keyFile, JSON.stringify({ apiKey, registeredAt: new Date().toISOString() }))
      return true
    } catch {
      return false
    }
  }

  const perceptionPlugins: PerceptionPlugin[] = [{
    name: 'agora-discussions',
    interval: opts.interval ?? 60_000,
    category: 'input',
    fn: async () => {
      try {
        if (!await ensureRegistered()) return '(Agora: cannot register)'
        const res = await agoraFetch('/discussions')
        if (!res.ok) return '(Agora: service error)'
        const discussions = await res.json() as Array<{ id: string; topic: string; phase: string; messageCount: number }>
        if (discussions.length === 0) return '(Agora: no active discussions)'

        const lines = discussions.map(d => `- [${d.phase}] ${d.topic} (${d.messageCount} msgs)`)
        let mentionCount = 0
        for (const d of discussions) {
          try {
            const since = cursors[d.id] ?? ''
            const qs = since ? `?since=${encodeURIComponent(since)}` : ''
            const msgRes = await agoraFetch(`/discussions/${d.id}/messages${qs}`)
            if (!msgRes.ok) continue
            const msgs = await msgRes.json() as Array<{ id: string; mentions?: string[] }>
            mentionCount += msgs.filter(m => m.mentions?.includes(agentName)).length
            if (msgs.length > 0) cursors[d.id] = msgs.at(-1)!.id
          } catch { /* skip */ }
        }
        writeFileSync(cursorFile, JSON.stringify(cursors))
        return `Agora Discussions:\n${lines.join('\n')}${mentionCount > 0 ? `\n\n${mentionCount} new message(s) mentioning @${agentName} - use agora-post tool to respond` : ''}`
      } catch {
        return '(Agora: service unavailable)'
      }
    },
  }]

  const actions: ActionHandler[] = [{
    type: 'agora-post',
    description: 'Post a message to an Agora discussion.',
    toolSchema: {
      properties: {
        discussion_id: { type: 'string', description: 'Discussion ID' },
        text: { type: 'string', description: 'Message content' },
        reply_to: { type: 'string', description: 'Optional message ID to reply to' },
        mentions: { type: 'string', description: 'Optional comma-separated names to mention' },
      },
      required: ['discussion_id', 'text'],
    },
    async execute(action) {
      if (!await ensureRegistered()) return '[agora-post: cannot register with Agora]'
      const discussionId = action.input?.discussion_id as string
      const text = action.input?.text as string
      const replyTo = action.input?.reply_to as string | undefined
      const mentionsStr = action.input?.mentions as string | undefined
      const mentions = mentionsStr?.split(',').map(s => s.trim()).filter(Boolean)
      try {
        const res = await agoraFetch(`/discussions/${encodeURIComponent(discussionId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text, replyTo, mentions }),
        })
        if (!res.ok) return `[agora-post error: HTTP ${res.status}]`
        const msg = await res.json() as { id: string }
        return `Posted to ${discussionId}: ${msg.id}`
      } catch (err) {
        return `[agora-post error: ${err instanceof Error ? err.message : 'unknown'}]`
      }
    },
  }]

  return { perceptionPlugins, actions }
}
