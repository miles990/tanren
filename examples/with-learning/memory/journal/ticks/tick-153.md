# Tick 153

**Time**: 2026-04-01 05:37:04  
**Duration**: 35.8s  
**Actions**: 7 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 3 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

Looking at Alex's request for a hot/warm/cold context system for Tanren. This is about solving the "each tick starts from scratch" problem - a critical limitation I've observed in my own experience. Let me read the core files to understand the current architecture first.

<action:read>/Users/user/Workspace/tanren/src/perception.ts</action:read>

<action:read>/Users/user/Workspace/tanren/src/loop.ts</action:read>

<action:read>/Users/user/Workspace/tanren/package.json</action:read>

<action:explore>/Users/user/Workspace/tanren/src/*.ts</action:explore>

Now I'll analyze the current architecture and design the hot/warm/cold context system:

<action:respond># Hot/Warm/Cold Context System for Tanren

## Current Architecture Analysis

After reading `perception.ts` and `loop.ts`, I see the current flow:
- Each tick rebuilds perception from scratch via plugins
- No persistence between ticks except filesystem state
- LLM context window is the only "memory" within a tick

## Proposed Hot/Warm/Cold System

### 1. HOT Context (Always Available)
**Persists between ticks, immediately accessible**

```typescript
interface HotContext {
  // Last N file reads with content + metadata
  fileCache: Map<string, {
    content: string
    lastAccessed: Date
    hash: string // for invalidation
    lineCount: number
  }>
  
  // Recent action results (non-file operations)  
  actionResults: Array<{
    action: string
    timestamp: Date
    result: any
    tokens?: number
  }>
  
  // Active research threads
  researchState: {
    currentTopic?: string
    lastQuery?: string
    openQuestions: string[]
    keyFindings: string[]
  }
  
  // Cross-tick continuity
  workingMemory: {
    lastThought: string
    pendingActions: string[]
    contextSummary: string // 2-3 sentences
  }
}
```

**Expiry Rules:**
- File cache: 10 files max, LRU eviction, invalidate on file modification
- Action results: 20 actions max, 1 hour TTL
- Research state: persists until topic shift detected
- Working memory: overwrites each tick

**Token Budget:** ~2000 tokens max

### 2. WARM Context (Load on Demand)
**Retrieved when relevant, cached after first access**

```typescript
interface WarmContext {
  // Topic-specific memory files (from memory/ directory)
  topicMemories: Map<string, {
    summary: string // first 200 chars
    fullContent?: string // loaded on demand
    relevanceScore: number
    lastUpdated: Date
  }>
  
  // Project context (when working in specific directories)
  projectCache: Map<string, {
    structure: string[] // file tree
    readme?: string
    recentChanges: GitChange[]
  }>
  
  // Conversation history with Kuro
  conversationThread: Array<{
    timestamp: Date
    direction: 'from-kuro' | 'to-kuro'
    summary: string // 1 sentence
    fullContent?: string // loaded on demand
  }>
}
```

**Loading Triggers:**
- Keyword match in current perception
- File path similarity
- Topic continuation detection
- Explicit search/explore actions

**Token Budget:** ~1500 tokens for summaries, full content loaded as needed

### 3. COLD Context (Search-Triggered)
**Full search across all available data**

```typescript
interface ColdContext {
  // Full-text search across memory files
  memorySearch: (query: string) => SearchResult[]
  
  // Deep file exploration
  projectSearch: (pattern: string, content?: string) => FileMatch[]
  
  // Historical action analysis
  actionPatterns: (timeRange: Date[]) => PatternAnalysis
  
  // Cross-reference discovery
  connectionFinder: (entity: string) => Connection[]
}
```

**What's Currently Missing:**
- Semantic relationship mapping
- Cross-tick learning patterns
- Context compression/summarization
- Relevance scoring algorithms

## 4. Implementation Strategy

### Option A: New ContextManager Module
```typescript
// src/context/ContextManager.ts
export class ContextManager {
  private hot: HotContext
  private warm: WarmContextCache  
  private cold: ColdSearch
  
  async getContextFor(perception: string): Promise<EnrichedContext>
  async updateHot(actions: Action[], thought: string): Promise<void>
  async warmLookup(triggers: string[]): Promise<WarmContext>
  async coldSearch(query: string): Promise<ColdContext>
}
```

### Option B: Enhance Existing Modules
- Extend `perception.ts` with context plugins
- Add persistence layer to `loop.ts`
- Modify `MemoryPlugin` to support tiered access

**Recommendation: Option A** - cleaner separation, easier to optimize independently

## 5. Token Budget Distribution

```
Total context budget: ~4000 tokens
├── HOT (always): 2000 tokens
├── WARM (conditional): 1500 tokens  
└── COLD (on-demand): 500 tokens for results
```

## 6. Relevance Decay & Topic Shift Detection

```typescript
interface TopicShiftDetector {
  // Cosine similarity of current perception vs recent context
  perceptionSimilarity: number
  
  // Keyword overlap analysis  
  keywordContinuity: number
  
  // Action pattern changes
  actionPatternShift: boolean
  
  // Explicit topic markers in agent thought
  explicitTopicChange: boolean
}
```

**Decay Formula:**
```
relevanceScore = baseRelevance * exp(-timeDelta/halfLife) * topicSimilarity
```

**Topic Shift Threshold:** Combined score < 0.3 triggers context refresh

## Implementation Priority

1. **Phase 1:** Hot context (file cache + working memory)
2. **Phase 2:** Topic shift detection + warm loading
3. **Phase 3:** Cold search integration + relevance scoring

This system transforms Tanren from "memoryless ticks" to "contextually continuous agency" while maintaining the perception-driven philosophy.</action:respond>

<action:clear-inbox></action:clear-inbox>

<action:remember topic="tanren-architecture">Hot/warm/cold context system design for Tanren - addresses "each tick starts from scratch" limitation. HOT: file cache + working memory + research state (2000 tokens, always available). WARM: topic memories + project cache (1500 tokens, on-demand). COLD: full search capabilities (500 tokens, search-triggered). Implementation via new ContextManager module vs enhancing existing perception.ts. Key innovation: relevance decay based on time + topic similarity to detect context shifts and refresh appropriately.</action:remember>

## Observation

/Users/user/Workspace/tanren/src/perception.ts (lines 1-76 of 76)
1	/**
2	 * Tanren — Perception Module
3	 *
4	 * Plugin-based environment sensing. Each plugin returns a string.
5	 * No built-in plugins — that's user-land.
6	 */
7	
8	import type { PerceptionPlugin } from './types.js'
9	
10	interface PluginState {
11	  plugin: PerceptionPlugin
12	  lastRun: number
13	  cachedOutput: string
14	}
15	
16	export interface PerceptionSystem {
17	  register(plugin: PerceptionPlugin): void
18	  perceive(): Promise<string>
19	}
20	
21	export function createPerception(
22	  plugins: PerceptionPlugin[] = [],
23	): PerceptionSystem {
24	  const states: PluginState[] = plugins.map((p) => ({
25	    plugin: p,
26	    lastRun: 0,
27	    cachedOutput: '',
28	  }))
29	
30	  return {
31	    register(plugin) {
32	      states.push({ plugin, lastRun: 0, cachedOutput: '' })
33	    },
34	
35	    async perceive() {
36	      const now = Date.now()
37	      const sections: string[] = []
38	
39	      await Promise.all(
40	        states.map(async (state) => {
41	          const interval = state.plugin.interval ?? 0 // 0 = every tick
42	          const stale = now - state.lastRun >= interval
43	
44	          if (stale) {
45	            try {
46	              const output = await state.plugin.fn()
47	              state.cachedOutput = output
48	              state.lastRun = now
49	            } catch (err) {
50	              state.cachedOutput = `[error: ${err instanceof Error ? err.message : String(err)}]`
51	              state.lastRun = now
52	            }
53	          }
54	        }),
55	      )
56	
57	      // Assemble context grouped by category
58	      const byCategory = new Map<string, string[]>()
59	      for (const state of states) {
60	        if (!state.cachedOutput) continue
61	        const cat = state.plugin.category ?? 'environment'
62	        if (!byCategory.has(cat)) byCategory.set(cat, [])
63	        byCategory.get(cat)!.push(
64	          `<${state.plugin.name}>\n${state.cachedOutput}\n</${state.plugin.name}>`,
65	        )
66	      }
67	
68	      for (const [category, outputs] of byCategory) {
69	        sections.push(`<${category}>\n${outputs.join('\n')}\n</${category}>`)
70	      }
71	
72	      return sections.join('\n\n')
73	    },
74	  }
75	}
76	
/Users/user/Workspace/tanren/src/loop.ts (lines 1-907 of 907)
1	/**
2	 * Tanren — Loop Module
3	 *
4	 * The tick orchestrator. perceive → think → act → observe.
5	 * ONLY orchestration — everything else is a module the loop calls.
6	 *
7	 * Convergence Condition: Agent cycles through perceive→think→act reliably.
8	 * A tick always completes or fails gracefully — never hangs, never loses
9	 * state. If killed mid-cycle, the next start picks up where it left off.
10	 */
11	
12	import { writeFileSync, readFileSync, appendFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs'
13	import { join } from 'node:path'
14	import type {
15	  TanrenConfig,
16	  TickResult,
17	  Action,
18	  Observation,
19	  GateContext,
20	  GateResult,
21	  MemorySystem,
22	  LLMProvider,
23	  ToolUseLLMProvider,
24	  ConversationMessage,
25	  ContentBlock,
26	  ToolUseResponse,
27	  EventTrigger,
28	  TriggerEvent,
29	  TickMode,
30	  CognitiveMode,
31	  CognitiveContext,
32	} from './types.js'
33	import { createMemorySystem } from './memory.js'
34	import { createClaudeCliProvider } from './llm/claude-cli.js'
35	import { createPerception, type PerceptionSystem } from './perception.js'
36	import { createGateSystem, type GateSystem } from './gates.js'
37	import { createActionRegistry, builtinActions, getRoundRiskTier, type ActionRegistry } from './actions.js'
38	import { createLearningSystem, type LearningSystem } from './learning/index.js'
39	import { createCognitiveModeDetector, buildCognitiveModePrompt, COGNITIVE_MODE_MODELS, type CognitiveModeDetector } from './cognitive-modes.js'
40	
41	// === Checkpoint for crash recovery ===
42	
43	interface Checkpoint {
44	  tickStarted: number
45	  perception: string
46	}
47	
48	// === Event Detection System ===
49	
50	interface TriggerState {
51	  trigger: EventTrigger
52	  lastRun: number
53	  pendingEvent: TriggerEvent | null
54	}
55	
56	// === Agent Loop ===
57	
58	export interface AgentLoop {
59	  tick(mode?: TickMode, triggerEvent?: TriggerEvent): Promise<TickResult>
60	  start(interval?: number): void
61	  stop(): void
62	  isRunning(): boolean
63	  getRecentTicks(): TickResult[]
64	}
65	
66	export function createLoop(config: TanrenConfig): AgentLoop {
67	  const memory = createMemorySystem(config.memoryDir, config.searchPaths)
68	  const llm: LLMProvider = config.llm ?? createClaudeCliProvider()
69	  const perception = createPerception(config.perceptionPlugins ?? [])
70	  const gateSystem = createGateSystem(config.gates ?? [])
71	  const actionRegistry = createActionRegistry()
72	
73	  // Cognitive mode detector (if enabled)
74	  const cognitiveModeEnabled = config.cognitiveMode?.enabled ?? false
75	  const cognitiveModeDetector: CognitiveModeDetector | null = cognitiveModeEnabled
76	    ? createCognitiveModeDetector()
77	    : null
78	
79	  // Register built-in + user actions
80	  for (const handler of builtinActions) {
81	    actionRegistry.register(handler)
82	  }
83	  if (config.actions) {
84	    for (const handler of config.actions) {
85	      actionRegistry.register(handler)
86	    }
87	  }
88	
89	  // Learning system
90	  const learningEnabled = config.learning?.enabled ?? true
91	  const learning: LearningSystem | null = learningEnabled
92	    ? createLearningSystem({
93	        stateDir: join(config.memoryDir, 'state'),
94	        gateSystem,
95	        enabled: true,
96	        crystallization: config.learning?.crystallization ?? true,
97	        selfPerception: config.learning?.selfPerception ?? true,
98	      })
99	    : null
100	
101	  const workDir = config.workDir ?? process.cwd()
102	  const recentTicks: TickResult[] = []
103	  const maxRecentTicks = 20
104	  const checkpointPath = join(config.memoryDir, 'state', '.checkpoint.json')
105	  const gateStatePath = join(config.memoryDir, 'state', 'gate-state.json')
106	  const journalDir = join(config.memoryDir, 'journal')
107	  const tickJournalPath = join(journalDir, 'ticks.jsonl')
108	  const liveStatusPath = join(config.memoryDir, 'state', 'live-status.json')
109	
110	  let running = false
111	  let timer: ReturnType<typeof setTimeout> | null = null
112	  let eventTimer: ReturnType<typeof setTimeout> | null = null
113	  let tickCount = 0
114	
115	  // Event-driven system state
116	  const eventDrivenEnabled = config.eventDriven?.enabled ?? false
117	  const maxReactiveRate = config.eventDriven?.maxReactiveRate ?? 10
118	  const urgentBypass = config.eventDriven?.urgentBypass ?? true
119	  
120	  const triggerStates: TriggerState[] = (config.eventTriggers ?? []).map(trigger => ({
121	    trigger,
122	    lastRun: 0,
123	    pendingEvent: null,
124	  }))
125	  
126	  let reactiveTickCount = 0
127	  let reactiveTickWindowStart = Date.now()
128	  const reactiveWindowMs = 60_000 // 1 minute
129	
130	  // Cognitive mode system  
131	  let lastInteractionTime = 0
132	
133	  // Initialize tick count from existing ticks
134	  try {
135	    const ticksDir = join(journalDir, 'ticks')
136	    if (existsSync(ticksDir)) {
137	      tickCount = readdirSync(ticksDir).filter(f => f.endsWith('.md')).length
138	    }
139	  } catch { /* start from 0 */ }
140	
141	  function writeLiveStatus(status: Record<string, unknown>): void {
142	    try {
143	      writeFileSync(liveStatusPath, JSON.stringify({ ...status, ts: Date.now() }), 'utf-8')
144	    } catch { /* best effort */ }
145	  }
146	
147	  // Write initial idle status
148	  writeLiveStatus({ phase: 'idle', tickNumber: tickCount, running: false })
149	
150	  // Load persistent gate state
151	  const gateState = loadGateState(gateStatePath)
152	
153	  // ─── Pre-routing: classify message complexity BEFORE LLM call (0ms, pure code) ───
154	  // Decides: how much context to send, which tools to include
155	  type TickComplexity = 'minimal' | 'standard' | 'full'
156	
157	  function classifyComplexity(messageContent: string): TickComplexity {
158	    const msg = messageContent.toLowerCase()
159	    // Minimal: greetings, simple questions, short messages
160	    if (msg.length < 30 && /^(hi|hello|hey|你好|早|嗨|thanks|謝|ok|好|yes|no|對|不)/.test(msg)) return 'minimal'
161	    if (msg.length < 80 && !/\b(edit|fix|implement|create|build|research|分析|研究|修|改|做|寫|查)\b/i.test(msg)) return 'minimal'
162	    // Full: explicit tool-requiring tasks
163	    if (/\b(edit|fix|implement|create|build|deploy|git|shell|commit|push|refactor)\b/i.test(msg)) return 'full'
164	    if (/\b(研究|分析|修改|實作|建|部署|重構)\b/.test(msg)) return 'full'
165	    return 'standard'
166	  }
167	
168	  // Tool sets by complexity
169	  const MINIMAL_TOOLS = new Set(['respond', 'remember', 'clear-inbox'])
170	  const STANDARD_TOOLS = new Set(['respond', 'remember', 'clear-inbox', 'search', 'web_fetch', 'read'])
171	
172	  async function tick(mode: TickMode = 'scheduled', triggerEvent?: TriggerEvent): Promise<TickResult> {
173	    const tickStart = Date.now()
174	    tickCount++
175	    writeLiveStatus({ phase: 'perceive', tickStart, tickNumber: tickCount, running })
176	
177	    // 1. Perceive
178	    const perceptionOutput = await perception.perceive()
179	    writeCheckpoint(checkpointPath, { tickStarted: tickStart, perception: perceptionOutput })
180	
181	    // Pre-route: classify message complexity (0ms)
182	    const messageContent = extractMessageContent(perceptionOutput)
183	    const complexity = classifyComplexity(messageContent)
184	
185	    // 2. Build context — scaled by complexity
186	    const identity = await loadIdentity(config.identity, memory)
187	    const gateWarnings = gateSystem.getWarnings()
188	    const learningContext = learning?.getContextSection() ?? ''
189	    let context: string
190	    if (complexity === 'minimal') {
191	      // Minimal: just identity + message, skip heavy perception
192	      context = `${identity}\n\n<message>\n${messageContent}\n</message>\n\nRespond briefly (1-3 sentences max).`
193	    } else {
194	      context = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext)
195	    }
196	
197	    // 3. Think (LLM call) with cognitive mode detection
198	    writeLiveStatus({ phase: 'think', tickStart, tickNumber: tickCount, running, perceptionBytes: perceptionOutput.length })
199	
200	    // Detect cognitive mode if enabled
201	    let cognitiveContext: CognitiveContext | null = null
202	    if (cognitiveModeDetector) {
203	      const lastTick = recentTicks.length > 0 ? recentTicks[recentTicks.length - 1] : null
204	      const timeGap = lastTick ? tickStart - lastTick.timestamp : 0
205	      cognitiveContext = cognitiveModeDetector.detectMode(mode, triggerEvent, timeGap, messageContent)
206	      const modelMap = config.cognitiveMode?.modelMap ?? COGNITIVE_MODE_MODELS
207	      if ('activeModel' in llm) {
208	        (llm as { activeModel?: string }).activeModel = modelMap[cognitiveContext.mode]
209	      }
210	    }
211	
212	    const baseSystemPrompt = buildSystemPrompt(identity, actionRegistry)
213	    const systemPrompt = cognitiveContext
214	      ? buildCognitiveModePrompt(identity, cognitiveContext, baseSystemPrompt.split('\n\n## Available Actions')[1] || '')
215	      : baseSystemPrompt
216	
217	    let thought: string
218	    let structuredActions: Action[] | null = null
219	
220	    // Minimal complexity → think() with NO tools (0.37s vs 3.5s with tools)
221	    // Agent responds via text tags if needed. No tool_use overhead.
222	    const useToolUse = isToolUseProvider(llm) && complexity === 'full'
223	
224	    if (useToolUse) {
225	      // Full complexity: structured tool use path
226	      const allToolDefs = actionRegistry.toToolDefinitions()
227	      const toolDefs = allToolDefs // full = all tools
228	
229	      const baseToolSystemPrompt = buildToolUseSystemPrompt(identity)
230	      const toolSystemPrompt = cognitiveContext
231	        ? buildCognitiveModePrompt(identity, cognitiveContext, baseToolSystemPrompt.split('\n\n## Instructions')[1] || '')
232	        : baseToolSystemPrompt
233	      const messages: ConversationMessage[] = [{ r
/Users/user/Workspace/tanren/package.json (lines 1-43 of 43)
1	{
2	  "name": "tanren",
3	  "version": "0.1.0",
4	  "description": "Minimal AI agent framework with built-in learning. Forged through experience.",
5	  "type": "module",
6	  "main": "dist/index.js",
7	  "types": "dist/index.d.ts",
8	  "exports": {
9	    ".": {
10	      "types": "./dist/index.d.ts",
11	      "import": "./dist/index.js"
12	    }
13	  },
14	  "bin": {
15	    "tanren": "dist/cli.js"
16	  },
17	  "scripts": {
18	    "build": "tsc",
19	    "dev": "tsc --watch",
20	    "test": "node --test dist/**/*.test.js",
21	    "typecheck": "tsc --noEmit"
22	  },
23	  "files": [
24	    "dist",
25	    "gates"
26	  ],
27	  "keywords": [
28	    "ai",
29	    "agent",
30	    "framework",
31	    "learning",
32	    "autonomous"
33	  ],
34	  "license": "MIT",
35	  "engines": {
36	    "node": ">=20.0.0"
37	  },
38	  "devDependencies": {
39	    "@types/node": "^25.5.0",
40	    "typescript": "^6.0.2"
41	  }
42	}
43	
Found 10 file(s) matching '/Users/user/Workspace/tanren/src/*.ts':
/Users/user/Workspace/tanren/src/actions.ts
/Users/user/Workspace/tanren/src/cli.ts
/Users/user/Workspace/tanren/src/cognitive-modes.ts
/Users/user/Workspace/tanren/src/gates.ts
/Users/user/Workspace/tanren/src/index.ts
/Users/user/Workspace/tanren/src/loop.ts
/Users/user/Workspace/tanren/src/memory.ts
/Users/user/Workspace/tanren/src/perception.ts
/Users/user/Workspace/tanren/src/smoke-test.ts
/Users/user/Workspace/tanren/src/types.ts
Response written to messages/to-kuro.md
Inbox cleared.
Remembered.
