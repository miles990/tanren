/**
 * Tanren — Skill System
 *
 * Dynamic cognitive modules loaded based on context mode + keywords.
 * Forged from Claude Code's skill system: specialized prompts that
 * shape HOW the agent thinks about specific task types.
 *
 * Skills are .md files in a skills/ directory. Each has frontmatter:
 *   ---
 *   name: debugging
 *   triggers: [error, bug, fix, crash, fail]
 *   modes: [research, verification]
 *   ---
 *   ## How to Debug
 *   1. Reproduce the error...
 *
 * Skills are injected into the system prompt when triggers match.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextMode } from './context-modes.js'

export interface Skill {
  name: string
  triggers: string[]       // keywords that activate this skill
  modes: ContextMode[]     // which context modes this skill applies to (empty = all)
  content: string          // the skill instructions (injected into system prompt)
  filePath: string
}

/** Load all skills from a directory. Cached after first load. */
let skillCache: Skill[] | null = null

export function loadSkills(skillsDir: string): Skill[] {
  if (skillCache) return skillCache

  if (!existsSync(skillsDir)) {
    skillCache = []
    return skillCache
  }

  const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'))
  const skills: Skill[] = []

  for (const file of files) {
    try {
      const filePath = join(skillsDir, file)
      const raw = readFileSync(filePath, 'utf-8')

      // Parse frontmatter
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
      if (!fmMatch) {
        // No frontmatter — use filename as name, no triggers
        skills.push({
          name: file.replace('.md', ''),
          triggers: [],
          modes: [],
          content: raw.trim(),
          filePath,
        })
        continue
      }

      const frontmatter = fmMatch[1]
      const content = fmMatch[2].trim()

      const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim() ?? file.replace('.md', '')
      const triggersMatch = frontmatter.match(/triggers:\s*\[([^\]]*)\]/)
      const triggers = triggersMatch
        ? triggersMatch[1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        : []
      const modesMatch = frontmatter.match(/modes:\s*\[([^\]]*)\]/)
      const modes = modesMatch
        ? modesMatch[1].split(',').map(m => m.trim()).filter(Boolean) as ContextMode[]
        : []

      skills.push({ name, triggers, modes, content, filePath })
    } catch {
      // Skip malformed skill files
    }
  }

  skillCache = skills
  console.error(`[tanren] Loaded ${skills.length} skill(s) from ${skillsDir}`)
  return skillCache
}

/** Select relevant skills based on context mode and message keywords */
export function selectSkills(
  skills: Skill[],
  mode: ContextMode,
  messageContent: string,
): Skill[] {
  const msg = messageContent.toLowerCase()
  const selected: Skill[] = []

  for (const skill of skills) {
    // Mode filter: if skill specifies modes, current mode must match
    if (skill.modes.length > 0 && !skill.modes.includes(mode)) continue

    // Trigger filter: if skill has triggers, at least one must match
    if (skill.triggers.length > 0) {
      const matches = skill.triggers.some(t => msg.includes(t))
      if (!matches) continue
    }

    // No triggers + no modes = always load (universal skill)
    selected.push(skill)
  }

  return selected
}

/** Format selected skills for system prompt injection */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const sections = skills.map(s => `## Skill: ${s.name}\n\n${s.content}`)
  return `\n\n# Active Skills\n\n${sections.join('\n\n')}`
}

/** Clear cache (for hot-reload) */
export function clearSkillCache(): void {
  skillCache = null
}
