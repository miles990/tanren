import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export interface KgDiscussionClientOptions {
  baseUrl?: string
  apiKey?: string
  sourceAgent?: string
}

export interface KgDiscussion {
  id: string
  topic: string
  namespace: string
  status: string
  created_at: string
  positions?: KgPosition[]
}

export interface KgPosition {
  id: string
  name: string
  description: string
  source_agent: string
  created_at: string
}

export interface KgDiscussionClient {
  listDiscussions(namespace: string): Promise<KgDiscussion[]>
  createDiscussion(topic: string, namespace: string): Promise<KgDiscussion>
  getDiscussion(id: string): Promise<KgDiscussion>
  closeDiscussion(id: string): Promise<void>
  addPosition(discussionId: string, content: string, sourceAgent?: string): Promise<void>
}

export function createKgDiscussionClient(opts: KgDiscussionClientOptions = {}): KgDiscussionClient {
  const baseUrl = (opts.baseUrl ?? process.env.KG_URL ?? 'http://localhost:3300').replace(/\/$/, '')
  const apiKey = opts.apiKey ?? process.env.KG_API_KEY ?? ''
  const defaultSourceAgent = opts.sourceAgent ?? 'agent'

  function headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) }
  }

  return {
    async listDiscussions(namespace: string): Promise<KgDiscussion[]> {
      const res = await fetch(`${baseUrl}/api/discussions?namespace=${encodeURIComponent(namespace)}`, { headers: headers() })
      if (!res.ok) throw new Error(`KG listDiscussions failed: ${res.status} ${res.statusText}`)
      const data = await res.json() as { discussions: Array<{ id: string; topic: string; namespace: string; status: string; created_at: string }> }
      return data.discussions.map(d => ({ ...d, positions: [] }))
    },
    async createDiscussion(topic: string, namespace: string): Promise<KgDiscussion> {
      const res = await fetch(`${baseUrl}/api/discussion`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ topic, namespace, source_agent: defaultSourceAgent }),
      })
      if (!res.ok) throw new Error(`KG createDiscussion failed: ${res.status} ${res.statusText}`)
      const data = await res.json() as { discussion_id: string; topic: string; namespace: string }
      return { id: data.discussion_id, topic: data.topic, namespace: data.namespace, status: 'open', created_at: new Date().toISOString(), positions: [] }
    },
    async getDiscussion(id: string): Promise<KgDiscussion> {
      const res = await fetch(`${baseUrl}/api/discussion/${encodeURIComponent(id)}`, { headers: headers() })
      if (!res.ok) throw new Error(`KG getDiscussion failed: ${res.status} ${res.statusText}`)
      const data = await res.json() as {
        discussion_id: string
        topic: string
        namespace: string
        status: string
        created_at: string
        positions?: Array<{ node_id: string; name: string; description: string; source_agent: string; created_at: string }>
      }
      return {
        id: data.discussion_id,
        topic: data.topic,
        namespace: data.namespace,
        status: data.status,
        created_at: data.created_at,
        positions: (data.positions ?? []).map(p => ({
          id: p.node_id,
          name: p.name,
          description: p.description,
          source_agent: p.source_agent,
          created_at: p.created_at,
        })),
      }
    },
    async closeDiscussion(id: string): Promise<void> {
      const res = await fetch(`${baseUrl}/api/discussion/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ source_agent: defaultSourceAgent }),
      })
      if (!res.ok) throw new Error(`KG closeDiscussion failed: ${res.status}`)
    },
    async addPosition(discussionId: string, content: string, sourceAgent = defaultSourceAgent): Promise<void> {
      const res = await fetch(`${baseUrl}/api/discussion/${encodeURIComponent(discussionId)}/position`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ content, source_agent: sourceAgent, stance: 'provides', properties: { role: sourceAgent } }),
      })
      if (!res.ok) throw new Error(`KG addPosition failed: ${res.status} ${res.statusText}`)
    },
  }
}

export function loadLocalSessionMap(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string> } catch { return {} }
}

export function saveLocalSessionMap(path: string, kgId: string, agentSessionId: string): void {
  const sessions = loadLocalSessionMap(path)
  sessions[kgId] = agentSessionId
  writeFileSync(path, JSON.stringify(sessions, null, 2), 'utf-8')
}
