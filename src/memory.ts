/**
 * Tanren — Memory System
 *
 * File-based memory. No database. Human-readable. Git-friendly.
 *
 * Convergence Condition: Information stored is retrievable when relevant.
 * Agent doesn't lose knowledge across sessions. A human can read and
 * audit all memory with standard tools (cat, grep, git).
 */

import { readFile, writeFile, appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { MemorySystem, SearchResult } from './types.js'

// Intelligent commit state tracking
interface CommitSession {
  startTime: number
  changes: string[]
  lastActivity: number
  significance: number
}

export function createMemorySystem(memoryDir: string, searchPaths?: string[]): MemorySystem {
  // Ensure directory structure exists
  ensureDir(memoryDir)
  ensureDir(join(memoryDir, 'topics'))
  ensureDir(join(memoryDir, 'daily'))
  ensureDir(join(memoryDir, 'state'))

  // Per-instance commit state — two instances do not share session
  let currentSession: CommitSession | null = null
  const SESSION_TIMEOUT = 5 * 60 * 1000  // 5 minutes of inactivity ends session
  const MIN_SIGNIFICANCE = 2  // minimum significance to trigger commit
  const FORCE_COMMIT_INTERVAL = 30 * 60 * 1000  // force commit every 30 minutes

  function calculateSignificance(changedFiles: string[], status: string): number {
    let significance = 0

    for (const file of changedFiles) {
      // High-significance patterns
      if (file.includes('crystallization') || file.includes('learning')) {
        significance += 3  // learning insights are high value
      } else if (file.includes('consultation') || file.includes('research')) {
        significance += 2  // research work is medium-high value
      } else if (file.startsWith('topics/')) {
        significance += 2  // topical insights are valuable
      } else if (file.includes('memory.md')) {
        significance += 1  // general memory updates
      } else if (file.includes('daily/')) {
        significance += 0.5  // daily logs are low priority
      }

      // Bonus for new files (likely more significant than edits)
      if (status.includes(`A  ${file}`) || status.includes(`?? ${file}`)) {
        significance += 1
      }
    }

    // Multiple related changes suggest a coherent work session
    if (changedFiles.length >= 3) {
      significance += 1
    }

    return significance
  }

  function generateCommitMessage(session: CommitSession, currentFiles: string[], significance: number): string {
    const duration = Math.round((Date.now() - session.startTime) / (1000 * 60))
    const totalFiles = session.changes.length

    // Categorize changes
    const categories = new Set<string>()
    const topics = new Set<string>()

    for (const file of session.changes) {
      if (file.includes('crystallization') || file.includes('learning')) {
        categories.add('learning')
      } else if (file.includes('consultation')) {
        categories.add('consultation')
      } else if (file.startsWith('topics/')) {
        categories.add('research')
        const topic = file.replace('topics/', '').replace('.md', '')
        topics.add(topic)
      } else if (file.includes('daily/')) {
        categories.add('daily')
      } else {
        categories.add('memory')
      }
    }

    // Build descriptive message
    let message = 'memory: '

    if (categories.size === 1) {
      const category = Array.from(categories)[0]
      if (category === 'learning') {
        message += `learning insights and crystallization`
      } else if (category === 'consultation') {
        message += `consultation and analysis work`
      } else if (category === 'research') {
        message += `research on ${Array.from(topics).slice(0, 2).join(', ')}`
        if (topics.size > 2) message += ` +${topics.size - 2} more`
      } else {
        message += `${category} updates`
      }
    } else {
      message += `mixed session: ${Array.from(categories).join(', ')}`
    }

    // Add session metadata
    message += ` (${totalFiles} files, ${duration}m, significance: ${significance.toFixed(1)})`

    return message
  }

  async function autoCommitMemory(): Promise<boolean> {
    try {
      // Check if memoryDir is in a git repo
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: memoryDir,
        encoding: 'utf-8',
        timeout: 3000,
      })

      // Check for uncommitted changes in entire repo (agent may edit config, source, etc.)
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: memoryDir,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()

      if (!status) {
        // No changes - clean up expired session
        if (currentSession && Date.now() - currentSession.lastActivity > SESSION_TIMEOUT) {
          currentSession = null
        }
        return false
      }

      const now = Date.now()
      const changedFiles = status.split('\n').map(line => line.slice(3).trim())

      // Calculate significance of changes
      const significance = calculateSignificance(changedFiles, status)

      // Initialize or update session
      if (!currentSession) {
        currentSession = {
          startTime: now,
          changes: changedFiles,
          lastActivity: now,
          significance,
        }
      } else {
        // Update existing session
        currentSession.lastActivity = now
        currentSession.significance = Math.max(currentSession.significance, significance)
        // Merge new changes
        for (const file of changedFiles) {
          if (!currentSession.changes.includes(file)) {
            currentSession.changes.push(file)
          }
        }
      }

      // Decide whether to commit
      const shouldCommit =
        significance >= MIN_SIGNIFICANCE || // high significance changes
        (currentSession && now - currentSession.startTime > FORCE_COMMIT_INTERVAL) || // force commit after timeout
        (currentSession && now - currentSession.lastActivity > SESSION_TIMEOUT) // session expired

      if (!shouldCommit) {
        return false // defer commit
      }

      // Generate meaningful commit message
      const commitMessage = generateCommitMessage(currentSession!, changedFiles, significance)

      // Stage all changes — agent's work = agent's commit
      execFileSync('git', ['add', '-A'], {
        cwd: memoryDir,
        timeout: 5000,
      })

      execFileSync('git', ['commit', '-m', commitMessage], {
        cwd: memoryDir,
        timeout: 10000,
      })

      // Reset session after successful commit
      currentSession = null

      return true
    } catch {
      return false
    }
  }

  const self: MemorySystem = {
    async read(path: string): Promise<string | null> {
      const fullPath = resolvePath(memoryDir, path)
      try {
        return await readFile(fullPath, 'utf-8')
      } catch {
        return null
      }
    },

    async write(path: string, content: string): Promise<void> {
      const fullPath = resolvePath(memoryDir, path)
      ensureDir(dirname(fullPath))
      await writeFile(fullPath, content, 'utf-8')
    },

    async append(path: string, line: string): Promise<void> {
      const fullPath = resolvePath(memoryDir, path)
      ensureDir(dirname(fullPath))
      const suffix = line.endsWith('\n') ? '' : '\n'
      await appendFile(fullPath, line + suffix, 'utf-8')
    },

    async search(query: string): Promise<SearchResult[]> {
      // Search own memory first
      const results = grepSearch(memoryDir, query)
      // Then search additional paths (read-only knowledge sources)
      if (searchPaths?.length) {
        for (const sp of searchPaths) {
          if (!existsSync(sp)) continue
          const external = grepSearch(sp, query)
          // Prefix external results with source label
          const label = sp.split('/').pop() ?? sp
          for (const r of external) {
            results.push({ ...r, file: `[${label}] ${r.file}` })
          }
          if (results.length >= 50) break
        }
      }
      return results.slice(0, 50)
    },

    async remember(content: string, opts?: { topic?: string; tickCount?: number }): Promise<void> {
      const timestamp = new Date().toISOString()
      const tickTag = opts?.tickCount != null ? ` [tick:${opts.tickCount}]` : ''

      // Auto-extract concept tags from content (framework-level, not agent-level)
      const tags = extractConceptTags(content)
      const tagSuffix = tags.length > 0 ? ` ${tags.map(t => `#${t}`).join(' ')}` : ''
      const entry = `- [${timestamp.slice(0, 10)}]${tickTag} ${content}${tagSuffix}\n`

      if (opts?.topic) {
        const topicFile = `topics/${sanitizeFilename(opts.topic)}.md`
        const existing = await self.read(topicFile)
        if (!existing) {
          await self.write(topicFile, `# ${opts.topic}\n\n${entry}`)
        } else {
          await self.append(topicFile, entry)
        }
      } else {
        await self.append('memory.md', entry)
      }

      // Update tag index (fire-and-forget)
      updateTagIndex(memoryDir, content, tags, opts?.topic ?? 'general', timestamp).catch(() => {})
    },

    async recall(query: string): Promise<string[]> {
      const results = await grepSearch(memoryDir, query)
      return results.map(r => r.content)
    },

    async autoCommit(): Promise<boolean> {
      return autoCommitMemory()
    },
  }

  return self
}

