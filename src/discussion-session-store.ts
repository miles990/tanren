import type { AgentChatResult } from './chat-client.js'
import type { KgDiscussion, KgDiscussionClient } from './kg-discussion-client.js'

export interface DiscussionMessage {
  role: 'user' | 'agent'
  content: string
  timestamp: string
  durationMs?: number
  quality?: number
}

export interface DiscussionSession {
  id: string
  topic: string
  namespace: 'conversation' | 'discussion'
  agentSessionId?: string
  messages: DiscussionMessage[]
  streaming: boolean
  streamBuffer: string
  loaded: boolean
  loading: boolean
}

export interface DiscussionSessionStoreOptions {
  kg: KgDiscussionClient
  chat: (text: string, sessionId: string | undefined, onChunk: (chunk: string) => void) => Promise<AgentChatResult>
  loadLocalSessions: () => Record<string, string>
  saveLocalSession: (kgId: string, agentSessionId: string) => void
  userSourceAgent?: string
  agentSourceAgent?: string
  now?: () => string
}

export function createDiscussionSessionStore(opts: DiscussionSessionStoreOptions) {
  let sessions: DiscussionSession[] = []
  let currentId: string | null = null
  const listeners = new Set<() => void>()
  const userSource = opts.userSourceAgent ?? 'user'
  const agentSource = opts.agentSourceAgent ?? 'agent'
  const now = opts.now ?? (() => new Date().toISOString())

  function emit() { for (const listener of listeners) listener() }
  function getState() { return { sessions, currentId, current: sessions.find(s => s.id === currentId) ?? null } }
  function setCurrentId(id: string | null) { currentId = id; emit() }
  function updateSession(id: string, updater: (s: DiscussionSession) => DiscussionSession) {
    sessions = sessions.map(s => s.id === id ? updater(s) : s)
    emit()
  }
  function kgToSession(d: KgDiscussion, localSessions: Record<string, string>): DiscussionSession {
    return {
      id: d.id,
      topic: d.topic,
      namespace: d.namespace as 'conversation' | 'discussion',
      agentSessionId: localSessions[d.id],
      messages: (d.positions ?? []).map(p => ({
        role: p.source_agent === agentSource ? 'agent' : 'user',
        content: p.description,
        timestamp: p.created_at,
      })),
      streaming: false,
      streamBuffer: '',
      loaded: false,
      loading: false,
    }
  }
  function todayString() { return new Date().toISOString().slice(0, 10) }
  function defaultCurrentId(items: DiscussionSession[]): string | null {
    const today = todayString()
    return items.find(s => s.namespace === 'conversation' && s.topic === today)?.id ?? items[0]?.id ?? null
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getState,
    setCurrentId,
    async reload(): Promise<void> {
      const local = opts.loadLocalSessions()
      const [convRaw, discRaw] = await Promise.all([opts.kg.listDiscussions('conversation'), opts.kg.listDiscussions('discussion')])
      const conversations = convRaw.map(d => kgToSession(d, local)).sort((a, b) => b.topic.localeCompare(a.topic))
      const discussions = discRaw.map(d => ({ session: kgToSession(d, local), created_at: d.created_at })).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(x => x.session)
      sessions = [...conversations, ...discussions]
      if (!currentId || !sessions.some(s => s.id === currentId)) currentId = defaultCurrentId(sessions)
      emit()
    },
    async ensureTodayConversation(): Promise<DiscussionSession> {
      const today = todayString()
      const local = opts.loadLocalSessions()
      const existing = (await opts.kg.listDiscussions('conversation')).find(d => d.topic === today)
      const session = kgToSession(existing ?? await opts.kg.createDiscussion(today, 'conversation'), local)
      if (!sessions.some(s => s.id === session.id)) sessions = [session, ...sessions]
      currentId ??= session.id
      emit()
      return session
    },
    async createDiscussion(topic: string): Promise<DiscussionSession> {
      const session = kgToSession(await opts.kg.createDiscussion(topic, 'discussion'), opts.loadLocalSessions())
      sessions = [...sessions.filter(s => s.namespace === 'conversation'), session, ...sessions.filter(s => s.namespace === 'discussion')]
      currentId = session.id
      emit()
      return session
    },
    async closeSession(id: string): Promise<void> {
      await opts.kg.closeDiscussion(id)
      sessions = sessions.filter(s => s.id !== id)
      if (currentId === id) currentId = null
      emit()
    },
    upgradeToDiscussion(id: string, newTopic: string): void {
      updateSession(id, s => ({ ...s, namespace: 'discussion', topic: newTopic }))
    },
    async loadMessages(id: string): Promise<void> {
      updateSession(id, s => ({ ...s, loading: true }))
      try {
        const kg = await opts.kg.getDiscussion(id)
        const messages = (kg.positions ?? []).map(p => ({ role: p.source_agent === agentSource ? 'agent' as const : 'user' as const, content: p.description, timestamp: p.created_at }))
        updateSession(id, s => ({ ...s, messages, loaded: true, loading: false }))
      } catch (err) {
        updateSession(id, s => ({ ...s, loading: false }))
        throw err
      }
    },
    async sendMessage(session: DiscussionSession, text: string): Promise<void> {
      const userMsg: DiscussionMessage = { role: 'user', content: text, timestamp: now() }
      updateSession(session.id, s => ({ ...s, messages: [...s.messages, userMsg], streaming: true, streamBuffer: '', loaded: true }))
      opts.kg.addPosition(session.id, text, userSource).catch(() => {})
      try {
        const result = await opts.chat(text, session.agentSessionId, chunk => updateSession(session.id, s => ({ ...s, streamBuffer: s.streamBuffer + chunk })))
        const agentMsg: DiscussionMessage = { role: 'agent', content: result.response, timestamp: now(), durationMs: result.durationMs, quality: result.quality }
        opts.kg.addPosition(session.id, result.response, agentSource).catch(() => {})
        if (result.sessionId) opts.saveLocalSession(session.id, result.sessionId)
        updateSession(session.id, s => ({ ...s, messages: [...s.messages, agentMsg], streaming: false, streamBuffer: '', agentSessionId: result.sessionId ?? s.agentSessionId }))
      } catch (err) {
        updateSession(session.id, s => ({ ...s, streaming: false, streamBuffer: '' }))
        throw err
      }
    },
  }
}

