export interface AgentChatResult {
  response: string
  sessionId?: string
  durationMs?: number
  quality?: number
}

export interface ChatStreamOptions {
  baseUrl?: string
  from?: string
  sessionId?: string
  discussionId?: string
  onChunk?: (chunk: string) => void
}

export async function chatStream(text: string, opts: ChatStreamOptions = {}): Promise<AgentChatResult> {
  const baseUrl = opts.baseUrl ?? process.env.AKARI_URL ?? process.env.TANREN_AGENT_URL ?? 'http://localhost:3000'
  const sentAt = Date.now()
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: opts.from ?? 'user',
      text,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.discussionId ? { discussionId: opts.discussionId } : {}),
    }),
  })

  if (res.status === 429) throw new Error('Agent is busy, try again later')
  if (!res.ok) throw new Error(`Agent HTTP error: ${res.status}`)
  if (!res.body) throw new Error('Agent response has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEventType = ''
  const result: AgentChatResult = { response: '' }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEventType = line.slice('event: '.length).trim()
        continue
      }
      if (!line.startsWith('data: ')) continue
      const raw = line.slice('data: '.length).trim()
      if (!raw) continue

      let data: Record<string, unknown>
      try { data = JSON.parse(raw) as Record<string, unknown> } catch { continue }
      if (currentEventType === 'text' && typeof data.text === 'string') {
        opts.onChunk?.(data.text)
      } else if (currentEventType === 'tick-end') {
        if (typeof data.duration === 'number') result.durationMs = data.duration
        if (typeof data.quality === 'number') result.quality = data.quality
      } else if (currentEventType === 'result') {
        result.response = typeof data.response === 'string' ? data.response : ''
        if (typeof data.sessionId === 'string') result.sessionId = data.sessionId
      }
    }
  }

  result.durationMs ??= Date.now() - sentAt
  return result
}

export async function checkAgentHealth(baseUrl = process.env.AKARI_URL ?? process.env.TANREN_AGENT_URL ?? 'http://localhost:3000'): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`)
    return res.ok
  } catch {
    return false
  }
}
