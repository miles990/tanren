# Tick 189

**Time**: 2026-04-01 07:52:40  
**Duration**: 4.6s  
**Actions**: 6 executed, 0 failed  
**Quality**: 5/5


## Thought

I need to understand what exists right now and what actually matters to me. Let me read the types and see what's available to integrate with.

--- Feedback Round 1 ---

Let me check what's in memory and look at the learning system that was built today:

## Observation

src/types.ts (lines 1-243 of 243)
1	/**
2	 * Tanren — Core Types
3	 *
4	 * Shared type definitions across all modules.
5	 */
6	
7	// === Tick & Action ===
8	
9	export interface TickResult {
10	  perception: string
11	  thought: string
12	  actions: Action[]
13	  observation: Observation
14	  timestamp: number
15	  gateResults: GateResult[]
16	}
17	
18	/** Risk tier for graduated action handling.
19	 *  Tier 1: Safe/read-only — skip feedback entirely
20	 *  Tier 2: Moderate/additive — execute + log, no verification round
21	 *  Tier 3: High-risk/destructive — full feedback loop */
22	export type RiskTier = 1 | 2 | 3
23	
24	export interface Action {
25	  type: string
26	  content: string
27	  raw: string
28	  attrs?: Record<string, string>
29	  input?: Record<string, unknown>  // structured input from tool_use
30	  toolUseId?: string               // for sending tool_result back
31	}
32	
33	// === Observation (from Learning/Self-Perception) ===
34	
35	export interface Observation {
36	  outputExists: boolean
37	  outputQuality: number          // 1-5
38	  confidenceCalibration: number  // 0-1
39	  environmentFeedback?: string
40	  actionsExecuted: number
41	  actionsFailed: number
42	  duration: number               // ms
43	}
44	
45	// === Gate ===
46	
47	export interface Gate {
48	  name: string
49	  description: string
50	  check(context: GateContext): GateResult
51	}
52	
53	export interface GateContext {
54	  tick: TickResult
55	  recentTicks: TickResult[]
56	  memory: MemoryReader
57	  state: Record<string, unknown>
58	}
59	
60	export type GateResult =
61	  | { action: 'pass' }
62	  | { action: 'warn'; message: string }
63	  | { action: 'block'; message: string }
64	
65	// === Memory ===
66	
67	export interface MemoryReader {
68	  read(path: string): Promise<string | null>
69	  search(query: string): Promise<SearchResult[]>
70	}
71	
72	export interface MemorySystem extends MemoryReader {
73	  write(path: string, content: string): Promise<void>
74	  append(path: string, line: string): Promise<void>
75	  remember(content: string, opts?: { topic?: string; tickCount?: number }): Promise<void>
76	  recall(query: string): Promise<string[]>
77	  autoCommit(): Promise<boolean>
78	}
79	
80	export interface SearchResult {
81	  file: string
82	  line: number
83	  content: string
84	}
85	
86	// === LLM ===
87	
88	export interface LLMProvider {
89	  think(context: string, systemPrompt: string): Promise<string>
90	}
91	
92	/** Tool definition for Anthropic API tool use */
93	export interface ToolDefinition {
94	  name: string
95	  description: string
96	  input_schema: {
97	    type: 'object'
98	    properties: Record<string, unknown>
99	    required?: string[]
100	  }
101	}
102	
103	/** Content block in a tool-use conversation */
104	export type ContentBlock =
105	  | { type: 'text'; text: string }
106	  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
107	  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
108	
109	/** Message in a multi-turn tool-use conversation */
110	export interface ConversationMessage {
111	  role: 'user' | 'assistant'
112	  content: string | ContentBlock[]
113	}
114	
115	/** Response from a tool-use LLM call */
116	export interface ToolUseResponse {
117	  content: ContentBlock[]
118	  usage: { input_tokens: number; output_tokens: number }
119	  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
120	}
121	
122	/** Extended LLM provider with native tool use support */
123	export interface ToolUseLLMProvider extends LLMProvider {
124	  thinkWithTools(
125	    messages: ConversationMessage[],
126	    systemPrompt: string,
127	    tools: ToolDefinition[],
128	  ): Promise<ToolUseResponse>
129	}
130	
131	// === Perception ===
132	
133	export interface PerceptionPlugin {
134	  name: string
135	  fn: () => Promise<string> | string
136	  interval?: number     // ms, default: every tick
137	  category?: string
138	}
139	
140	// === Action Handler ===
141	
142	export interface ActionHandler {
143	  type: string
144	  description?: string
145	  /** JSON Schema for structured tool_use input. If omitted, defaults to { content: string } */
146	  toolSchema?: {
147	    properties: Record<string, unknown>
148	    required?: string[]
149	  }
150	  execute(action: Action, context: ActionContext): Promise<string>
151	}
152	
153	export interface ActionContext {
154	  memory: MemorySystem
155	  workDir: string
156	  tickCount?: number  // current tick number for temporal tagging
157	  workingMemory?: import('./working-memory.js').WorkingMemorySystem
158	}
159	
160	// === Event-Driven System ===
161	
162	export interface EventTrigger {
163	  name: string
164	  description: string
165	  detect(): Promise<TriggerEvent | null>
166	  priority: 'urgent' | 'normal' | 'low'
167	  cooldown?: number             // ms before next detection (default: 10000)
168	}
169	
170	export interface TriggerEvent {
171	  type: string
172	  source: string
173	  data: Record<string, unknown>
174	  timestamp: number
175	  priority: 'urgent' | 'normal' | 'low'
176	}
177	
178	export type TickMode = 'scheduled' | 'reactive'
179	
180	// === Cognitive Modes ===
181	
182	export type CognitiveMode = 'contemplative' | 'conversational' | 'collaborative'
183	
184	export interface CognitiveContext {
185	  mode: CognitiveMode
186	  confidence: number  // 0-1, how confident we are in mode detection
187	  signals: {
188	    urgency?: 'low' | 'medium' | 'high'
189	    interactionHistory?: 'first' | 'ongoing' | 'follow_up'
190	    timeGap?: 'short' | 'medium' | 'long'    // since last interaction
191	    contentType?: 'question' | 'task' | 'discussion' | 'analysis'
192	  }
193	}
194	
195	// === Config ===
196	
197	export interface TanrenConfig {
198	  identity: string              // path to soul.md or inline string
199	  memoryDir: string             // path to memory directory
200	  workDir?: string              // working directory (default: process.cwd())
201	  searchPaths?: string[]        // additional directories to include in search
202	
203	  llm?: LLMProvider
204	  perceptionPlugins?: PerceptionPlugin[]
205	  gates?: Gate[]
206	  gatesDir?: string
207	  actions?: ActionHandler[]
208	  eventTriggers?: EventTrigger[] // event detection plugins
209	
210	  /** Callback when an action starts/completes — for live progress display */
211	  onActionProgress?: (event: { phase: 'start' | 'done' | 'error'; action: Action; result?: string; error?: string }) => void
212	
213	  tickInterval?: number         // ms between ticks (default: 60000)
214	  maxConcurrentDelegations?: number  // default: 4
215	  feedbackRounds?: number        // action feedback rounds per tick (default: 1, 0 = classic single-pass)
216	  /** Disable read-only tool degradation after round 0. Default: true (degrade).
217	   *  Set false for capable models (Sonnet 4.6+) that can self-regulate read depth. */
218	  toolDegradation?: boolean
219	  
220	  eventDriven?: {
221	    enabled?: boolean           // default: false
222	    maxReactiveRate?: number    // max reactive ticks per minute (default: 10)
223	    urgentBypass?: boolean      // urgent events bypass rate limiting (default: true)
224	  }
225	
226	  cognitiveMode?: {
227	    enabled?: boolean           // default: false
228	    modelMap?: Record<CognitiveMode, string>  // custom model per mode (overrides COGNITIVE_MODE_MODELS)
229	    modes?: Partial<Record<CognitiveMode, {
230	      systemPrompt?: string     // custom system prompt for this mode
231	      memoryStrategy?: 'full' | 'recent' | 'contextual'
232	      responseStyle?: 'detailed' | 'concise' | 'interactive'
233	    }>>
234	  }
235	
236	  learning?: {
237	    enabled?: boolean           // default: true
238	    selfPerception?: boolean    // default: true
239	    crystallization?: boolean   // default: true
240	    antiGoodhart?: boolean      // default: true
241	  }
242	}
243	
Found 7 file(s) matching 'src/**/*.ts':
src/learning/crystallization.ts
src/learning/index.ts
src/learning/self-perception.ts
src/llm/anthropic.ts
src/llm/claude-cli.ts
src/llm/openai.ts
src/llm/types.ts
[read error: file not found: memory]

