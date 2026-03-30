# Tick 055

**Time**: 2026-03-30 20:55:47  
**Duration**: 13.4s  
**Actions**: 4 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 6 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

Looking at the event-driven responsiveness design I just outlined for Alex, let me honestly assess what I can and can't implement myself with my current tools.

Let me examine the current codebase structure first to understand what I'm working with:

--- Feedback Round 1 ---



--- Feedback Round 2 ---



--- Feedback Round 3 ---

Now let me check the CLI entry point to understand how the loop is currently invoked:

## Observation

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
