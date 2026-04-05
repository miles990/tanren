/**
 * Tanren — Session Resume & Fork
 *
 * Perception-level session persistence — deeper than conversation replay.
 * Saves: working memory state, hypothesis graph, active focus, tick context.
 * Resume picks up WHERE you were thinking, not just WHAT was said.
 *
 * Fork creates a branch: explore a different direction without losing the original.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { safeJsonLoad } from './safe-io.js'

export interface SessionSnapshot {
  id: string
  timestamp: string
  label?: string
  // Cognitive state at time of snapshot
  workingMemory: unknown           // full WorkingMemoryState
  lastPerception: string           // perception context (for continuity)
  lastActions: string[]            // what tools were used
  lastResponse: string             // what was said
  tickCount: number
  mode: string                     // context mode at save time
}

const SESSIONS_DIR = 'sessions'

function getSessionsDir(memoryDir: string): string {
  const dir = join(memoryDir, SESSIONS_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Save a session snapshot — captures cognitive state, not just conversation */
export function saveSession(memoryDir: string, snapshot: SessionSnapshot): string {
  const dir = getSessionsDir(memoryDir)
  const filename = `${snapshot.id}.json`
  writeFileSync(join(dir, filename), JSON.stringify(snapshot, null, 2))
  return filename
}

/** List all saved sessions */
export function listSessions(memoryDir: string): Array<{ id: string; timestamp: string; label?: string; tickCount: number }> {
  const dir = getSessionsDir(memoryDir)
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse()
  return files.map(f => {
    const snap = safeJsonLoad<SessionSnapshot>(join(dir, f), { id: '', timestamp: '', tickCount: 0, workingMemory: {}, lastPerception: '', lastActions: [], lastResponse: '', mode: '' })
    return { id: snap.id, timestamp: snap.timestamp, label: snap.label, tickCount: snap.tickCount }
  })
}

/** Load a session snapshot */
export function loadSession(memoryDir: string, id: string): SessionSnapshot | null {
  const filePath = join(getSessionsDir(memoryDir), `${id}.json`)
  if (!existsSync(filePath)) return null
  return safeJsonLoad<SessionSnapshot>(filePath, null as unknown as SessionSnapshot)
}

/** Fork a session — creates a copy with a new ID, original untouched */
export function forkSession(memoryDir: string, sourceId: string, label?: string): SessionSnapshot | null {
  const source = loadSession(memoryDir, sourceId)
  if (!source) return null

  const forked: SessionSnapshot = {
    ...source,
    id: `${sourceId}-fork-${Date.now()}`,
    timestamp: new Date().toISOString(),
    label: label ?? `Fork of ${source.label ?? sourceId}`,
  }
  saveSession(memoryDir, forked)
  return forked
}

/** Format session for context injection — gives agent awareness of saved sessions */
export function formatSessionsForContext(memoryDir: string): string {
  const sessions = listSessions(memoryDir)
  if (sessions.length === 0) return ''
  const lines = sessions.slice(0, 5).map(s =>
    `- ${s.id}${s.label ? ` "${s.label}"` : ''} (tick ${s.tickCount}, ${s.timestamp.split('T')[0]})`
  )
  return `Saved sessions (resume with session_resume tool):\n${lines.join('\n')}`
}
