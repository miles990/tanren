/**
 * Tanren — Structured Handoff System
 *
 * Reliable multi-agent collaboration through structured context transfer.
 * Convergence condition: every handoff contains enough context for the
 * receiving agent to continue without re-doing work.
 *
 * Forged from observing Claude Code + Akari + Kuro collaboration failures:
 * - Chat-based handoffs lose context
 * - Unstructured messages miss critical state
 * - Quality isn't verified across agent boundaries
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface Handoff {
  id: string
  from: string                    // agent name
  to: string                      // target agent
  timestamp: string               // ISO 8601
  status: 'pending' | 'accepted' | 'completed' | 'rejected'

  // Context package — everything the receiving agent needs
  task: string                    // what to do
  context: string                 // relevant background
  filesChanged: string[]          // files modified by the sending agent
  keyFindings: string[]           // important discoveries
  blockers: string[]              // issues that need resolution

  // Quality gate
  acceptanceCriteria: string[]    // how to verify the handoff is complete
  verificationCommand?: string    // shell command to verify (e.g., "npm run build")
}

/** Write a handoff to the shared handoff directory */
export function writeHandoff(handoffDir: string, handoff: Handoff): string {
  if (!existsSync(handoffDir)) mkdirSync(handoffDir, { recursive: true })
  const filename = `${handoff.id}.json`
  const filePath = join(handoffDir, filename)
  writeFileSync(filePath, JSON.stringify(handoff, null, 2))
  return filePath
}

/** Read pending handoffs for a specific agent */
export function readPendingHandoffs(handoffDir: string, agentName: string): Handoff[] {
  if (!existsSync(handoffDir)) return []
  const files = readdirSync(handoffDir).filter(f => f.endsWith('.json'))
  const handoffs: Handoff[] = []

  for (const file of files) {
    try {
      const h = JSON.parse(readFileSync(join(handoffDir, file), 'utf-8')) as Handoff
      if (h.to === agentName && h.status === 'pending') {
        handoffs.push(h)
      }
    } catch { /* skip malformed */ }
  }

  return handoffs
}

/** Update handoff status */
export function updateHandoffStatus(handoffDir: string, id: string, status: Handoff['status']): void {
  const filePath = join(handoffDir, `${id}.json`)
  if (!existsSync(filePath)) return
  try {
    const h = JSON.parse(readFileSync(filePath, 'utf-8')) as Handoff
    h.status = status
    writeFileSync(filePath, JSON.stringify(h, null, 2))
  } catch { /* best effort */ }
}

/** Format handoffs for perception injection */
export function formatHandoffsForContext(handoffs: Handoff[]): string {
  if (handoffs.length === 0) return ''
  const sections = handoffs.map(h => {
    const criteria = h.acceptanceCriteria.map(c => `  - ${c}`).join('\n')
    const files = h.filesChanged.length > 0 ? `\nFiles changed: ${h.filesChanged.join(', ')}` : ''
    const findings = h.keyFindings.length > 0 ? `\nKey findings:\n${h.keyFindings.map(f => `  - ${f}`).join('\n')}` : ''
    const blockers = h.blockers.length > 0 ? `\nBlockers:\n${h.blockers.map(b => `  - ⚠️ ${b}`).join('\n')}` : ''
    return `📋 Handoff from ${h.from}: ${h.task}${files}${findings}${blockers}\nAcceptance criteria:\n${criteria}`
  })
  return sections.join('\n\n')
}
