# Tick 122

**Time**: 2026-03-31 10:40:26  
**Duration**: 52.3s  
**Actions**: 6 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 6 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

Let me analyze the constraints and provide a concrete solution:

**Key insight**: The 10x overhead comes from processing tool calls in the perception phase. With constraint texture, we should minimize friction while maintaining cognitive depth.

**Solution**: Conditional tool gating based on action complexity, not action presence.

Let me check the current architecture first:

--- Feedback Round 1 ---



--- Feedback Round 2 ---



--- Feedback Round 3 ---



--- Feedback Round 4 ---



--- Feedback Round 5 ---



## Observation

[read error: file not found: kuro/tanren/perception.ts]
Found 1 file(s) matching '**/tanren/*.ts':
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
Found 19 file(s) matching '**/*.ts':
dist/actions.d.ts
dist/cli.d.ts
dist/gates.d.ts
dist/index.d.ts
dist/loop.d.ts
dist/memory.d.ts
dist/perception.d.ts
dist/smoke-test.d.ts
dist/types.d.ts
src/actions.ts
src/cli.ts
src/cognitive-modes.ts
src/gates.ts
src/index.ts
src/loop.ts
src/memory.ts
src/perception.ts
src/smoke-test.ts
src/types.ts
src/perception.ts (lines 1-76 of 76)
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
src/loop.ts (lines 1-877 of 877)
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
37	import { createActionRegistry, builtinActions, type ActionRegistry } from './actions.js'
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
220	    if (isToolUseProvider(llm)) {
221	      // Filter tools by complexity — minimal tick only gets respond+remember
222	      const allToolDefs = actionRegistry.toToolDefinitions()
223	      const toolFilter = complexity === 'minimal' ? MINIMAL_TOOLS
224	        : complexity === 'standard' ? STANDARD_TOOLS
225	        : null // full = all tools
226	      const toolDefs = toolFilter ? allToolDefs.filter(t => toolFilter.has(t.name)) : allToolDefs
227	
228	      const baseToolSystemPrompt = buildToolUseSystemPrompt(identity)
229	      const toolSystemPrompt = cognitiveContext
230	        ? buildCognitiveModePrompt(identity, cognitiveContext, baseToolSystemPrompt.split('\n\n## Instructions')[1] || '')
231	        : baseToolSystemPrompt
232	      const messages: ConversationMessage[] = [{ role: 'user', content: context }]

