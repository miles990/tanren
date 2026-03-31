# Tick 102

**Time**: 2026-03-31 09:12:37  
**Duration**: 105.5s  
**Actions**: 6 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 3 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

這 55 秒的延遲是 **feedbackRounds=5 × 6 次 LLM call = 30 次推理循環**。問題不在 feedbackRounds 本身，而在於：**我們用「深度」這個單維指標來衡量所有情境**。

讓我直接改 code 實驗：

--- Feedback Round 1 ---



--- Feedback Round 2 ---



--- Feedback Round 3 ---



--- Feedback Round 4 ---



--- Feedback Round 5 ---



## Observation

[shell error: Command failed: bash -c cd /testbed && cat -n src/loop.ts | head -60
bash: line 0: cd: /testbed: No such file or directory
]
/Users/user/Workspace/tanren
src/loop.ts (lines 1-815 of 815)
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
153	  async function tick(mode: TickMode = 'scheduled', triggerEvent?: TriggerEvent): Promise<TickResult> {
154	    const tickStart = Date.now()
155	    tickCount++
156	    writeLiveStatus({ phase: 'perceive', tickStart, tickNumber: tickCount, running })
157	
158	    // 1. Perceive
159	    const perceptionOutput = await perception.perceive()
160	    writeCheckpoint(checkpointPath, { tickStarted: tickStart, perception: perceptionOutput })
161	
162	    // 2. Build context
163	    const identity = await loadIdentity(config.identity, memory)
164	    const gateWarnings = gateSystem.getWarnings()
165	    const learningContext = learning?.getContextSection() ?? ''
166	    const context = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext)
167	
168	    // 3. Think (LLM call) with cognitive mode detection
169	    writeLiveStatus({ phase: 'think', tickStart, tickNumber: tickCount, running, perceptionBytes: perceptionOutput.length })
170	    
171	    // Detect cognitive mode if enabled
172	    let cognitiveContext: CognitiveContext | null = null
173	    if (cognitiveModeDetector) {
174	      // Extract message content from perception for mode detection
175	      const messageContent = extractMessageContent(perceptionOutput)
176	      const lastTick = recentTicks.length > 0 ? recentTicks[recentTicks.length - 1] : null
177	      const timeGap = lastTick ? tickStart - lastTick.timestamp : 0
178	      cognitiveContext = cognitiveModeDetector.detectMode(mode, triggerEvent, timeGap, messageContent)
179	      // Set model per cognitive mode — use custom modelMap if provided (e.g. local model routing)
180	      const modelMap = config.cognitiveMode?.modelMap ?? COGNITIVE_MODE_MODELS
181	      if ('activeModel' in llm) {
182	        (llm as { activeModel?: string }).activeModel = modelMap[cognitiveContext.mode]
183	      }
184	    }
185	
186	    const baseSystemPrompt = buildSystemPrompt(identity, actionRegistry)  // always built (used in feedback loop)
187	    const systemPrompt = cognitiveContext 
188	      ? buildCognitiveModePrompt(identity, cognitiveContext, baseSystemPrompt.split('\n\n## Available Actions')[1] || '')
189	      : baseSystemPrompt
190	    
191	    let thought: string
192	    let structuredActions: Action[] | null = null
193	
194	    if (isToolUseProvider(llm)) {
195	      // Structured tool use path — LLM gets native tool definitions
196	      const toolDefs = actionRegistry.toToolDefinitions()
197	      const baseToolSystemPrompt = buildToolUseSystemPrompt(identity)
198	      const toolSystemPrompt = cognitiveContext 
199	        ? buildCognitiveModePrompt(identity, cognitiveContext, baseToolSystemPrompt.split('\n\n## Instructions')[1] || '')
200	        : baseToolSystemPrompt
201	      const messages: ConversationMessage[] = [{ role: 'user', content: context }]
202	
203	      try {
204	        const response = await llm.thinkWithTools(messages, toolSystemPrompt, toolDefs)
205	        const parsed = parseToolUseResponse(response, actionRegistry)
206	        thought = parsed.thought
207	        structuredActions = parsed.actions
208	        // Store conversation for multi-turn feedback loop
209	        messages.push({ role: 'assistant', content: response.content })
210	      } catch (err: unknown) {
211	        const msg = err instanceof Error ? err.message : String(err)
212	        thought = `[LLM error: ${msg}]`
213	      }
214	    } else {
215	      // Text-based path (CLI provider) — LLM uses <action:type> tags
216	      try {
217	        thought = await llm.think(context, systemPrompt)
218	      } catch (err: unknown) {
219	        const msg = err instanceof Error ? err.message : String(err)
220	        thought = `[LLM error: ${msg}]`
221	      }
222	    }
223	
224	    // 4. Parse actions (structured from tool use, or parsed from text)
225	    const actions = structuredActions ?? actionRegistry.parse(thought)
226	
227	    // 5. Gate check (before execution)
228	    const observation = createEmptyObservation(tickStart)
229	    const tickResult: TickResult = {
230	      perception: perceptionOutput,
231	      thought,
232	      actions,
233	      observation,
234	      timestamp: tickStart,
235	      gateResults: [],
236	    }
237	
238	    const gateContext: GateContext = {
239	      tick: tickResult,
240	      recentTicks: [...recentTicks],
241	      memory,
242	      state: gateState,
243	    }
244	
245	    const gateResults = gateSystem.runAll
src/llm/claude-cli.ts (lines 1-90 of 90)
1	/**
2	 * Tanren — Claude CLI Provider
3	 *
4	 * Uses the local `claude` CLI installation. No API key needed.
5	 * This is the default provider — proven in 195 cycles of mini-agent.
6	 */
7	
8	import { spawn } from 'node:child_process'
9	import type { LLMProvider } from '../types.js'
10	
11	export interface ClaudeCliOptions {
12	  model?: string
13	  timeoutMs?: number       // default: 1_500_000 (25 min)
14	  cwd?: string             // working directory for claude process
15	}
16	
17	export function createClaudeCliProvider(opts?: ClaudeCliOptions): LLMProvider {
18	  const timeoutMs = opts?.timeoutMs ?? 1_500_000
19	
20	  return {
21	    async think(context: string, systemPrompt: string): Promise<string> {
22	      const prompt = systemPrompt
23	        ? `${systemPrompt}\n\n---\n\n${context}`
24	        : context
25	
26	      const args = ['-p', '--output-format', 'text']
27	      if (opts?.model) {
28	        args.push('--model', opts.model)
29	      }
30	
31	      return new Promise<string>((resolve, reject) => {
32	        let stdout = ''
33	        let stderr = ''
34	        let settled = false
35	
36	        const child = spawn('claude', args, {
37	          cwd: opts?.cwd ?? process.cwd(),
38	          stdio: ['pipe', 'pipe', 'pipe'],
39	          env: {
40	            ...process.env,
41	            // Filter ANTHROPIC_API_KEY — use subscription, not API credits
42	            ANTHROPIC_API_KEY: undefined,
43	          },
44	        })
45	
46	        const timer = setTimeout(() => {
47	          if (!settled) {
48	            settled = true
49	            child.kill('SIGTERM')
50	            reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`))
51	          }
52	        }, timeoutMs)
53	
54	        child.stdout.on('data', (chunk: Buffer) => {
55	          stdout += chunk.toString()
56	        })
57	
58	        child.stderr.on('data', (chunk: Buffer) => {
59	          stderr += chunk.toString()
60	        })
61	
62	        child.on('close', (code: number | null) => {
63	          clearTimeout(timer)
64	          if (settled) return
65	          settled = true
66	
67	          if (code === 0) {
68	            resolve(stdout.trim())
69	          } else {
70	            reject(new Error(
71	              `Claude CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
72	            ))
73	          }
74	        })
75	
76	        child.on('error', (err: Error) => {
77	          clearTimeout(timer)
78	          if (settled) return
79	          settled = true
80	          reject(new Error(`Claude CLI spawn error: ${err.message}`))
81	        })
82	
83	        // Write prompt to stdin
84	        child.stdin.write(prompt)
85	        child.stdin.end()
86	      })
87	    },
88	  }
89	}
90	
./src/llm/types.ts
./src/types.ts
Edited src/llm/claude-cli.ts: replaced 2051 chars with 2588 chars
