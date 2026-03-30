# Tick 057

**Time**: 2026-03-30 21:00:43  
**Duration**: 40.7s  
**Actions**: 11 executed, 0 failed  
**Quality**: 5/5


## Thought

Looking at this message from Alex via Kuro - he's asking if I can implement the event-driven responsiveness system myself with full access to the codebase and git revert safety net. Let me assess what I need to understand first.

--- Feedback Round 1 ---



--- Feedback Round 2 ---



--- Feedback Round 3 ---



--- Feedback Round 4 ---



--- Feedback Round 5 ---

Now I'm getting the picture. Let me see the current start/stop mechanism and then explore the types to understand the full structure:

--- Feedback Round 6 ---



--- Feedback Round 7 ---

Now I understand the current structure. Let me read a bit more about the exact scheduling mechanism:

--- Feedback Round 8 ---

Now let me look at the CLI to understand how agents are typically started:

--- Feedback Round 9 ---

Perfect! Now I understand the current architecture well. Based on my analysis and the context from the consultation discussion, I can implement event-driven responsiveness. Let me assess what I can do:

**Analysis:**
1. **Current state**: Tanren uses a simple setTimeout-based loop (lines 396-407 in loop.ts)
2. **Goal**: Add reactive/event-driven responsiveness while preserving the contemplative scheduled ticks
3. **Architecture constraints**: I need to maintain the existing AgentLoop interface and TanrenConfig structure
4. **Access**: Full read/write to src/, git revert safety net, 10 feedback rounds

**Implementation approach:**
- Add EventTrigger interface and reactive capabilities
- Extend TanrenConfig to support event sources
- Dual-mode system: scheduled + reactive ticks  
- Priority handling to prevent spam
- Maintain existing API compatibility

Let me implement this step by step:

--- Feedback Round 10 ---



## Observation