// === Internal Helpers ===

function resolvePath(memoryDir: string, path: string): string {
  // Strip redundant memoryDir prefix — model doesn't know paths are relative to memoryDir
  // e.g., memoryDir="./memory", path="memory/plans/x.md" → should resolve to "./memory/plans/x.md"
  const memDirName = basename(memoryDir)
  if (path.startsWith(memDirName + '/')) {
    path = path.slice(memDirName.length + 1)
  }

  // Prevent path traversal
  const resolved = join(memoryDir, path)
  const rel = relative(memoryDir, resolved)
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Path traversal blocked: ${path}`)
  }
  return resolved
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function grepSearch(dir: string, query: string): SearchResult[] {
  if (!query.trim()) return []

  try {
    const output = execFileSync('grep', [
      '-rn',             // recursive + line numbers
      '--include=*.md',  // only markdown files
      '--include=*.jsonl',
      '-i',              // case insensitive
      '-l',              // list files first for efficiency
      query,
      dir,
    ], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024, // 1MB
      timeout: 5000,
    })

    // Now get actual matching lines from found files
    const files = output.trim().split('\n').filter(Boolean)
    const results: SearchResult[] = []

    for (const file of files.slice(0, 20)) { // max 20 files
      try {
        const lines = execFileSync('grep', [
          '-n', '-i',
          query,
          file,
        ], {
          encoding: 'utf-8',
          maxBuffer: 256 * 1024,
          timeout: 3000,
        })

        for (const line of lines.trim().split('\n').filter(Boolean)) {
          const colonIdx = line.indexOf(':')
          if (colonIdx === -1) continue
          const lineNum = parseInt(line.slice(0, colonIdx), 10)
          const content = line.slice(colonIdx + 1)
          results.push({
            file: relative(dir, file),
            line: lineNum,
            content: content.trim(),
          })
          if (results.length >= 50) break // cap results
        }
      } catch {
        // Individual file grep failure — skip
      }
      if (results.length >= 50) break
    }

    return results
  } catch (err: unknown) {
    // grep returns exit code 1 when no matches — not an error
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
      return []
    }
    return []
  }
}

// === Concept Tag Extraction ===
// Auto-extracts key concepts from memory content — no LLM, pure heuristic.
// Extracts nouns/concepts >3 chars, filters stop words, takes top 3.

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would', 'could',
  'should', 'about', 'there', 'their', 'they', 'what', 'when', 'where', 'which',
  'more', 'some', 'also', 'just', 'like', 'into', 'than', 'then', 'very', 'each',
  'make', 'made', 'does', 'doing', 'done', 'being', 'after', 'before', 'between',
  'same', 'other', 'only', 'over', 'still', 'through', 'here', 'much', 'need',
  'these', 'those', 'your', 'know',
])

function extractConceptTags(content: string): string[] {
  // Extract words, filter short/stop words, score by frequency + length
  const words = content
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff-]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))

  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)

  return [...freq.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([w]) => w)
}

// === Tag Index ===
// JSONL file mapping tags → memory entries for fast conceptual lookup.

async function updateTagIndex(
  memoryDir: string,
  content: string,
  tags: string[],
  source: string,
  timestamp: string,
): Promise<void> {
  if (tags.length === 0) return
  const indexPath = join(memoryDir, 'state', 'tag-index.jsonl')
  const entry = JSON.stringify({
    tags,
    source,
    preview: content.slice(0, 100),
    ts: timestamp,
  })
  await appendFile(indexPath, entry + '\n')
}

// === History Query ===
// Search ticks.jsonl for behavioral patterns.

export async function queryTickHistory(
  memoryDir: string,
  filter: { actionType?: string; minQuality?: number; maxDuration?: number },
): Promise<Array<{ tick: number; actions: string[]; quality: number; duration: number }>> {
  const ticksPath = join(memoryDir, 'journal', 'ticks.jsonl')
  try {
    const raw = await readFile(ticksPath, 'utf-8')
    const results: Array<{ tick: number; actions: string[]; quality: number; duration: number }> = []

    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const t = JSON.parse(line)
        const actions = (t.actions ?? []).map((a: { type: string }) => a.type)
        const obs = t.observation ?? {}
        const quality = obs.quality ?? 0
        const duration = obs.duration ?? 0

        if (filter.actionType && !actions.includes(filter.actionType)) continue
        if (filter.minQuality && quality < filter.minQuality) continue
        if (filter.maxDuration && duration > filter.maxDuration) continue

        results.push({ tick: t.tick ?? 0, actions, quality, duration: Math.round(duration / 1000) })
      } catch { continue }
    }
    return results.slice(-50) // last 50 matches
  } catch {
    return []
  }
}

// === Session Bridge ===
// Auto-updated at tick end: captures open questions, focus, priorities for next session.

export function buildSessionBridge(
  workingMemory: { currentFocus: string | null; recentInsights: Array<{ content: string }> },
  lastActions: string[],
  tickCount: number,
): Record<string, unknown> {
  return {
    lastTick: tickCount,
    updatedAt: new Date().toISOString(),
    currentFocus: workingMemory.currentFocus,
    openQuestions: workingMemory.recentInsights
      .filter(i => i.content.includes('?'))
      .slice(0, 5)
      .map(i => i.content),
    recentActivity: lastActions.slice(0, 10),
    resumeHint: workingMemory.currentFocus
      ? `Continue working on: ${workingMemory.currentFocus}`
      : 'No active focus — explore environment or check inbox',
  }
}

// === Utility: List memory files ===

export async function listMemoryFiles(memoryDir: string): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') {
          await walk(full)
        }
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) {
        results.push(relative(memoryDir, full))
      }
    }
  }

  await walk(memoryDir)
  return results
}
