/**
 * Tanren — Safe I/O Utilities
 *
 * Mature agent harness: never crash on file I/O.
 * Every file read/parse has a fallback. Corrupted files
 * degrade gracefully, not catastrophically.
 */

import { readFileSync, existsSync } from 'node:fs'

/**
 * Safely load and parse a JSON file. Returns fallback on ANY failure:
 * - File not found
 * - File empty
 * - Malformed JSON
 * - Permission error
 *
 * Convergence condition: impossible to crash on file read.
 */
export function safeJsonLoad<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    // Merge with fallback to handle schema evolution (new fields get defaults)
    if (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)
        && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ...fallback, ...parsed }
    }
    return parsed as T
  } catch {
    return fallback
  }
}

/**
 * Safely read a text file. Returns fallback on any failure.
 */
export function safeReadFile(path: string, fallback = ''): string {
  try {
    if (!existsSync(path)) return fallback
    return readFileSync(path, 'utf-8')
  } catch {
    return fallback
  }
}

/**
 * Safely parse each line of a JSONL file. Skips malformed lines.
 */
export function safeJsonlLoad<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    const results: T[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        results.push(JSON.parse(line) as T)
      } catch { /* skip malformed line */ }
    }
    return results
  } catch {
    return []
  }
}
