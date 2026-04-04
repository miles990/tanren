/**
 * Tanren — Socratic Grounding
 *
 * Automatically enriches abstract questions with concrete context from
 * the agent's memory and tick history. Makes open-ended questions specific
 * so the LLM produces deeper responses.
 *
 * Not an LLM call — pure heuristic + memory lookup.
 *
 * "列出你的 3 個具體 tick" → 1964 chars
 * "分析 X 缺陷" → 165 chars
 *
 * The difference is specificity. This module adds specificity automatically.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Abstract question indicators
const ABSTRACT_PATTERNS = [
  /分析|analyze|評估|evaluate|assess/i,
  /設計|design|架構|architecture/i,
  /缺陷|問題|issue|flaw|problem|缺少|missing/i,
  /比較|compare|差異|differ/i,
  /建議|suggest|recommend|improve/i,
  /如何|怎麼|how.*should|what.*approach/i,
  /利弊|trade.?off|pros.*cons/i,
  /根本|fundamental|deep|深入/i,
]

// Concrete/specific indicators (don't need grounding)
const CONCRETE_PATTERNS = [
  /列出|list|具體|specific|舉例|example/i,
  /你的經驗|your experience|你遇過|you.*encounter/i,
  /tick #?\d|在 tick|第.*tick/i,
  /多少|how many|幾個|how long/i,
  /\d{3,}/, // contains numbers (likely specific reference)
]

/**
 * Detect if a question is abstract (would benefit from grounding)
 */
function isAbstractQuestion(text: string): boolean {
  if (text.length < 20) return false // too short to analyze
  if (text.length > 500) return false // already has rich context
  const isAbstract = ABSTRACT_PATTERNS.some(p => p.test(text))
  const isConcrete = CONCRETE_PATTERNS.some(p => p.test(text))
  return isAbstract && !isConcrete
}

/**
 * Load relevant context for grounding from memory and ticks
 */
function loadGroundingContext(memoryDir: string, question: string): string {
  const parts: string[] = []

  // 1. Recent tick summary — what the agent has been doing
  const ticksPath = join(memoryDir, 'journal', 'ticks.jsonl')
  if (existsSync(ticksPath)) {
    try {
      const lines = readFileSync(ticksPath, 'utf-8').trim().split('\n').slice(-10)
      const recentActions: string[] = []
      for (const line of lines) {
        try {
          const t = JSON.parse(line)
          const acts = (t.actions ?? []).map((a: { type: string }) => a.type).join('→')
          const dur = Math.round((t.observation?.duration ?? 0) / 1000)
          if (acts) recentActions.push(`${acts} (${dur}s)`)
        } catch { continue }
      }
      if (recentActions.length > 0) {
        parts.push(`Your recent tick patterns: ${recentActions.slice(-5).join(', ')}`)
      }
    } catch { /* skip */ }
  }

  // 2. Extract keywords from question → search memory for related entries
  const keywords = extractKeywords(question)
  if (keywords.length > 0) {
    const memPath = join(memoryDir, 'memory.md')
    if (existsSync(memPath)) {
      try {
        const memory = readFileSync(memPath, 'utf-8')
        const relevantLines = memory.split('\n')
          .filter(line => keywords.some(k => line.toLowerCase().includes(k)))
          .slice(-3)
        if (relevantLines.length > 0) {
          parts.push(`Related memories: ${relevantLines.map(l => l.trim()).join('; ')}`)
        }
      } catch { /* skip */ }
    }

    // Also check topic files
    const topicsDir = join(memoryDir, 'topics')
    if (existsSync(topicsDir)) {
      try {
        const files = readdirSync(topicsDir).filter((f: string) => f.endsWith('.md'))
        const relevant = files.filter((f: string) =>
          keywords.some(k => f.toLowerCase().includes(k))
        )
        if (relevant.length > 0) {
          parts.push(`You have topic files about: ${relevant.map((f: string) => f.replace('.md', '')).join(', ')}`)
        }
      } catch { /* skip */ }
    }
  }

  // 3. Working memory focus
  const wmPath = join(memoryDir, 'state', 'working-memory.json')
  if (existsSync(wmPath)) {
    try {
      const wm = JSON.parse(readFileSync(wmPath, 'utf-8'))
      if (wm.currentFocus) {
        parts.push(`Your current focus: ${wm.currentFocus}`)
      }
    } catch { /* skip */ }
  }

  return parts.join('\n')
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !new Set([
      'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'how',
      'your', 'you', 'have', 'has', 'are', 'was', 'were', 'been',
      '的', '是', '有', '在', '了', '不', '和', '也', '這', '那', '要',
    ]).has(w))
    .slice(0, 5)
}

/**
 * Enrich an abstract question with concrete grounding context.
 * Returns the original text + grounding appendix, or original text if not abstract.
 */
export function groundQuestion(text: string, memoryDir: string): string {
  if (!isAbstractQuestion(text)) return text

  const context = loadGroundingContext(memoryDir, text)
  if (!context) return text

  // Reframe: turn analytical questions into experience-recall questions.
  // LLMs produce 10x more depth when recalling concrete experiences vs abstract analysis.
  return `${text}

---
[Context from your memory]
${context}

Reframe this as personal experience: list 3 specific moments from your ticks where you encountered this topic. For each moment, describe what happened, what you noticed, and what you learned. Use your actual tick history and memories as evidence.`
}
