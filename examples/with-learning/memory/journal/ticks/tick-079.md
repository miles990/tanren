# Tick 079

**Time**: 2026-03-30 21:36:12  
**Duration**: 25.3s  
**Actions**: 11 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 13 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

I need to continue implementing the three cognitive modes. Let me first check what's been done so far.

--- Feedback Round 1 ---



--- Feedback Round 2 ---



--- Feedback Round 3 ---



--- Feedback Round 4 ---

Let me check the current agent structure to see what needs to be implemented:

--- Feedback Round 5 ---



--- Feedback Round 6 ---



--- Feedback Round 7 ---

Great! I can see there's already a cognitive-modes.ts file in the examples/with-learning/memory/src/ directory. Let me examine it:

--- Feedback Round 8 ---

Now let me check if there's a types file that defines the interfaces:

--- Feedback Round 9 ---



--- Feedback Round 10 ---

Let me check the main types file and see if I need to add the cognitive mode types:

## Observation

journal/ticks/tick-069.md:17: Let me search for files related to the cognitive mode implementation:
journal/ticks/tick-078.md:58: journal/ticks/tick-069.md:17: Let me search for files related to the cognitive mode implementation:
journal/ticks/tick-077.md:58: journal/ticks/tick-069.md:17: Let me search for files related to the cognitive mode implementation:
Found 1 file(s) matching '**/*cognitive*':
.
Found 1 file(s) matching '**/*mode*':
.
Found 7 file(s) matching 'src/**/*.ts':
src/learning/crystallization.ts
src/learning/index.ts
src/learning/self-perception.ts
src/llm/anthropic.ts
src/llm/claude-cli.ts
src/llm/openai.ts
src/llm/types.ts
Found 1 file(s) matching '*.ts':
.
./dist/loop.d.ts
./dist/llm/openai.d.ts
./dist/llm/anthropic.d.ts
./dist/llm/types.d.ts
./dist/llm/claude-cli.d.ts
./dist/types.d.ts
./dist/learning/self-perception.d.ts
./dist/learning/crystallization.d.ts
./dist/learning/index.d.ts
./dist/memory.d.ts
./dist/cli.d.ts
./dist/smoke-test.d.ts
./dist/gates.d.ts
./dist/perception.d.ts
./dist/index.d.ts
./dist/actions.d.ts
./node_modules/@types/node/compatibility/iterators.d.ts
./node_modules/@types/node/path.d.ts
./node_modules/@types/node/constants.d.ts
./node_modules/@types/node/domain.d.ts
./node_modules/@types/node/diagnostics_channel.d.ts
./node_modules/@types/node/globals.d.ts
./node_modules/@types/node/sea.d.ts
./node_modules/@types/node/string_decoder.d.ts
./node_modules/@types/node/tls.d.ts
./node_modules/@types/node/tty.d.ts
./node_modules/@types/node/punycode.d.ts
./node_modules/@types/node/readline.d.ts
./node_modules/@types/node/crypto.d.ts
./node_modules/@types/node/trace_events.d.ts
./node_modules/@types/node/test/reporters.d.ts
./node_modules/@types/node/events.d.ts
./node_modules/@types/node/util/types.d.ts
./node_modules/@types/node/os.d.ts
./node_modules/@types/node/buffer.d.ts
./node_modules/@types/node/querystring.d.ts
./node_modules/@types/node/inspector/promises.d.ts
./node_modules/@types/node/worker_threads.d.ts
./node_modules/@types/node/timers/promises.d.ts
./node_modules/@types/node/console.d.ts
./node_modules/@types/node/async_hooks.d.ts
./node_modules/@types/node/path/win32.d.ts
./node_modules/@types/node/path/posix.d.ts
./node_modules/@types/node/stream/consumers.d.ts
./node_modules/@types/node/stream/web.d.ts
./node_modules/@types/node/stream/promises.d.ts
./node_modules/@types/node/dns.d.ts
./node_modules/@types/node/readline/promises.d.ts
./node_modules/@types/node/vm.d.ts
./node_modules/@types/node/web-globals/messaging.d.ts
./node_modules/@types/node/web-globals/encoding.d.ts
./node_modules/@types/node/web-globals/streams.d.ts
./node_modules/@types/node/web-globals/crypto.d.ts
./node_m
./examples/minimal/run.ts
./examples/with-learning/memory/src/cognitive-modes.ts
./examples/with-learning/run.ts
./src/llm/claude-cli.ts
./src/llm/anthropic.ts
./src/llm/openai.ts
./src/llm/types.ts
./src/perception.ts
./src/loop.ts
./src/learning/self-perception.ts
./src/learning/crystallization.ts
./src/learning/index.ts
./src/cli.ts
./src/types.ts
./src/smoke-test.ts
./src/gates.ts
./src/actions.ts
./src/memory.ts
./src/index.ts
examples/with-learning/memory/src/cognitive-modes.ts (lines 1-248 of 248)
1	/**
2	 * Tanren — Cognitive Modes
3	 *
4	 * Multi-modal cognitive architecture for dynamic interaction styles.
5	 * Detects cognitive context and adapts system prompt accordingly.
6	 */
7	
8	import type { CognitiveMode, CognitiveContext, TickMode, TriggerEvent } from './types.js'
9	
10	export interface CognitiveModeDetector {
11	  detectMode(
12	    tickMode: TickMode,
13	    triggerEvent?: TriggerEvent,
14	    timeGap?: number,
15	    messageContent?: string
16	  ): CognitiveContext
17	}
18	
19	export function createCognitiveModeDetector(): CognitiveModeDetector {
20	  return {
21	    detectMode(tickMode, triggerEvent, timeGap = 0, messageContent = '') {
22	      // Detection logic based on multiple signals
23	      const signals = {
24	        urgency: detectUrgency(triggerEvent, messageContent),
25	        interactionHistory: detectInteractionHistory(timeGap),
26	        timeGap: categorizeTimeGap(timeGap),
27	        contentType: detectContentType(messageContent)
28	      }
29	
30	      // Mode detection logic
31	      const mode = determineMode(tickMode, signals)
32	      const confidence = calculateConfidence(signals)
33	
34	      return {
35	        mode,
36	        confidence,
37	        signals
38	      }
39	    }
40	  }
41	}
42	
43	function detectUrgency(triggerEvent?: TriggerEvent, content?: string): 'low' | 'medium' | 'high' {
44	  // High urgency: urgent events or explicit urgency markers
45	  if (triggerEvent?.priority === 'urgent') return 'high'
46	  if (content && hasUrgencyMarkers(content)) return 'high'
47	  
48	  // Medium urgency: normal priority events or interactive patterns
49	  if (triggerEvent?.priority === 'normal') return 'medium'
50	  if (content && hasInteractiveMarkers(content)) return 'medium'
51	  
52	  return 'low'
53	}
54	
55	function detectInteractionHistory(timeGap: number): 'first' | 'ongoing' | 'follow_up' {
56	  const minutes = timeGap / (1000 * 60)
57	  
58	  if (minutes < 2) return 'follow_up'    // Very recent interaction
59	  if (minutes < 30) return 'ongoing'     // Same session
60	  return 'first'                         // New interaction
61	}
62	
63	function categorizeTimeGap(timeGap: number): 'short' | 'medium' | 'long' {
64	  const minutes = timeGap / (1000 * 60)
65	  
66	  if (minutes < 5) return 'short'
67	  if (minutes < 60) return 'medium'
68	  return 'long'
69	}
70	
71	function detectContentType(content: string): 'question' | 'task' | 'discussion' | 'analysis' {
72	  const lower = content.toLowerCase()
73	  
74	  // Question patterns
75	  if (lower.includes('?') || 
76	      lower.match(/^(what|how|why|when|where|who|can you|could you|would you)/)) {
77	    return 'question'
78	  }
79	  
80	  // Task patterns
81	  if (lower.match(/(implement|create|build|fix|complete|finish|do this|make)/)) {
82	    return 'task'
83	  }
84	  
85	  // Analysis patterns
86	  if (lower.match(/(analyze|evaluate|review|research|investigate|explore)/)) {
87	    return 'analysis'
88	  }
89	  
90	  return 'discussion'
91	}
92	
93	function determineMode(tickMode: TickMode, signals: CognitiveContext['signals']): CognitiveMode {
94	  // Reactive ticks with high urgency → Conversational
95	  if (tickMode === 'reactive' && signals.urgency === 'high') {
96	    return 'conversational'
97	  }
98	  
99	  // Task-focused content → Collaborative
100	  if (signals.contentType === 'task') {
101	    return 'collaborative'
102	  }
103	  
104	  // Quick follow-ups → Conversational
105	  if (signals.interactionHistory === 'follow_up' && signals.timeGap === 'short') {
106	    return 'conversational'
107	  }
108	  
109	  // Questions with medium/high urgency → Conversational
110	  if (signals.contentType === 'question' && signals.urgency !== 'low') {
111	    return 'conversational'
112	  }
113	  
114	  // Long time gaps or analysis requests → Contemplative
115	  if (signals.timeGap === 'long' || signals.contentType === 'analysis') {
116	    return 'contemplative'
117	  }
118	  
119	  // Default for scheduled ticks
120	  return 'contemplative'
121	}
122	
123	function calculateConfidence(signals: CognitiveContext['signals']): number {
124	  let confidence = 0.6  // Base confidence
125	  
126	  // High confidence indicators
127	  if (signals.urgency === 'high') confidence += 0.2
128	  if (signals.contentType === 'task') confidence += 0.15
129	  if (signals.interactionHistory === 'follow_up') confidence += 0.1
130	  
131	  // Medium confidence indicators
132	  if (signals.contentType === 'question') confidence += 0.1
133	  if (signals.timeGap === 'short') confidence += 0.05
134	  
135	  return Math.min(confidence, 1.0)
136	}
137	
138	function hasUrgencyMarkers(content: string): boolean {
139	  const urgentPatterns = [
140	    /urgent/i,
141	    /asap/i,
142	    /immediately/i,
143	    /right now/i,
144	    /emergency/i,
145	    /critical/i,
146	    /!!!/,
147	    /🚨/
148	  ]
149	  
150	  return urgentPatterns.some(pattern => pattern.test(content))
151	}
152	
153	function hasInteractiveMarkers(content: string): boolean {
154	  const interactivePatterns = [
155	    /quick question/i,
156	    /briefly/i,
157	    /just wondering/i,
158	    /can you/i,
159	    /could you/i,
160	    /^hey/i,
161	    /^hi/i
162	  ]
163	  
164	  return interactivePatterns.some(pattern => pattern.test(content))
165	}
166	
167	export function buildCognitiveModePrompt(
168	  identity: string, 
169	  cognitiveContext: CognitiveContext,
170	  actionsSection: string
171	): string {
172	  const { mode, confidence, signals } = cognitiveContext
173	  
174	  // Base identity remains the same
175	  let prompt = identity
176	
177	  // Mode-specific cognitive instructions
178	  switch (mode) {
179	    case 'conversational':
180	      prompt += `
181	
182	## Current Cognitive Mode: Conversational
183	*Confidence: ${Math.round(confidence * 100)}%*
184	
185	You're in **conversational mode** — prioritize immediate, helpful responses. This detected from:
186	- Urgency: ${signals.urgency}
187	- Interaction: ${signals.interactionHistory} 
188	- Content type: ${signals.contentType}
189	
190	**Conversational Mode Guidelines:**
191	- Respond quickly and directly to the immediate need
192	- Use concise, actionable language
193	- Don't over-analyze or dive deep unless specifically asked
194	- Ask clarifying questions if the request is ambiguous
195	- Use 'respond' tool to communicate back immediately
196	- Memory access: focus on recent, relevant context only`
197	      break
198	
199	    case 'collaborative':
200	      prompt += `
201	
202	## Current Cognitive Mode: Collaborative  
203	*Confidence: ${Math.round(confidence * 100)}%*
204	
205	You're in **collaborative mode** — working together on tasks. This detected from:
206	- Content type: ${signals.contentType}
207	- Urgency: ${signals.urgency}
208	- Time context: ${signals.timeGap}
209	
210	**Collaborative Mode Guidelines:**
211	- Break down tasks into concrete steps
212	- Show your work and reasoning process  
213	- Use tools actively (read, write, edit, explore)
214	- Commit progress incrementally
215	- Ask for feedback at decision points
216	- Balance speed with thoroughness
217	- Document decisions and trade-offs`
218	      break
219	
220	    case 'contemplative':
221	      prompt += `
222	
223	## Current Cognitive Mode: Contemplative
224	*Confidence: ${Math.round(confidence * 100)}%*
225	
226	You're in **contemplative mode** — deep thinking and analysis. This detected from:
227	- Time gap: ${signals.timeGap}
228	- Content type: ${signals.contentType} 
229	- Interaction pattern: ${signals.interactionHistory}
230	
231	**Contemplative Mode Guidelines:**
232	- Take time to think through problems deeply
233	- Explore multiple perspectives and connections
234	- Use memory system extensively (search, remember, write)
235	- Build comprehensive understanding before acting
236	- Make connections to existing knowledge
237	- Quality over speed — let ideas develop naturally
238	- Document insights for future reference`
239	      break
240	  }
241	
242	  // Add actions section
243	  if (actionsSection) {
244	    prompt += `\n\n## Available Actions\n${actionsSection}`
245	  }
246	
247	  return prompt
248	}
[read error: file not found: examples/with-learning/memory/src/types.ts]
Found 1 file(s) matching 'examples/with-learning/**/*types*':
.
src/types.ts (lines 1-228 of 228)
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
18	export interface Action {
19	  type: string
20	  content: string
21	  raw: string
22	  attrs?: Record<string, string>
23	  input?: Record<string, unknown>  // structured input from tool_use
24	  toolUseId?: string               // for sending tool_result back
25	}
26	
27	// === Observation (from Learning/Self-Perception) ===
28	
29	export interface Observation {
30	  outputExists: boolean
31	  outputQuality: number          // 1-5
32	  confidenceCalibration: number  // 0-1
33	  environmentFeedback?: string
34	  actionsExecuted: number
35	  actionsFailed: number
36	  duration: number               // ms
37	}
38	
39	// === Gate ===
40	
41	export interface Gate {
42	  name: string
43	  description: string
44	  check(context: GateContext): GateResult
45	}
46	
47	export interface GateContext {
48	  tick: TickResult
49	  recentTicks: TickResult[]
50	  memory: MemoryReader
51	  state: Record<string, unknown>
52	}
53	
54	export type GateResult =
55	  | { action: 'pass' }
56	  | { action: 'warn'; message: string }
57	  | { action: 'block'; message: string }
58	
59	// === Memory ===
60	
61	export interface MemoryReader {
62	  read(path: string): Promise<string | null>
63	  search(query: string): Promise<SearchResult[]>
64	}
65	
66	export interface MemorySystem extends MemoryReader {
67	  write(path: string, content: string): Promise<void>
68	  append(path: string, line: string): Promise<void>
69	  remember(content: string, opts?: { topic?: string }): Promise<void>
70	  recall(query: string): Promise<string[]>
71	  autoCommit(): Promise<boolean>
72	}
73	
74	export interface SearchResult {
75	  file: string
76	  line: number
77	  content: string
78	}
79	
80	// === LLM ===
81	
82	export interface LLMProvider {
83	  think(context: string, systemPrompt: string): Promise<string>
84	}
85	
86	/** Tool definition for Anthropic API tool use */
87	export interface ToolDefinition {
88	  name: string
89	  description: string
90	  input_schema: {
91	    type: 'object'
92	    properties: Record<string, unknown>
93	    required?: string[]
94	  }
95	}
96	
97	/** Content block in a tool-use conversation */
98	export type ContentBlock =
99	  | { type: 'text'; text: string }
100	  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
101	  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
102	
103	/** Message in a multi-turn tool-use conversation */
104	export interface ConversationMessage {
105	  role: 'user' | 'assistant'
106	  content: string | ContentBlock[]
107	}
108	
109	/** Response from a tool-use LLM call */
110	export interface ToolUseResponse {
111	  content: ContentBlock[]
112	  usage: { input_tokens: number; output_tokens: number }
113	  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
114	}
115	
116	/** Extended LLM provider with native tool use support */
117	export interface ToolUseLLMProvider extends LLMProvider {
118	  thinkWithTools(
119	    messages: ConversationMessage[],
120	    systemPrompt: string,
121	    tools: ToolDefinition[],
122	  ): Promise<ToolUseResponse>
123	}
124	
125	// === Perception ===
126	
127	export interface PerceptionPlugin {
128	  name: string
129	  fn: () => Promise<string> | string
130	  interval?: number     // ms, default: every tick
131	  category?: string
132	}
133	
134	// === Action Handler ===
135	
136	export interface ActionHandler {
137	  type: string
138	  description?: string
139	  /** JSON Schema for structured tool_use input. If omitted, defaults to { content: string } */
140	  toolSchema?: {
141	    properties: Record<string, unknown>
142	    required?: string[]
143	  }
144	  execute(action: Action, context: ActionContext): Promise<string>
145	}
146	
147	export interface ActionContext {
148	  memory: MemorySystem
149	  workDir: string
150	}
151	
152	// === Event-Driven System ===
153	
154	export interface EventTrigger {
155	  name: string
156	  description: string
157	  detect(): Promise<TriggerEvent | null>
158	  priority: 'urgent' | 'normal' | 'low'
159	  cooldown?: number             // ms before next detection (default: 10000)
160	}
161	
162	export interface TriggerEvent {
163	  type: string
164	  source: string
165	  data: Record<string, unknown>
166	  timestamp: number
167	  priority: 'urgent' | 'normal' | 'low'
168	}
169	
170	export type TickMode = 'scheduled' | 'reactive'
171	
172	// === Cognitive Modes ===
173	
174	export type CognitiveMode = 'contemplative' | 'conversational' | 'collaborative'
175	
176	export interface CognitiveContext {
177	  mode: CognitiveMode
178	  confidence: number  // 0-1, how confident we are in mode detection
179	  signals: {
180	    urgency?: 'low' | 'medium' | 'high'
181	    interactionHistory?: 'first' | 'ongoing' | 'follow_up'
182	    timeGap?: 'short' | 'medium' | 'long'    // since last interaction
183	    contentType?: 'question' | 'task' | 'discussion' | 'analysis'
184	  }
185	}
186	
187	// === Config ===
188	
189	export interface TanrenConfig {
190	  identity: string              // path to soul.md or inline string
191	  memoryDir: string             // path to memory directory
192	  workDir?: string              // working directory (default: process.cwd())
193	  searchPaths?: string[]        // additional directories to include in search
194	
195	  llm?: LLMProvider
196	  perceptionPlugins?: PerceptionPlugin[]
197	  gates?: Gate[]
198	  gatesDir?: string
199	  actions?: ActionHandler[]
200	  eventTriggers?: EventTrigger[] // event detection plugins
201	
202	  tickInterval?: number         // ms between ticks (default: 60000)
203	  maxConcurrentDelegations?: number  // default: 4
204	  feedbackRounds?: number        // action feedback rounds per tick (default: 1, 0 = classic single-pass)
205	  
206	  eventDriven?: {
207	    enabled?: boolean           // default: false
208	    maxReactiveRate?: number    // max reactive ticks per minute (default: 10)
209	    urgentBypass?: boolean      // urgent events bypass rate limiting (default: true)
210	  }
211	
212	  cognitiveMode?: {
213	    enabled?: boolean           // default: false
214	    modes?: Partial<Record<CognitiveMode, {
215	      systemPrompt?: string     // custom system prompt for this mode
216	      memoryStrategy?: 'full' | 'recent' | 'contextual'
217	      responseStyle?: 'detailed' | 'concise' | 'interactive'
218	    }>>
219	  }
220	
221	  learning?: {
222	    enabled?: boolean           // default: true
223	    selfPerception?: boolean    // default: true
224	    crystallization?: boolean   // default: true
225	    antiGoodhart?: boolean      // default: true
226	  }
227	}
228	