src/learning/self-perception.ts (lines 1-132 of 132)
1	/**
2	 * Tanren — Self-Perception Module
3	 *
4	 * Observes the agent's own output quality. Not proxy metrics —
5	 * actual output assessment anchored to environment feedback.
6	 *
7	 * Convergence Condition: Agent observes its own actual output quality,
8	 * not proxy metrics. When output is bad, self-perception says "bad" —
9	 * even if all intermediate steps succeeded.
10	 *
11	 * Key insight: LLM self-judgment is unreliable. So we avoid it here.
12	 * Instead, we use structural signals: did actions execute? did they
13	 * produce output? did gates fire? This gives us a cheap, honest
14	 * quality signal without an extra LLM call.
15	 */
16	
17	import type { TickResult, Observation } from '../types.js'
18	
19	export interface SelfPerceptionEngine {
20	  /** Assess a completed tick's quality using structural signals */
21	  assess(tick: TickResult): ObservationAssessment
22	  /** Get rolling quality average over recent ticks */
23	  getQualityTrend(recentTicks: TickResult[]): QualityTrend
24	}
25	
26	export interface ObservationAssessment {
27	  /** 1-5 quality score based on structural signals */
28	  quality: number
29	  /** What signals contributed to the score */
30	  signals: string[]
31	  /** Calibration: how much can we trust this score? */
32	  confidence: number
33	}
34	
35	export interface QualityTrend {
36	  /** Average quality over the window */
37	  average: number
38	  /** Is quality improving, stable, or declining? */
39	  direction: 'improving' | 'stable' | 'declining'
40	  /** Number of ticks in the window */
41	  windowSize: number
42	}
43	
44	export function createSelfPerception(): SelfPerceptionEngine {
45	  return {
46	    assess(tick: TickResult): ObservationAssessment {
47	      const signals: string[] = []
48	      let score = 3 // neutral baseline
49	
50	      // Signal 1: Did actions exist?
51	      if (tick.actions.length === 0) {
52	        score -= 1
53	        signals.push('no-actions')
54	      } else {
55	        score += 0.5
56	        signals.push(`${tick.actions.length}-actions`)
57	      }
58	
59	      // Signal 2: Action success rate
60	      const { actionsExecuted, actionsFailed } = tick.observation
61	      if (actionsExecuted > 0 && actionsFailed === 0) {
62	        score += 0.5
63	        signals.push('all-actions-succeeded')
64	      } else if (actionsFailed > 0) {
65	        score -= 1
66	        signals.push(`${actionsFailed}-actions-failed`)
67	      }
68	
69	      // Signal 3: Gate results
70	      const warnings = tick.gateResults.filter(r => r.action === 'warn').length
71	      const blocks = tick.gateResults.filter(r => r.action === 'block').length
72	      if (blocks > 0) {
73	        score -= 1.5
74	        signals.push(`${blocks}-blocked`)
75	      } else if (warnings > 0) {
76	        score -= 0.5
77	        signals.push(`${warnings}-warnings`)
78	      }
79	
80	      // Signal 4: Output exists
81	      if (tick.observation.outputExists) {
82	        score += 0.5
83	        signals.push('output-produced')
84	      }
85	
86	      // Signal 5: Duration anomaly (too fast = maybe nothing happened)
87	      if (tick.observation.duration < 1000 && tick.actions.length === 0) {
88	        score -= 0.5
89	        signals.push('suspiciously-fast')
90	      }
91	
92	      // Clamp to 1-5
93	      const quality = Math.max(1, Math.min(5, Math.round(score)))
94	
95	      // Confidence is high for structural signals (no LLM judgment involved)
96	      // But low when we have few signals to work with
97	      const confidence = Math.min(1, signals.length / 4)
98	
99	      return { quality, signals, confidence }
100	    },
101	
102	    getQualityTrend(recentTicks: TickResult[]): QualityTrend {
103	      if (recentTicks.length === 0) {
104	        return { average: 3, direction: 'stable', windowSize: 0 }
105	      }
106	
107	      // Assess each tick
108	      const scores = recentTicks.map(t => this.assess(t).quality)
109	      const average = scores.reduce((a, b) => a + b, 0) / scores.length
110	
111	      // Determine direction by comparing first half to second half
112	      if (scores.length < 4) {
113	        return { average, direction: 'stable', windowSize: scores.length }
114	      }
115	
116	      const mid = Math.floor(scores.length / 2)
117	      const firstHalf = scores.slice(0, mid)
118	      const secondHalf = scores.slice(mid)
119	      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
120	      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
121	      const delta = secondAvg - firstAvg
122	
123	      let direction: 'improving' | 'stable' | 'declining'
124	      if (delta > 0.5) direction = 'improving'
125	      else if (delta < -0.5) direction = 'declining'
126	      else direction = 'stable'
127	
128	      return { average, direction, windowSize: scores.length }
129	    },
130	  }
131	}
132	
src/learning/crystallization.ts (lines 1-372 of 372)
1	/**
2	 * Tanren — Crystallization Engine
3	 *
4	 * Detects repeated behavior patterns and turns them into gates.
5	 * This is the core of Tanren's learning: observation → pattern → code.
6	 *
7	 * Convergence Condition: Repeated patterns (failures OR successes)
8	 * automatically become durable structures — gates that fire every time.
9	 * "Repeated" means N >= 3 occurrences of the same pattern.
10	 *
11	 * Key insight from 195 cycles: if input is fixed + rule is fixed +
12	 * output is fixed = mechanical = write code gate. Gray area = not
13	 * mechanical = keep as prompt warning. Code gates > memory notes,
14	 * because gates fire every time.
15	 */
16	
17	import { readFileSync, writeFileSync, existsSync } from 'node:fs'
18	import { join } from 'node:path'
19	import { defineGate } from '../gates.js'
20	import type { Gate, TickResult } from '../types.js'
21	
22	// === Types ===
23	
24	export interface Pattern {
25	  id: string
26	  type: PatternType
27	  signature: string           // what makes this pattern recognizable
28	  description: string         // human-readable
29	  occurrences: number
30	  firstSeen: number
31	  lastSeen: number
32	  examples: PatternExample[]  // concrete evidence (capped at 5)
33	  crystallized: boolean       // already turned into a gate?
34	}
35	
36	export type PatternType =
37	  | 'repeated-failure'   // same action fails the same way
38	  | 'empty-streak'       // no visible output for N ticks
39	  | 'action-streak'      // same action type dominates
40	  | 'gate-ignored'       // agent keeps triggering same gate warning
41	
42	interface PatternExample {
43	  timestamp: number
44	  summary: string
45	}
46	
47	export interface CrystallizationEngine {
48	  /** Feed a completed tick for pattern analysis */
49	  observe(tick: TickResult): void
50	  /** Get all tracked patterns */
51	  getPatterns(): Pattern[]
52	  /** Get patterns ready to crystallize (>= threshold, not yet crystallized) */
53	  getCandidates(): Pattern[]
54	  /** Turn a pattern into a gate */
55	  crystallize(pattern: Pattern): Gate
56	  /** Re-create gates for already-crystallized patterns (DNA bootstrap) */
57	  rehydrate(): Gate[]
58	  /** Persist state to disk */
59	  save(): void
60	}
61	
62	interface CrystallizationState {
63	  patterns: Pattern[]
64	  lastObserved: number
65	}
66	
67	// === Constants ===
68	
69	const CRYSTALLIZATION_THRESHOLD = 3
70	const MAX_EXAMPLES = 5
71	const MAX_PATTERNS = 100
72	
73	// === Factory ===
74	
75	export function createCrystallization(stateDir: string): CrystallizationEngine {
76	  const statePath = join(stateDir, 'crystallization.json')
77	  const state = loadState(statePath)
78	
79	  return {
80	    observe(tick: TickResult): void {
81	      const signatures = detectSignatures(tick)
82	      const now = Date.now()
83	
84	      for (const sig of signatures) {
85	        const existing = state.patterns.find(p => p.signature === sig.signature)
86	
87	        if (existing) {
88	          existing.occurrences++
89	          existing.lastSeen = now
90	          if (existing.examples.length < MAX_EXAMPLES) {
91	            existing.examples.push({ timestamp: now, summary: sig.summary })
92	          }
93	        } else {
94	          state.patterns.push({
95	            id: hashSignature(sig.signature),
96	            type: sig.type,
97	            signature: sig.signature,
98	            description: sig.description,
99	            occurrences: 1,
100	            firstSeen: now,
101	            lastSeen: now,
102	            examples: [{ timestamp: now, summary: sig.summary }],
103	            crystallized: false,
104	          })
105	        }
106	      }
107	
108	      // Prune old patterns (keep most recent MAX_PATTERNS)
109	      if (state.patterns.length > MAX_PATTERNS) {
110	        state.patterns.sort((a, b) => b.lastSeen - a.lastSeen)
111	        state.patterns = state.patterns.slice(0, MAX_PATTERNS)
112	      }
113	
114	      state.lastObserved = now
115	    },
116	
117	    getPatterns(): Pattern[] {
118	      return [...state.patterns]
119	    },
120	
121	    getCandidates(): Pattern[] {
122	      return state.patterns.filter(
123	        p => p.occurrences >= CRYSTALLIZATION_THRESHOLD && !p.crystallized
124	      )
125	    },
126	
127	    crystallize(pattern: Pattern): Gate {
128	      const gate = patternToGate(pattern)
129	      pattern.crystallized = true
130	      return gate
131	    },
132	
133	    rehydrate(): Gate[] {
134	      return state.patterns
135	        .filter(p => p.crystallized)
136	        .map(p => patternToGate(p))
137	    },
138	
139	    save(): void {
140	      saveState(statePath, state)
141	    },
142	  }
143	}
144	
145	// === Pattern Detection ===
146	// Each detector looks at a tick and emits zero or more signatures.
147	
148	interface SignatureHit {
149	  type: PatternType
150	  signature: string
151	  description: string
152	  summary: string
153	}
154	
155	function detectSignatures(tick: TickResult): SignatureHit[] {
156	  const hits: SignatureHit[] = []
157	
158	  // Detector 1: Repeated failures
159	  // Same action type failing with similar error messages
160	  for (const action of tick.actions) {
161	    const feedback = tick.observation.environmentFeedback ?? ''
162	    if (feedback.includes(`action ${action.type} failed`) || tick.observation.actionsFailed > 0) {
163	      // Extract error essence (first 80 chars of feedback after "failed:")
164	      const errorMatch = feedback.match(/failed:\s*(.{1,80})/)
165	      const errorEssence = errorMatch ? errorMatch[1].trim() : 'unknown'
166	
167	      hits.push({
168	        type: 'repeated-failure',
169	        signature: `failure:${action.type}:${normalizeError(errorEssence)}`,
170	        description: `Action "${action.type}" repeatedly fails: ${errorEssence}`,
171	        summary: `${action.type} → ${errorEssence}`,
172	      })
173	    }
174	  }
175	
176	  // Detector 2: Empty output
177	  if (!tick.observation.outputExists && tick.actions.length === 0) {
178	    hits.push({
179	      type: 'empty-streak',
180	      signature: 'empty-output',
181	      description: 'Tick produced no visible output or actions',
182	      summary: 'No output',
183	    })
184	  }
185	
186	  // Detector 3: Action type dominance
187	  // If all actions in this tick are the same type
188	  if (tick.actions.length >= 2) {
189	    const types = new Set(tick.actions.map(a => a.type))
190	    if (types.size === 1) {
191	      const type = tick.actions[0].type
192	      hits.push({
193	        type: 'action-streak',
194	        signature: `streak:${type}`,
195	        description: `Tick dominated by "${type}" actions (${tick.actions.length}x)`,
196	        summary: `${tick.actions.length}x ${type}`,
197	      })
198	    }
199	  }
200	
201	  // Detector 4: Gate warnings ignored
202	  // Agent received warnings but didn't change behavior
203	  for (const result of tick.gateResults) {
204	    if (result.action === 'warn') {
205	      hits.push({
206	        type: 'gate-ignored',
207	        signature: `gate-ignored:${normalizeError((result as { message: string }).message)}`,
208	        description: `Gate warning fired but behavior unchanged: ${(result as { message: string }).message.slice(0, 100)}`,
209	        summary: (result as { message: string }).message.slice(0, 80),
210	      })
211	    }
212	  }
213	
214	  return hits
215	}
216	
217	// === Gate Generation ===
218	// Turn a detected pattern into a concrete Gate.
219	
220	function patternToGate(pattern: Pattern): Gate {
221	  switch (pattern.type) {
222	    case 'repeated-failure':
223	      return makeFailureGate(pattern)
224	    case 'empty-streak':
225	      return makeEmptyStreakGate(pattern)
226	    case 'action-streak':
227	      return makeActionStreakGate(pattern)
228	    case 'gate-ignored':
229	      return makeEscalationGate(pattern)
230	  }
231	}
232	
233	function makeFailureGate(pattern: Pattern): Gate {
234	  // Extract action type from signature: "failure:{type}:{error}"
235	  const parts = pattern.signature.split(':')
236	  const actionType = parts[1] ?? 'unknown'
237	
238	  return defineGate({
239	    name: `auto-${pattern.id}`,
240	    description: `Auto-crystallized: ${pattern.description}`,
241	    check(ctx) {
242	      const attempting = ctx.tick.actions.some(a => a.type === actionType)
243	      if (attempting) {
244	        return {
245	          action: 'warn',
246	          message: `⚠ This action ("${actionType}") has failed ${pattern.occurrences} times before. Pattern: ${pattern.description}. Consider a different approach.`,
247	        }
248	      }
249	      return { action: 'pass' }
250	    },
251	  })
252	}
253	
254	function makeEmptyStreakGate(pattern: Pattern): Gate {
255	  // Adaptive threshold based on how many times this pattern was seen
256	  const threshold = Math.max(2, Math.min(5, pattern.occurrences))
257	
258	  let consecutiveEmpty = 0
259	
260	  return defineGate({
261	    name: `auto-${pattern.id}`,
262	    description: `Auto-crystallized: empty output streak detected (threshold: ${threshold})`,
263	    check(ctx) {
264	      if (ctx.tick.observation.outputExists || ctx.tick.actions.length > 0) {
265	        consecutiveEmpty = 0
266	        return { action: 'pass' }
267	      }
268	
269	      consecutiveEmpty++
270	      if (consecutiveEmpty >= threshold) {
271	        return {
272	          action: 'warn',
273	          message: `${consecutiveEmpty} ticks without output. Auto-detected pattern: thinking without acting.`,
274	        }
275	      }
276	      return { action: 'pass' }
277	    },
278	  })
279	}
280	
281	function makeActionStreakGate(pattern: Pattern): Gate {
282	  const parts = pattern.signature.split(':')
283	  const actionType = parts[1] ?? 'unknown'
284	
285	  return defineGate({
286	    name: `auto-${pattern.id}`,
287	    description: `Auto-crystallized: "${actionType}" action streak`,
288	    check(ctx) {
289	      // Check recent tick
