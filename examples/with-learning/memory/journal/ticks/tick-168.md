# Tick 168

**Time**: 2026-04-01 06:56:00  
**Duration**: 2.6s  
**Actions**: 1 executed, 0 failed  
**Quality**: 5/5


## Thought

I need to complete this task from Alex via Kuro - read context-modes.ts, analyze it, create a summary file, then respond. Let me start by reading the file.

## Observation

/Users/user/Workspace/tanren/src/context-modes.ts (lines 1-94 of 94)
1	/**
2	 * Tanren — Context Mode Detector
3	 *
4	 * Detects the TYPE of thinking needed (research/interaction/verification/execution)
5	 * and returns a mode that determines which perception plugins and memory to load.
6	 * Orthogonal to complexity — mode determines structure, complexity adjusts scale.
7	 */
8	
9	export type ContextMode = 'research' | 'interaction' | 'verification' | 'execution'
10	
11	export interface ContextModeConfig {
12	  mode: ContextMode
13	  /** Which perception plugin categories to load. Empty = load all. */
14	  perceptionCategories: string[]
15	  /** Whether to enable full topic memory search */
16	  fullTopicSearch: boolean
17	  /** Whether search tool results should be included */
18	  enableSearch: boolean
19	  /** Max topic memories to load */
20	  maxTopics: number
21	  /** Description for logging */
22	  description: string
23	}
24	
25	const MODE_CONFIGS: Record<ContextMode, Omit<ContextModeConfig, 'mode'>> = {
26	  research: {
27	    perceptionCategories: [], // all categories
28	    fullTopicSearch: true,
29	    enableSearch: true,
30	    maxTopics: 10,
31	    description: 'Deep analysis — full topic memories + search enabled',
32	  },
33	  interaction: {
34	    perceptionCategories: ['environment', 'input'],
35	    fullTopicSearch: false,
36	    enableSearch: false,
37	    maxTopics: 3,
38	    description: 'Quick response — recent context + focus only',
39	  },
40	  verification: {
41	    perceptionCategories: ['environment', 'memory', 'input'],
42	    fullTopicSearch: true,
43	    enableSearch: true,
44	    maxTopics: 5,
45	    description: 'Fact-checking — claim history + search enabled',
46	  },
47	  execution: {
48	    perceptionCategories: ['environment', 'input'],
49	    fullTopicSearch: false,
50	    enableSearch: false,
51	    maxTopics: 1,
52	    description: 'Direct action — focus only, skip search',
53	  },
54	}
55	
56	const RESEARCH_PATTERNS = /\b(analyz|examin|why\b|how does|explore|investigat|explain|design|compar|deep dive|research|understand)\b/i
57	const VERIFICATION_PATTERNS = /\b(verify|check|is this|confirm|did [iwe]|true|false|you said|earlier|claimed|mentioned|noted|correct)\b/i
58	const EXECUTION_PATTERNS = /^(write|respond|send|create|edit|remove|delete|update|fix|deploy|commit|push)\b/i
59	const GREETING_PATTERNS = /^(hi|hey|hello|yo|sup|morning|afternoon|evening|good\s)/i
60	
61	/**
62	 * Detect the context mode from a message and optional working memory state.
63	 */
64	export function detectContextMode(message: string, currentFocus?: string | null): ContextModeConfig {
65	  const msg = message.trim()
66	
67	  // Verification (highest priority — explicit fact-check request)
68	  if (VERIFICATION_PATTERNS.test(msg)) {
69	    return { mode: 'verification', ...MODE_CONFIGS.verification }
70	  }
71	
72	  // Execution (action-oriented, no analysis markers)
73	  if (EXECUTION_PATTERNS.test(msg) && !RESEARCH_PATTERNS.test(msg)) {
74	    return { mode: 'execution', ...MODE_CONFIGS.execution }
75	  }
76	
77	  // Research (analytical keywords)
78	  if (RESEARCH_PATTERNS.test(msg)) {
79	    return { mode: 'research', ...MODE_CONFIGS.research }
80	  }
81	
82	  // Interaction (short messages, greetings, direct address)
83	  if (msg.length < 100 || GREETING_PATTERNS.test(msg)) {
84	    return { mode: 'interaction', ...MODE_CONFIGS.interaction }
85	  }
86	
87	  // Default: research for longer messages
88	  return { mode: 'research', ...MODE_CONFIGS.research }
89	}
90	
91	export function getModeConfig(mode: ContextMode): ContextModeConfig {
92	  return { mode, ...MODE_CONFIGS[mode] }
93	}
94	