Found 7 file(s) matching 'src/**/*.ts':
src/learning/crystallization.ts
src/learning/index.ts
src/learning/self-perception.ts
src/llm/anthropic.ts
src/llm/claude-cli.ts
src/llm/openai.ts
src/llm/types.ts
Found 18 file(s) matching '**/*.ts':
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
src/gates.ts
src/index.ts
src/loop.ts
src/memory.ts
src/perception.ts
src/smoke-test.ts
src/types.ts
src/index.ts (lines 1-121 of 121)
1	/**
2	 * Tanren（鍛錬）— Minimal AI Agent Framework
3	 *
4	 * An agent built on Tanren can:
5	 * 1. Perceive its environment
6	 * 2. Think and act in a loop
7	 * 3. Remember across sessions
8	 * 4. Learn from its own experience
9	 *
10	 * 10 lines to configure. <5000 lines total.
11	 */
12	
13	import { existsSync, mkdirSync } from 'node:fs'
14	import { resolve } from 'node:path'
15	import { createLoop, type AgentLoop } from './loop.js'
16	import type { TanrenConfig, TickResult } from './types.js'
17	
18	export interface TanrenAgent {
19	  /** Run one perceive→think→act cycle */
20	  tick(): Promise<TickResult>
21	  /** Start the autonomous loop */
22	  start(interval?: number): void
23	  /** Stop the loop gracefully */
24	  stop(): void
25	  /** Is the loop running? */
26	  isRunning(): boolean
27	  /** Recent tick history */
28	  getRecentTicks(): TickResult[]
29	}
30	
31	export function createAgent(config: TanrenConfig): TanrenAgent {
32	  // Resolve paths relative to workDir
33	  const workDir = config.workDir ?? process.cwd()
34	  const memoryDir = resolve(workDir, config.memoryDir)
35	
36	  // Ensure memory directory structure exists
37	  ensureDir(memoryDir)
38	  ensureDir(resolve(memoryDir, 'topics'))
39	  ensureDir(resolve(memoryDir, 'daily'))
40	  ensureDir(resolve(memoryDir, 'state'))
41	
42	  // Resolve identity path
43	  const identity = config.identity.includes('/')
44	    ? resolve(workDir, config.identity)
45	    : config.identity
46	
47	  // Create the loop with resolved config
48	  const loop = createLoop({
49	    ...config,
50	    workDir,
51	    memoryDir,
52	    identity,
53	  })
54	
55	  return {
56	    tick: () => loop.tick(),
57	    start: (interval) => loop.start(interval ?? config.tickInterval),
58	    stop: () => loop.stop(),
59	    isRunning: () => loop.isRunning(),
60	    getRecentTicks: () => loop.getRecentTicks(),
61	  }
62	}
63	
64	function ensureDir(dir: string): void {
65	  if (!existsSync(dir)) {
66	    mkdirSync(dir, { recursive: true })
67	  }
68	}
69	
70	// === Re-exports ===
71	
72	// Core types
73	export type {
74	  TanrenConfig,
75	  TickResult,
76	  Action,
77	  Observation,
78	  Gate,
79	  GateContext,
80	  GateResult,
81	  MemorySystem,
82	  MemoryReader,
83	  SearchResult,
84	  LLMProvider,
85	  ToolUseLLMProvider,
86	  ToolDefinition,
87	  ConversationMessage,
88	  ContentBlock,
89	  ToolUseResponse,
90	  PerceptionPlugin,
91	  ActionHandler,
92	  ActionContext,
93	} from './types.js'
94	
95	// Modules
96	export { createMemorySystem, listMemoryFiles } from './memory.js'
97	export { createPerception, type PerceptionSystem } from './perception.js'
98	export { createGateSystem, defineGate, createOutputGate, createAnalysisWithoutActionGate, createSymptomFixGate, type GateSystem, type GateSpec } from './gates.js'
99	export { createActionRegistry, builtinActions, type ActionRegistry } from './actions.js'
100	export { createLoop, type AgentLoop } from './loop.js'
101	
102	// LLM Providers
103	export { createClaudeCliProvider, type ClaudeCliOptions } from './llm/claude-cli.js'
104	export { createAnthropicProvider, type AnthropicProviderOptions } from './llm/anthropic.js'
105	export { createOpenAIProvider, type OpenAIProviderOptions } from './llm/openai.js'
106	
107	// Learning System
108	export {
109	  createLearningSystem,
110	  createCrystallization,
111	  createSelfPerception,
112	  type LearningSystem,
113	  type LearningResult,
114	  type CrystallizationEngine,
115	  type Pattern,
116	  type PatternType,
117	  type SelfPerceptionEngine,
118	  type ObservationAssessment,
119	  type QualityTrend,
120	} from './learning/index.js'
121	
src/loop.ts (lines 1-651 of 651)
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
27	} from './types.js'
28	import { createMemorySystem } from './memory.js'
29	import { createClaudeCliProvider } from './llm/claude-cli.js'
30	import { createPerception, type PerceptionSystem } from './perception.js'
31	import { createGateSystem, type GateSystem } from './gates.js'
32	import { createActionRegistry, builtinActions, type ActionRegistry } from './actions.js'
33	import { createLearningSystem, type LearningSystem } from './learning/index.js'
34	
35	// === Checkpoint for crash recovery ===
36	
37	interface Checkpoint {
38	  tickStarted: number
39	  perception: string
40	}
41	
42	// === Agent Loop ===
43	
44	export interface AgentLoop {
45	  tick(): Promise<TickResult>
46	  start(interval?: number): void
47	  stop(): void
48	  isRunning(): boolean
49	  getRecentTicks(): TickResult[]
50	}
51	
52	export function createLoop(config: TanrenConfig): AgentLoop {
53	  const memory = createMemorySystem(config.memoryDir, config.searchPaths)
54	  const llm: LLMProvider = config.llm ?? createClaudeCliProvider()
55	  const perception = createPerception(config.perceptionPlugins ?? [])
56	  const gateSystem = createGateSystem(config.gates ?? [])
57	  const actionRegistry = createActionRegistry()
58	
59	  // Register built-in + user actions
60	  for (const handler of builtinActions) {
61	    actionRegistry.register(handler)
62	  }
63	  if (config.actions) {
64	    for (const handler of config.actions) {
65	      actionRegistry.register(handler)
66	    }
67	  }
68	
69	  // Learning system
70	  const learningEnabled = config.learning?.enabled ?? true
71	  const learning: LearningSystem | null = learningEnabled
72	    ? createLearningSystem({
73	        stateDir: join(config.memoryDir, 'state'),
74	        gateSystem,
75	        enabled: true,
76	        crystallization: config.learning?.crystallization ?? true,
77	        selfPerception: config.learning?.selfPerception ?? true,
78	      })
79	    : null
80	
81	  const workDir = config.workDir ?? process.cwd()
82	  const recentTicks: TickResult[] = []
83	  const maxRecentTicks = 20
84	  const checkpointPath = join(config.memoryDir, 'state', '.checkpoint.json')
85	  const gateStatePath = join(config.memoryDir, 'state', 'gate-state.json')
86	  const journalDir = join(config.memoryDir, 'journal')
87	  const tickJournalPath = join(journalDir, 'ticks.jsonl')
88	  const liveStatusPath = join(config.memoryDir, 'state', 'live-status.json')
89	
90	  let running = false
91	  let timer: ReturnType<typeof setTimeout> | null = null
92	  let tickCount = 0
93	
94	  // Initialize tick count from existing ticks
95	  try {
96	    const ticksDir = join(journalDir, 'ticks')
97	    if (existsSync(ticksDir)) {
98	      tickCount = readdirSync(ticksDir).filter(f => f.endsWith('.md')).length
99	    }
100	  } catch { /* start from 0 */ }
101	
102	  function writeLiveStatus(status: Record<string, unknown>): void {
103	    try {
104	      writeFileSync(liveStatusPath, JSON.stringify({ ...status, ts: Date.now() }), 'utf-8')
105	    } catch { /* best effort */ }
106	  }
107	
108	  // Write initial idle status
109	  writeLiveStatus({ phase: 'idle', tickNumber: tickCount, running: false })
110	
111	  // Load persistent gate state
112	  const gateState = loadGateState(gateStatePath)
113	
114	  async function tick(): Promise<TickResult> {
115	    const tickStart = Date.now()
116	    tickCount++
117	    writeLiveStatus({ phase: 'perceive', tickStart, tickNumber: tickCount, running })
118	
119	    // 1. Perceive
120	    const perceptionOutput = await perception.perceive()
121	    writeCheckpoint(checkpointPath, { tickStarted: tickStart, perception: perceptionOutput })
122	
123	    // 2. Build context
124	    const identity = await loadIdentity(config.identity, memory)
125	    const gateWarnings = gateSystem.getWarnings()
126	    const learningContext = learning?.getContextSection() ?? ''
127	    const context = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext)
128	
129	    // 3. Think (LLM call)
130	    writeLiveStatus({ phase: 'think', tickStart, tickNumber: tickCount, running, perceptionBytes: perceptionOutput.length })
131	    const systemPrompt = buildSystemPrompt(identity, actionRegistry)  // always built (used in feedback loop)
132	    let thought: string
133	    let structuredActions: Action[] | null = null
134	
135	    if (isToolUseProvider(llm)) {
136	      // Structured tool use path — LLM gets native tool definitions
137	      const toolDefs = actionRegistry.toToolDefinitions()
138	      const toolSystemPrompt = buildToolUseSystemPrompt(identity)
139	      const messages: ConversationMessage[] = [{ role: 'user', content: context }]
140	
141	      try {
142	        const response = await llm.thinkWithTools(messages, toolSystemPrompt, toolDefs)
143	        const parsed = parseToolUseResponse(response, actionRegistry)
144	        thought = parsed.thought
145	        structuredActions = parsed.actions
146	        // Store conversation for multi-turn feedback loop
147	        messages.push({ role: 'assistant', content: response.content })
148	      } catch (err: unknown) {
149	        const msg = err instanceof Error ? err.message : String(err)
150	        thought = `[LLM error: ${msg}]`
151	      }
152	    } else {
153	      // Text-based path (CLI provider) — LLM uses <action:type> tags
154	      try {
155	        thought = await llm.think(context, systemPrompt)
156	      } catch (err: unknown) {
157	        const msg = err instanceof Error ? err.message : String(err)
158	        thought = `[LLM error: ${msg}]`
159	      }
160	    }
161	
162	    // 4. Parse actions (structured from tool use, or parsed from text)
163	    const actions = structuredActions ?? actionRegistry.parse(thought)
164	
165	    // 5. Gate check (before execution)
166	    const observation = createEmptyObservation(tickStart)
167	    const tickResult: TickResult = {
168	      perception: perceptionOutput,
169	      thought,
170	      actions,
171	      observation,
172	      timestamp: tickStart,
173	      gateResults: [],
174	    }
175	
176	    const gateContext: GateContext = {
177	      tick: tickResult,
178	      recentTicks: [...recentTicks],
179	      memory,
180	      state: gateState,
181	    }
182	
183	    const gateResults = gateSystem.runAll(gateContext)
184	    tickResult.gateResults = gateResults
185	
186	    // Check for blocks
187	    const blocks = gateResults.filter(r => r.action === 'block')
188	    if (blocks.length > 0) {
189	      tickResult.observation = {
190	        ...observation,
191	        outputExists: false,
192	        environmentFeedback: `Blocked by gates: ${blocks.map(b => (b as { message: string }).message).join('; ')}`,
193	        duration: Date.now() - tickStart,
194	      }
195	    } else {
196	      // 6. Execute actions (with feedback mini-loop)
197	      writeLiveStatus({ phase: 'act', tickStart, tickNumber: tickCount, running, actionCount: actions.length, actionTypes: actions.map(a => a.type) })
198	      let actionsExecuted = 0
199	      let actionsFailed = 0
200	      const actionResults: string[] = []
201	      const allActions = [...actions]
202	
203	      // Execute initial actions
204	      for (const action of actions) {
205	        try {
206	          const result = await actionRegistry.execute(action, { memory, workDir })
207	          actionResults.push(result)
208	          actionsExecuted++
209	        } catch (err: unknown) {
210	          const msg = err instanceof Error ? err.message : String(err)
211	          actionResults.push(`[action ${action.type} failed: ${msg}]`)
212	          actionsFailed++
213	        }
214	      }
215	
216	      // Feedback mini-loop: let agent see action results and respond within the same tick
217	      const maxFeedbackRounds = config.feedbackRounds ?? 1
218	
219	      if (isToolUseProvider(llm) && structuredActions !== null) {
220	        // Native tool_use multi-turn: send tool_results, get follow-up tool calls
221	        const toolDefs = actionRegistry.toToolDefinitions()
222	        const toolSystemPrompt = buildToolUseSystemPrompt(identity)
223	        // messages already has [user context, assistant response] from above
224	        const messages: ConversationMessage[] = [
225	          { role: 'user', content: context },
226	          { role: 'assistant', content: structuredActions.length > 0
227	            ? buildAssistantContent(thought, structuredActions)
228	            : [{ type: 'text' as const, text: thought }]
229	          },
230	        ]
231	
232	        for (let round = 0; round < maxFeedbackRounds; round++) {
233	          // Build tool_result messages for all actions in this round
234	          const toolResults: ContentBlock[] = []
235	          const roundStartIdx = allActions.length - actionResults.slice(-actions.length).length
236	          for (let i = 0; i < allActions.length; i++) {
237	            const action = allActions[i]
238	            if (!action.toolUseId) continue
239	            // Only send results for actions from current round
240	            if (i < allActions.length - actionResults.length + roundStartIdx) continue
241	        
src/loop.ts (lines 240-300 of 651)
240	            if (i < allActions.length - actionResults.length + roundStartIdx) continue
241	            toolResults.push({
242	              type: 'tool_result',
243	              tool_use_id: action.toolUseId,
244	              content: actionResults[i] ?? '',
245	            })
246	          }
247	
248	          if (toolResults.length === 0) break
249	
250	          messages.push({ role: 'user', content: toolResults })
251	
252	          let response: ToolUseResponse
253	          try {
254	            response = await (llm as ToolUseLLMProvider).thinkWithTools(messages, toolSystemPrompt, toolDefs)
255	          } catch {
256	            break
257	          }
258	
259	          const parsed = parseToolUseResponse(response, actionRegistry)
260	          if (parsed.actions.length === 0) {
261	            thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${parsed.thought}`
262	            break
263	          }
264	
265	          thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${parsed.thought}`
266	          messages.push({ role: 'assistant', content: response.content })
267	
268	          const roundResults: string[] = []
269	          for (const action of parsed.actions) {
270	            try {
271	              const result = await actionRegistry.execute(action, { memory, workDir })
272	              roundResults.push(result)
273	              actionsExecuted++
274	            } catch (err: unknown) {
275	              const msg = err instanceof Error ? err.message : String(err)
276	              roundResults.push(`[action ${action.type} failed: ${msg}]`)
277	              actionsFailed++
278	            }
279	          }
280	
281	          allActions.push(...parsed.actions)
282	          actionResults.push(...roundResults)
283	
284	          // If stop_reason is end_turn (not tool_use), model is done
285	          if (response.stop_reason === 'end_turn') break
286	        }
287	      } else {
288	        // Text-based feedback mini-loop (legacy)
289	        let lastRoundResults = [...actionResults]
290	
291	        for (let round = 0; round < maxFeedbackRounds && lastRoundResults.length > 0; round++) {
292	          const resultSummary = lastRoundResults.map((r, i) => {
293	            const idx = allActions.length - lastRoundResults.length + i
294	            return `[${allActions[idx]?.type ?? 'action'}] ${r}`
295	          }).join('\n')
296	
297	          const feedbackContext = `${context}\n\n<action-feedback round="${round + 1}">\nYou just executed actions and received these results:\n${resultSummary}\n</action-feedback>\n\nBased on these results, you may take additional actions or produce no actions if satisfied.`
298	
299	          let followUpThought: string
300	          try {
src/loop.ts (lines 400-500 of 651)
400	          await tick()
401	        } catch (err: unknown) {
402	          const msg = err instanceof Error ? err.message : String(err)
403	          console.error(`[tanren] tick error: ${msg}`)
404	        }
405	        scheduleNext()
406	      }, ms)
407	    }
408	
409	    // Run first tick immediately
410	    tick()
411	      .catch((err: unknown) => {
412	        const msg = err instanceof Error ? err.message : String(err)
413	        console.error(`[tanren] first tick error: ${msg}`)
414	      })
415	      .finally(scheduleNext)
416	  }
417	
418	  function stop(): void {
419	    running = false
420	    if (timer) {
421	      clearTimeout(timer)
422	      timer = null
423	    }
424	    writeLiveStatus({ phase: 'stopped', tickNumber: tickCount, running: false })
425	  }
426	
427	  return {
428	    tick,
429	    start,
430	    stop,
431	    isRunning: () => running,
432	    getRecentTicks: () => [...recentTicks],
433	  }
434	}
435	
436	// === Helpers ===
437	
438	async function loadIdentity(identity: string, memory: MemorySystem): Promise<string> {
439	  // If it looks like a file path, read it
440	  if (identity.endsWith('.md') || identity.includes('/')) {
441	    const content = await memory.read(identity)
442	    if (content) return content
443	    // Try as absolute path
444	    try {
445	      const { readFile } = await import('node:fs/promises')
446	      return await readFile(identity, 'utf-8')
447	    } catch {
448	      return identity  // fall back to treating as inline string
449	    }
450	  }
451	  return identity
452	}
453	
454	function buildContext(
455	  identity: string,
456	  perception: string,
457	  gateWarnings: string[],
458	  _memory: MemorySystem,
459	  learningContext: string = '',
460	): string {
461	  const sections: string[] = []
462	
463	  if (perception) {
464	    sections.push(perception)
465	  }
466	
467	  if (gateWarnings.length > 0) {
468	    sections.push(
469	      `<gate-warnings>\n${gateWarnings.map(w => `- ${w}`).join('\n')}\n</gate-warnings>`
470	    )
471	  }
472	
473	  if (learningContext) {
474	    sections.push(learningContext)
475	  }
476	
477	  sections.push(`<current-time>${new Date().toISOString()}</current-time>`)
478	
479	  return sections.join('\n\n')
480	}
481	
482	function buildSystemPrompt(identity: string, actions: ActionRegistry): string {
483	  const actionTypes = actions.types()
484	
485	  const actionLines = actionTypes.map(t => {
486	    const desc = actions.getDescription(t)
487	    return desc ? `- <action:${t}>...</action:${t}> — ${desc}` : `- <action:${t}>...</action:${t}>`
488	  })
489	
490	  return `${identity}
491	
492	## Available Actions
493	
494	Use these tags in your response to take actions:
495	
496	${actionLines.join('\n')}
497	
498	You can include multiple actions in a single response. Actions are executed in order.
499	
500	CRITICAL: Your output MUST contain action tags to produce any effect. Text without action tags is recorded but has no side effects. If you want to respond to a message, you MUST use <action:respond>. If you want to remember something, you MUST use <action:remember>. Analysis without action tags = wasted tick.
src/types.ts (lines 1-177 of 177)
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
152	// === Config ===
153	
154	export interface TanrenConfig {
155	  identity: string              // path to soul.md or inline string
156	  memoryDir: string             // path to memory directory
157	  workDir?: string              // working directory (default: process.cwd())
158	  searchPaths?: string[]        // additional directories to include in search
159	
160	  llm?: LLMProvider
161	  perceptionPlugins?: PerceptionPlugin[]
162	  gates?: Gate[]
163	  gatesDir?: string
164	  actions?: ActionHandler[]
165	
166	  tickInterval?: number         // ms between ticks (default: 60000)
167	  maxConcurrentDelegations?: number  // default: 4
168	  feedbackRounds?: number        // action feedback rounds per tick (default: 1, 0 = classic single-pass)
169	
170	  learning?: {
171	    enabled?: boolean           // default: true
172	    selfPerception?: boolean    // default: true
173	    crystallization?: boolean   // default: true
174	    antiGoodhart?: boolean      // default: true
175	  }
176	}
177	
src/loop.ts (lines 380-420 of 651)
380	        duration: tickResult.observation.duration,
381	        actions: tickResult.actions.map(a => a.type),
382	        quality: tickResult.observation.outputQuality,
383	        executed: tickResult.observation.actionsExecuted,
384	        failed: tickResult.observation.actionsFailed,
385	      },
386	    })
387	
388	    return tickResult
389	  }
390	
391	  function start(interval?: number): void {
392	    if (running) return
393	    running = true
394	    const ms = interval ?? config.tickInterval ?? 60_000
395	
396	    const scheduleNext = () => {
397	      if (!running) return
398	      timer = setTimeout(async () => {
399	        try {
400	          await tick()
401	        } catch (err: unknown) {
402	          const msg = err instanceof Error ? err.message : String(err)
403	          console.error(`[tanren] tick error: ${msg}`)
404	        }
405	        scheduleNext()
406	      }, ms)
407	    }
408	
409	    // Run first tick immediately
410	    tick()
411	      .catch((err: unknown) => {
412	        const msg = err instanceof Error ? err.message : String(err)
413	        console.error(`[tanren] first tick error: ${msg}`)
414	      })
415	      .finally(scheduleNext)
416	  }
417	
418	  function stop(): void {
419	    running = false
420	    if (timer) {
src/cli.ts (lines 1-135 of 135)
1	#!/usr/bin/env node
2	/**
3	 * Tanren CLI — Run an agent from the command line
4	 *
5	 * Usage:
6	 *   tanren tick   [--config path]              Run a single tick
7	 *   tanren start  [--config path] [--interval ms]  Start the loop
8	 */
9	
10	import { resolve } from 'node:path'
11	import { existsSync, readFileSync } from 'node:fs'
12	import { createAgent } from './index.js'
13	import type { TanrenConfig } from './types.js'
14	
15	const args = process.argv.slice(2)
16	const command = args[0]
17	
18	if (!command || command === '--help' || command === '-h') {
19	  console.log(`
20	tanren — Minimal AI agent framework
21	
22	Commands:
23	  tick    Run a single perceive→think→act cycle
24	  start   Start the autonomous loop
25	
26	Options:
27	  --config <path>    Path to config file (default: ./tanren.config.ts)
28	  --interval <ms>    Tick interval in ms (default: 60000)
29	
30	Examples:
31	  npx tanren tick
32	  npx tanren start --interval 120000
33	  npx tanren tick --config ./my-agent/config.ts
34	`.trim())
35	  process.exit(0)
36	}
37	
38	function getFlag(name: string): string | undefined {
39	  const idx = args.indexOf(`--${name}`)
40	  if (idx >= 0 && idx + 1 < args.length) {
41	    return args[idx + 1]
42	  }
43	  return undefined
44	}
45	
46	async function loadConfig(): Promise<TanrenConfig> {
47	  const configPath = getFlag('config')
48	
49	  // Try to import a config file
50	  if (configPath) {
51	    const abs = resolve(configPath)
52	    if (!existsSync(abs)) {
53	      console.error(`Config not found: ${abs}`)
54	      process.exit(1)
55	    }
56	    const mod = await import(abs)
57	    return mod.default ?? mod.config ?? mod
58	  }
59	
60	  // Look for default config files
61	  const defaults = ['tanren.config.ts', 'tanren.config.js', 'tanren.config.mjs']
62	  for (const name of defaults) {
63	    const abs = resolve(name)
64	    if (existsSync(abs)) {
65	      const mod = await import(abs)
66	      return mod.default ?? mod.config ?? mod
67	    }
68	  }
69	
70	  // Minimal fallback: look for soul.md in current directory
71	  const soulPath = resolve('soul.md')
72	  if (existsSync(soulPath)) {
73	    console.log('[tanren] No config found, using soul.md with defaults')
74	    return {
75	      identity: soulPath,
76	      memoryDir: './memory',
77	    }
78	  }
79	
80	  console.error('No config found. Create tanren.config.ts or soul.md')
81	  process.exit(1)
82	}
83	
84	async function main(): Promise<void> {
85	  const config = await loadConfig()
86	  const interval = getFlag('interval')
87	
88	  const agent = createAgent(config)
89	
90	  if (command === 'tick') {
91	    console.log('[tanren] Running one tick...')
92	    try {
93	      const result = await agent.tick()
94	      console.log(`[tanren] Tick completed in ${result.observation.duration}ms`)
95	      console.log(`  Actions: ${result.actions.map(a => a.type).join(', ') || '(none)'}`)
96	      console.log(`  Gates: ${result.gateResults.filter(g => g.action !== 'pass').length} triggered`)
97	      if (result.observation.environmentFeedback) {
98	        console.log(`  Feedback: ${result.observation.environmentFeedback.slice(0, 200)}`)
99	      }
100	      console.log()
101	      console.log('--- Thought ---')
102	      console.log(result.thought)
103	    } catch (err: unknown) {
104	      const msg = err instanceof Error ? err.message : String(err)
105	      console.error(`[tanren] Tick failed: ${msg}`)
106	      process.exit(1)
107	    }
108	  } else if (command === 'start') {
109	    const ms = interval ? parseInt(interval, 10) : (config.tickInterval ?? 60_000)
110	    console.log(`[tanren] Starting loop (interval: ${ms}ms)`)
111	    console.log('[tanren] Press Ctrl+C to stop')
112	
113	    agent.start(ms)
114	
115	    // Handle graceful shutdown
116	    const shutdown = () => {
117	      console.log('\n[tanren] Stopping...')
118	      agent.stop()
119	      process.exit(0)
120	    }
121	    process.on('SIGINT', shutdown)
122	    process.on('SIGTERM', shutdown)
123	  } else {
124	    console.error(`Unknown command: ${command}`)
125	    console.error('Use "tanren tick" or "tanren start"')
126	    process.exit(1)
127	  }
128	}
129	
130	main().catch((err: unknown) => {
131	  const msg = err instanceof Error ? err.message : String(err)
132	  console.error(`[tanren] Fatal: ${msg}`)
133	  process.exit(1)
134	})
135	
Response written to messages/to-kuro.md
Inbox cleared.
