import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionHandler, PerceptionPlugin } from './types.js'

export interface KgCollaborationOptions {
  kgUrl?: string
  agentId?: string
  namespace?: string
  sourceAgent?: string
  cursorPath?: string
  interval?: number
  timeoutMs?: number
}

export interface KgNotificationDiscussionPluginOptions extends KgCollaborationOptions {
  eventsDir?: string
  processedDir?: string
  maxFiles?: number
}

function readJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> } catch { return {} }
}

function kgBase(opts: KgCollaborationOptions): string {
  return opts.kgUrl ?? process.env.KG_URL ?? 'http://localhost:3300'
}

export function createKgDiscussionPlugin(opts: KgCollaborationOptions = {}): PerceptionPlugin {
  const agentId = opts.agentId ?? 'agent'
  const cursorPath = opts.cursorPath ?? join(process.cwd(), 'memory', 'state', 'kg-cursor.json')
  const timeoutMs = opts.timeoutMs ?? 5_000

  return {
    name: 'knowledge-graph',
    category: 'knowledge',
    interval: opts.interval ?? 300_000,
    fn: async () => {
      const kgUrl = kgBase(opts)
      try {
        const health = await fetch(`${kgUrl}/health`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)) })
        if (!health.ok) return '<knowledge-graph>KG offline</knowledge-graph>'

        const saved = readJson(cursorPath)
        const cursor = typeof saved.cursor === 'number' ? saved.cursor : 0
        const params = new URLSearchParams({
          cursor: String(cursor),
          agent_id: agentId,
          cross_namespace: 'true',
        })
        const syncResp = await fetch(`${kgUrl}/api/sync?${params}`, { signal: AbortSignal.timeout(timeoutMs) })
        if (!syncResp.ok) return '<knowledge-graph>KG sync error</knowledge-graph>'
        const sync = await syncResp.json() as { cursor?: number; events?: Array<Record<string, unknown>> }
        const events = sync.events ?? []

        if ((sync.cursor ?? cursor) > cursor) {
          mkdirSync(join(cursorPath, '..'), { recursive: true })
          writeFileSync(cursorPath, JSON.stringify({ cursor: sync.cursor, updated: new Date().toISOString() }))
        }

        if (events.length === 0) return '<knowledge-graph>No new knowledge since last check.</knowledge-graph>'

        if (events.length > 10) {
          const digestResp = await fetch(`${kgUrl}/api/digest`, { signal: AbortSignal.timeout(timeoutMs) })
          if (digestResp.ok) {
            const digest = await digestResp.json() as { digest?: string }
            return `<knowledge-graph>\n${digest.digest ?? ''}\n</knowledge-graph>`
          }
        }

        const lines = events.map(e => {
          const data = (e.data ?? {}) as Record<string, unknown>
          const name = data.name ?? (typeof e.entity_id === 'string' ? e.entity_id.slice(0, 8) : '?')
          return `- [${String(e.type ?? 'event')}] ${String(name)} (by ${String(e.source_agent ?? 'unknown')})`
        })
        return `<knowledge-graph>\n${events.length} new events:\n${lines.join('\n')}\n</knowledge-graph>`
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return `<knowledge-graph>KG unavailable: ${message}</knowledge-graph>`
      }
    },
  }
}

