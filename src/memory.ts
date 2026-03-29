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
import { join, relative, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { MemorySystem, SearchResult } from './types.js'

export function createMemorySystem(memoryDir: string, searchPaths?: string[]): MemorySystem {
  // Ensure directory structure exists
  ensureDir(memoryDir)
  ensureDir(join(memoryDir, 'topics'))
  ensureDir(join(memoryDir, 'daily'))
  ensureDir(join(memoryDir, 'state'))

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

    async remember(content: string, opts?: { topic?: string }): Promise<void> {
      const timestamp = new Date().toISOString()
      const entry = `- [${timestamp.slice(0, 10)}] ${content}\n`

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
    },

    async recall(query: string): Promise<string[]> {
      const results = await grepSearch(memoryDir, query)
      return results.map(r => r.content)
    },

    async autoCommit(): Promise<boolean> {
      return autoCommitMemory(memoryDir)
    },
  }

  return self
}

// === Internal Helpers ===

function resolvePath(memoryDir: string, path: string): string {
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

async function autoCommitMemory(memoryDir: string): Promise<boolean> {
  try {
    // Check if memoryDir is in a git repo
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: memoryDir,
      encoding: 'utf-8',
      timeout: 3000,
    })

    // Check for uncommitted changes in memory dir
    const status = execFileSync('git', ['status', '--porcelain', memoryDir], {
      cwd: memoryDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()

    if (!status) return false

    // Stage and commit
    execFileSync('git', ['add', memoryDir], {
      cwd: memoryDir,
      timeout: 5000,
    })

    execFileSync('git', ['commit', '-m', `memory: auto-commit ${new Date().toISOString().slice(0, 19)}`], {
      cwd: memoryDir,
      timeout: 10000,
    })

    return true
  } catch {
    return false
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
