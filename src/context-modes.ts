/**
 * Tanren — Context Mode Detector
 *
 * Detects the TYPE of thinking needed (research/interaction/verification/execution)
 * and returns a mode that determines which perception plugins and memory to load.
 * Orthogonal to complexity — mode determines structure, complexity adjusts scale.
 */

export type ContextMode = 'research' | 'interaction' | 'verification' | 'execution'

export interface ContextModeConfig {
  mode: ContextMode
  /** Which perception plugin categories to load. Empty = load all. */
  perceptionCategories: string[]
  /** Whether to enable full topic memory search */
  fullTopicSearch: boolean
  /** Whether search tool results should be included */
  enableSearch: boolean
  /** Max topic memories to load */
  maxTopics: number
  /** Description for logging */
  description: string
}

const MODE_CONFIGS: Record<ContextMode, Omit<ContextModeConfig, 'mode'>> = {
  research: {
    perceptionCategories: [], // all categories
    fullTopicSearch: true,
    enableSearch: true,
    maxTopics: 10,
    description: 'Deep analysis — full topic memories + search enabled',
  },
  interaction: {
    perceptionCategories: ['environment', 'input'],
    fullTopicSearch: false,
    enableSearch: false,
    maxTopics: 3,
    description: 'Quick response — recent context + focus only',
  },
  verification: {
    perceptionCategories: ['environment', 'memory', 'input'],
    fullTopicSearch: true,
    enableSearch: true,
    maxTopics: 5,
    description: 'Fact-checking — claim history + search enabled',
  },
  execution: {
    perceptionCategories: ['environment', 'input'],
    fullTopicSearch: false,
    enableSearch: false,
    maxTopics: 1,
    description: 'Direct action — focus only, skip search',
  },
}

const MODE_PATTERNS: { mode: ContextMode; pattern: RegExp; weight: number }[] = [
  // Each match adds weight; highest total score wins (not first-match)
  { mode: 'verification', pattern: /\b(verify|confirm|is this|you said|earlier|claimed|mentioned|noted|correct)\b/i, weight: 3 },
  { mode: 'verification', pattern: /\b(did [iwe]|true|false)\b/i, weight: 2 },
  { mode: 'execution', pattern: /^(write|respond|send|create|edit|remove|delete|update|fix|deploy|commit|push)\b/i, weight: 3 },
  { mode: 'execution', pattern: /\b(implement|build|做|修|改|加)\b/i, weight: 2 },
  { mode: 'research', pattern: /\b(analyz|examin|why\b|how does|explore|investigat|explain|compar|deep dive|research|understand)\b/i, weight: 2 },
  { mode: 'research', pattern: /\b(design|architectur|設計|分析)\b/i, weight: 2 },
  { mode: 'interaction', pattern: /^(hi|hey|hello|yo|sup|morning|afternoon|evening|good\s)/i, weight: 4 },
]

/**
 * Detect context mode via score-based classification.
 * Constraint Texture: code scores all signals, highest wins. No first-match prescription.
 */
export function detectContextMode(message: string, currentFocus?: string | null): ContextModeConfig {
  const msg = message.trim()

  // Short messages without strong signals → interaction
  if (msg.length < 50 && !MODE_PATTERNS.some(p => p.mode !== 'interaction' && p.pattern.test(msg))) {
    return { mode: 'interaction', ...MODE_CONFIGS.interaction }
  }

  // Score all modes
  const scores: Record<ContextMode, number> = { research: 0, interaction: 0, verification: 0, execution: 0 }
  for (const { mode, pattern, weight } of MODE_PATTERNS) {
    if (pattern.test(msg)) scores[mode] += weight
  }

  // Longer messages with no matches → research (needs deeper thinking)
  const maxScore = Math.max(...Object.values(scores))
  if (maxScore === 0) {
    return { mode: msg.length >= 100 ? 'research' : 'interaction', ...MODE_CONFIGS[msg.length >= 100 ? 'research' : 'interaction'] }
  }

  const winner = (Object.entries(scores) as [ContextMode, number][])
    .sort((a, b) => b[1] - a[1])[0][0]

  return { mode: winner, ...MODE_CONFIGS[winner] }
}

export function getModeConfig(mode: ContextMode): ContextModeConfig {
  return { mode, ...MODE_CONFIGS[mode] }
}
