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

const RESEARCH_PATTERNS = /\b(analyz|examin|why\b|how does|explore|investigat|explain|design|compar|deep dive|research|understand)\b/i
const VERIFICATION_PATTERNS = /\b(verify|check|is this|confirm|did [iwe]|true|false|you said|earlier|claimed|mentioned|noted|correct)\b/i
const EXECUTION_PATTERNS = /^(write|respond|send|create|edit|remove|delete|update|fix|deploy|commit|push)\b/i
const GREETING_PATTERNS = /^(hi|hey|hello|yo|sup|morning|afternoon|evening|good\s)/i

/**
 * Detect the context mode from a message and optional working memory state.
 */
export function detectContextMode(message: string, currentFocus?: string | null): ContextModeConfig {
  const msg = message.trim()

  // Verification (highest priority — explicit fact-check request)
  if (VERIFICATION_PATTERNS.test(msg)) {
    return { mode: 'verification', ...MODE_CONFIGS.verification }
  }

  // Execution (action-oriented, no analysis markers)
  if (EXECUTION_PATTERNS.test(msg) && !RESEARCH_PATTERNS.test(msg)) {
    return { mode: 'execution', ...MODE_CONFIGS.execution }
  }

  // Research (analytical keywords)
  if (RESEARCH_PATTERNS.test(msg)) {
    return { mode: 'research', ...MODE_CONFIGS.research }
  }

  // Interaction (short messages, greetings, direct address)
  if (msg.length < 100 || GREETING_PATTERNS.test(msg)) {
    return { mode: 'interaction', ...MODE_CONFIGS.interaction }
  }

  // Default: research for longer messages
  return { mode: 'research', ...MODE_CONFIGS.research }
}

export function getModeConfig(mode: ContextMode): ContextModeConfig {
  return { mode, ...MODE_CONFIGS[mode] }
}