export function createKgActions(opts: KgCollaborationOptions = {}): ActionHandler[] {
  const agentId = opts.agentId ?? 'agent'
  const namespace = opts.namespace ?? agentId
  const sourceAgent = opts.sourceAgent ?? agentId

  return [
    {
      type: 'kg_publish',
      description: 'Publish a knowledge node to the shared Knowledge Graph.',
      toolSchema: {
        properties: {
          title: { type: 'string', description: 'Short descriptive title' },
          content: { type: 'string', description: 'Knowledge content and evidence' },
          type: { type: 'string', description: 'fact, observation, hypothesis, decision, methodology, lesson, question, claim' },
          confidence: { type: 'number', description: 'Confidence 0.0-1.0' },
        },
        required: ['title', 'content', 'type'],
      },
      async execute(action) {
        const input = action.input ?? {}
        const resp = await fetch(`${kgBase(opts)}/api/write/triple`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: input.title,
            subject_type: input.type ?? 'observation',
            predicate: 'DESCRIBES',
            object: input.content,
            object_type: 'content',
            confidence: input.confidence ?? 0.8,
            source_agent: sourceAgent,
            namespace,
            description: String(input.content ?? '').slice(0, 200),
          }),
        })
        if (!resp.ok) throw new Error(`KG publish failed: ${resp.status}`)
        const result = await resp.json() as { subject_node_id?: string }
        return `Published to KG: ${String(input.title ?? '')} (node: ${result.subject_node_id ?? 'unknown'})`
      },
    },
    {
      type: 'kg_verify',
      description: 'Verify or endorse an existing knowledge node in the Knowledge Graph.',
      toolSchema: {
        properties: {
          node_id: { type: 'string', description: 'Node ID to verify' },
          confidence: { type: 'number', description: 'New confidence level' },
        },
        required: ['node_id'],
      },
      async execute(action) {
        const input = action.input ?? {}
        const resp = await fetch(`${kgBase(opts)}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_id: input.node_id,
            agent_id: agentId,
            confidence: input.confidence ?? 0.9,
          }),
        })
        if (!resp.ok) throw new Error(`KG verify failed: ${resp.status}`)
        return `Verified KG node: ${String(input.node_id ?? '')}`
      },
    },
    {
      type: 'kg_challenge',
      description: 'Challenge or question an existing knowledge node in the Knowledge Graph.',
      toolSchema: {
        properties: {
          node_id: { type: 'string', description: 'Node ID to challenge' },
          reason: { type: 'string', description: 'Why this knowledge is questionable' },
        },
        required: ['node_id', 'reason'],
      },
      async execute(action) {
        const input = action.input ?? {}
        const resp = await fetch(`${kgBase(opts)}/api/challenge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_id: input.node_id,
            agent_id: agentId,
            reason: input.reason,
          }),
        })
        if (!resp.ok) throw new Error(`KG challenge failed: ${resp.status}`)
        return `Challenged KG node: ${String(input.node_id ?? '')}`
      },
    },
    {
      type: 'kg_discuss',
      description: 'Post a position in a Knowledge Graph discussion.',
      toolSchema: {
        properties: {
          discussion_id: { type: 'string', description: 'Discussion ID' },
          position: { type: 'string', description: 'Your position or reply' },
          confidence: { type: 'number', description: 'Confidence 0.0-1.0' },
        },
        required: ['discussion_id', 'position'],
      },
      async execute(action) {
        const input = action.input ?? {}
        const discussionId = encodeURIComponent(String(input.discussion_id ?? ''))
        const resp = await fetch(`${kgBase(opts)}/api/discussion/${discussionId}/position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: agentId,
            position: input.position,
            confidence: input.confidence ?? 0.7,
          }),
        })
        if (!resp.ok) throw new Error(`KG discuss failed: ${resp.status}`)
        return `Posted KG discussion position: ${String(input.discussion_id ?? '')}`
      },
    },
  ]
}

export function createKgCollaboration(opts: KgCollaborationOptions = {}): { perceptionPlugins: PerceptionPlugin[]; actions: ActionHandler[] } {
  return {
    perceptionPlugins: [createKgDiscussionPlugin(opts)],
    actions: createKgActions(opts),
  }
}

export function createKgNotificationDiscussionPlugin(opts: KgNotificationDiscussionPluginOptions = {}): PerceptionPlugin {
  const eventsDir = opts.eventsDir ?? join(process.cwd(), 'memory', 'events', 'pending')
  const processedDir = opts.processedDir ?? join(process.cwd(), 'memory', 'events', 'processed')
  const sourceAgent = opts.sourceAgent ?? opts.agentId ?? 'agent'
  const maxFiles = opts.maxFiles ?? 5
  const timeoutMs = opts.timeoutMs ?? 5_000

  return {
    name: 'kg-discussions',
    interval: opts.interval ?? 30_000,
    category: 'input',
    fn: async () => {
      const parts: string[] = []
      try {
        if (!existsSync(eventsDir)) return ''
        const files = readdirSync(eventsDir).filter(f => f.endsWith('.json') && f.includes('kg-notification'))
        if (files.length === 0) return ''

        const seenDiscussions = new Set<string>()
        for (const file of files.slice(0, maxFiles)) {
          try {
            const eventPath = join(eventsDir, file)
            const evt = JSON.parse(readFileSync(eventPath, 'utf-8')) as { payload?: { discussion_id?: string }; discussion_id?: string }
            const discId = evt.payload?.discussion_id ?? evt.discussion_id
            if (discId) seenDiscussions.add(discId)
            mkdirSync(processedDir, { recursive: true })
            renameSync(eventPath, join(processedDir, file))
          } catch { /* skip bad event */ }
        }

        for (const discId of seenDiscussions) {
          try {
            const res = await fetch(`${kgBase(opts)}/api/discussion/${encodeURIComponent(discId)}`, { signal: AbortSignal.timeout(timeoutMs) })
            if (!res.ok) continue
            const disc = await res.json() as {
              topic: string
              status?: string
              positions: Array<{ source_agent: string; name?: string; description?: string; confidence?: number }>
            }
            if (disc.status === 'closed' || disc.status === 'resolved') continue
            const myPositions = disc.positions.filter(p => p.source_agent === sourceAgent)
            const othersRecent = disc.positions.filter(p => p.source_agent !== sourceAgent).slice(-3)
            if (othersRecent.length === 0) continue

            parts.push('\n### KG Discussion Awaiting Your Response')
            parts.push(`**Topic**: ${disc.topic}`)
            parts.push(`**ID**: ${discId}`)
            parts.push(`**Your positions so far**: ${myPositions.length}`)
            parts.push('**Recent positions from others**:')
            for (const p of othersRecent) parts.push(`  - [${p.source_agent}] "${p.name ?? 'position'}": ${(p.description ?? '').slice(0, 400)}`)
            parts.push(`\n**ACTION REQUIRED**: Use kg_discuss with discussion_id="${discId}".`)
          } catch { /* skip */ }
        }
      } catch { /* skip */ }

      return parts.join('\n')
    },
  }
}
