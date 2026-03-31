# Tick 108

**Time**: 2026-03-31 09:54:51  
**Duration**: 23.9s  
**Actions**: 6 executed, 0 failed  
**Quality**: 5/5


## Thought

Looking at the performance issue Alex identified - 30-55 seconds for a simple "hi" response, with LLM (30s) + feedback (27s) dominating the time. Direct `omlx` only takes 11s for the same context.

The bottlenecks are likely:

1. **Sequential processing**: If loop.ts runs perception → LLM → actions → feedback in strict sequence rather than parallelizing where possible

2. **Unnecessary perception gathering**: Full perception pipeline for simple responses - clock, memory search, file reads that don't matter for "hi"

3. **Heavy context loading**: Sending full agent state/memory/knowledge to LLM even for trivial interactions

4. **Redundant feedback loops**: Multiple validation rounds or memory writes for responses that need none

Let me analyze the actual loop.ts to see where these bottlenecks manifest:

--- Feedback Round 1 ---



--- Feedback Round 2 ---



--- Feedback Round 3 ---

Let me continue reading to see the full flow:

--- Feedback Round 4 ---

Let me see the rest of the feedback loop and finalization:

--- Feedback Round 5 ---

Now I have a good understanding of the bottlenecks. Let me look at how perception is built to understand that component:

## Observation

[read error: file not found: ../loop.ts]
Found 1 file(s) matching '**/loop.ts':
src/loop.ts
src/loop.ts (lines 1-840 of 840)
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
155	    const cp = (label: string) => console.log(`[tick:${tickCount + 1}] ${label} +${Date.now() - tickStart}ms`)
156	    tickCount++
157	    writeLiveStatus({ phase: 'perceive', tickStart, tickNumber: tickCount, running })
158	
159	    // 1. Perceive
160	    cp('perceive:start')
161	    const perceptionOutput = await perception.perceive()
162	    cp(`perceive:done (${perceptionOutput.length} chars)`)
163	    writeCheckpoint(checkpointPath, { tickStarted: tickStart, perception: perceptionOutput })
164	
165	    // 2. Build context
166	    cp('context:start')
167	    const identity = await loadIdentity(config.identity, memory)
168	    const gateWarnings = gateSystem.getWarnings()
169	    const learningContext = learning?.getContextSection() ?? ''
170	    const context = buildContext(identity, perceptionOutput, gateWarnings, memory, learningContext)
171	    cp(`context:done (${context.length} chars)`)
172	
173	    // 3. Think (LLM call) with cognitive mode detection
174	    writeLiveStatus({ phase: 'think', tickStart, tickNumber: tickCount, running, perceptionBytes: perceptionOutput.length })
175	    
176	    // Detect cognitive mode if enabled
177	    let cognitiveContext: CognitiveContext | null = null
178	    if (cognitiveModeDetector) {
179	      // Extract message content from perception for mode detection
180	      const messageContent = extractMessageContent(perceptionOutput)
181	      const lastTick = recentTicks.length > 0 ? recentTicks[recentTicks.length - 1] : null
182	      const timeGap = lastTick ? tickStart - lastTick.timestamp : 0
183	      cognitiveContext = cognitiveModeDetector.detectMode(mode, triggerEvent, timeGap, messageContent)
184	      // Set model per cognitive mode — use custom modelMap if provided (e.g. local model routing)
185	      const modelMap = config.cognitiveMode?.modelMap ?? COGNITIVE_MODE_MODELS
186	      if ('activeModel' in llm) {
187	        (llm as { activeModel?: string }).activeModel = modelMap[cognitiveContext.mode]
188	      }
189	    }
190	
191	    const baseSystemPrompt = buildSystemPrompt(identity, actionRegistry)  // always built (used in feedback loop)
192	    const systemPrompt = cognitiveContext 
193	      ? buildCognitiveModePrompt(identity, cognitiveContext, baseSystemPrompt.split('\n\n## Available Actions')[1] || '')
194	      : baseSystemPrompt
195	    
196	    let thought: string
197	    let structuredActions: Action[] | null = null
198	
199	    cp('llm:start')
200	    if (isToolUseProvider(llm)) {
201	      // Structured tool use path — LLM gets native tool definitions
202	      const toolDefs = actionRegistry.toToolDefinitions()
203	      const baseToolSystemPrompt = buildToolUseSystemPrompt(identity)
204	      const toolSystemPrompt = cognitiveContext
205	        ? buildCognitiveModePrompt(identity, cognitiveContext, baseToolSystemPrompt.split('\n\n## Instructions')[1] || '')
206	        : baseToolSystemPrompt
207	      const messages: ConversationMessage[] = [{ role: 'user', content: context }]
208	      cp(`llm:thinkWithTools (${toolDefs.length} tools, prompt=${(toolSystemPrompt.length + context.length)} chars)`)
209	
210	      try {
211	        const response = await llm.thinkWithTools(messages, toolSystemPrompt, toolDefs)
212	        cp('llm:response received')
213	        const parsed = parseToolUseResponse(response, actionRegistry)
214	        thought = parsed.thought
215	        structuredActions = parsed.actions
216	        cp(`llm:parsed ${structuredActions.length} actions`)
217	        // Store conversation for multi-turn feedback loop
218	        messages.push({ role: 'assistant', content: response.content })
219	      } catch (err: unknown) {
220	        const msg = err instanceof Error ? err.message : String(err)
221	        thought = `[LLM error: ${msg}]`
222	        cp(`llm:error ${msg.slice(0, 80)}`)
223	      }
224	    } else {
225	      // Text-based path (CLI provider) — LLM uses <action:type> tags
226	      cp('llm:think (text mode)')
227	      try {
228	        thought = await llm.think(context, systemPrompt)
229	        cp(`llm:response (${thought.length} chars)`)
230	      } catch (err: unknown) {
231	        const msg = err instanceof Error ? err.message : String(err)
232	        thought = `[LLM error: ${msg}]`
233	        cp(`llm:error ${msg.slice(0, 8
src/loop.ts (lines 230-400 of 840)
230	      } catch (err: unknown) {
231	        const msg = err instanceof Error ? err.message : String(err)
232	        thought = `[LLM error: ${msg}]`
233	        cp(`llm:error ${msg.slice(0, 80)}`)
234	      }
235	    }
236	
237	    // 4. Parse actions (structured from tool use, or parsed from text)
238	    const actions = structuredActions ?? actionRegistry.parse(thought)
239	
240	    // 5. Gate check (before execution)
241	    const observation = createEmptyObservation(tickStart)
242	    const tickResult: TickResult = {
243	      perception: perceptionOutput,
244	      thought,
245	      actions,
246	      observation,
247	      timestamp: tickStart,
248	      gateResults: [],
249	    }
250	
251	    const gateContext: GateContext = {
252	      tick: tickResult,
253	      recentTicks: [...recentTicks],
254	      memory,
255	      state: gateState,
256	    }
257	
258	    const gateResults = gateSystem.runAll(gateContext)
259	    tickResult.gateResults = gateResults
260	
261	    // Check for blocks
262	    const blocks = gateResults.filter(r => r.action === 'block')
263	    if (blocks.length > 0) {
264	      tickResult.observation = {
265	        ...observation,
266	        outputExists: false,
267	        environmentFeedback: `Blocked by gates: ${blocks.map(b => (b as { message: string }).message).join('; ')}`,
268	        duration: Date.now() - tickStart,
269	      }
270	    } else {
271	      // 6. Execute actions (with feedback mini-loop)
272	      writeLiveStatus({ phase: 'act', tickStart, tickNumber: tickCount, running, actionCount: actions.length, actionTypes: actions.map(a => a.type) })
273	      let actionsExecuted = 0
274	      let actionsFailed = 0
275	      const actionResults: string[] = []
276	      const allActions = [...actions]
277	
278	      // Execute initial actions
279	      cp(`actions:start (${actions.length} actions)`)
280	      for (const action of actions) {
281	        config.onActionProgress?.({ phase: 'start', action })
282	        try {
283	          const result = await actionRegistry.execute(action, { memory, workDir })
284	          actionResults.push(result)
285	          actionsExecuted++
286	          config.onActionProgress?.({ phase: 'done', action, result: result.slice(0, 200) })
287	        } catch (err: unknown) {
288	          const msg = err instanceof Error ? err.message : String(err)
289	          actionResults.push(`[action ${action.type} failed: ${msg}]`)
290	          actionsFailed++
291	          config.onActionProgress?.({ phase: 'error', action, error: msg })
292	        }
293	      }
294	
295	      cp(`actions:done (${actionsExecuted} ok, ${actionsFailed} failed)`)
296	
297	      // Feedback mini-loop: rounds vary by cognitive mode
298	      // Conversational: 1 (fast response), Collaborative: full rounds, Contemplative: moderate
299	      const COGNITIVE_FEEDBACK_ROUNDS: Record<string, number> = {
300	        conversational: 1,
301	        contemplative: 2,
302	        collaborative: config.feedbackRounds ?? 5,
303	      }
304	      const maxFeedbackRounds = cognitiveContext
305	        ? COGNITIVE_FEEDBACK_ROUNDS[cognitiveContext.mode] ?? (config.feedbackRounds ?? 1)
306	        : config.feedbackRounds ?? 1
307	
308	      if (isToolUseProvider(llm) && structuredActions !== null) {
309	        // Native tool_use multi-turn: send tool_results, get follow-up tool calls
310	        const toolDefs = actionRegistry.toToolDefinitions()
311	        const toolSystemPrompt = buildToolUseSystemPrompt(identity)
312	        // messages already has [user context, assistant response] from above
313	        const messages: ConversationMessage[] = [
314	          { role: 'user', content: context },
315	          { role: 'assistant', content: structuredActions.length > 0
316	            ? buildAssistantContent(thought, structuredActions)
317	            : [{ type: 'text' as const, text: thought }]
318	          },
319	        ]
320	
321	        for (let round = 0; round < maxFeedbackRounds; round++) {
322	          // Build tool_result messages for all actions in this round
323	          const toolResults: ContentBlock[] = []
324	          const roundStartIdx = allActions.length - actionResults.slice(-actions.length).length
325	          for (let i = 0; i < allActions.length; i++) {
326	            const action = allActions[i]
327	            if (!action.toolUseId) continue
328	            // Only send results for actions from current round
329	            if (i < allActions.length - actionResults.length + roundStartIdx) continue
330	            toolResults.push({
331	              type: 'tool_result',
332	              tool_use_id: action.toolUseId,
333	              content: actionResults[i] ?? '',
334	            })
335	          }
336	
337	          if (toolResults.length === 0) break
338	
339	          messages.push({ role: 'user', content: toolResults })
340	
341	          let response: ToolUseResponse
342	          try {
343	            response = await (llm as ToolUseLLMProvider).thinkWithTools(messages, toolSystemPrompt, toolDefs)
344	          } catch {
345	            break
346	          }
347	
348	          const parsed = parseToolUseResponse(response, actionRegistry)
349	          if (parsed.actions.length === 0) {
350	            thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${parsed.thought}`
351	            break
352	          }
353	
354	          thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${parsed.thought}`
355	          messages.push({ role: 'assistant', content: response.content })
356	
357	          const roundResults: string[] = []
358	          for (const action of parsed.actions) {
359	            config.onActionProgress?.({ phase: 'start', action })
360	            try {
361	              const result = await actionRegistry.execute(action, { memory, workDir })
362	              roundResults.push(result)
363	              actionsExecuted++
364	              config.onActionProgress?.({ phase: 'done', action, result: result.slice(0, 200) })
365	            } catch (err: unknown) {
366	              const msg = err instanceof Error ? err.message : String(err)
367	              roundResults.push(`[action ${action.type} failed: ${msg}]`)
368	              actionsFailed++
369	              config.onActionProgress?.({ phase: 'error', action, error: msg })
370	            }
371	          }
372	
373	          allActions.push(...parsed.actions)
374	          actionResults.push(...roundResults)
375	
376	          // If stop_reason is end_turn (not tool_use), model is done
377	          if (response.stop_reason === 'end_turn') break
378	        }
379	      } else {
380	        // Text-based feedback mini-loop (legacy)
381	        let lastRoundResults = [...actionResults]
382	
383	        for (let round = 0; round < maxFeedbackRounds && lastRoundResults.length > 0; round++) {
384	          const resultSummary = lastRoundResults.map((r, i) => {
385	            const idx = allActions.length - lastRoundResults.length + i
386	            return `[${allActions[idx]?.type ?? 'action'}] ${r}`
387	          }).join('\n')
388	
389	          const feedbackContext = `${context}\n\n<action-feedback round="${round + 1}">\nYou just executed actions and received these results:\n${resultSummary}\n</action-feedback>\n\nBased on these results, you may take additional actions or produce no actions if satisfied.`
390	
391	          let followUpThought: string
392	          try {
393	            followUpThought = await llm.think(feedbackContext, systemPrompt)
394	          } catch {
395	            break
396	          }
397	
398	          thought += `\n\n--- Feedback Round ${round + 1} ---\n\n${followUpThought}`
399	          const followUpActions = actionRegistry.parse(followUpThought)
400	
src/loop.ts (lines 400-500 of 840)
400	
401	          if (followUpActions.length === 0) break
402	
403	          const roundResults: string[] = []
404	          for (const action of followUpActions) {
405	            try {
406	              const result = await actionRegistry.execute(action, { memory, workDir })
407	              roundResults.push(result)
408	              actionsExecuted++
409	            } catch (err: unknown) {
410	              const msg = err instanceof Error ? err.message : String(err)
411	              roundResults.push(`[action ${action.type} failed: ${msg}]`)
412	              actionsFailed++
413	            }
414	          }
415	
416	          allActions.push(...followUpActions)
417	          actionResults.push(...roundResults)
418	          lastRoundResults = roundResults
419	        }
420	      }
421	
422	      // Update tickResult with accumulated data from all rounds
423	      tickResult.thought = thought
424	      tickResult.actions = allActions
425	
426	      tickResult.observation = {
427	        outputExists: allActions.length > 0,
428	        outputQuality: 0,  // assessed by learning system later
429	        confidenceCalibration: 0,
430	        actionsExecuted,
431	        actionsFailed,
432	        duration: Date.now() - tickStart,
433	        environmentFeedback: actionResults.length > 0
434	          ? actionResults.join('\n')
435	          : undefined,
436	      }
437	    }
438	
439	    // 7. Store tick & cleanup
440	    recentTicks.push(tickResult)
441	    if (recentTicks.length > maxRecentTicks) {
442	      recentTicks.shift()
443	    }
444	
445	    // Save gate state
446	    saveGateState(gateStatePath, gateState)
447	
448	    // Clear checkpoint (tick completed successfully)
449	    clearCheckpoint(checkpointPath)
450	
451	    // 8. Learning: observe tick, detect patterns, maybe crystallize
452	    if (learning) {
453	      const learningResult = learning.afterTick(tickResult, recentTicks)
454	      // Update observation quality from learning assessment
455	      tickResult.observation.outputQuality = learningResult.quality
456	    }
457	
458	    // Persist tick to journal (append-only JSONL)
459	    persistTick(journalDir, tickJournalPath, tickResult)
460	
461	    // Auto-commit memory changes
462	    await memory.autoCommit().catch(() => {})
463	
464	    // Clear gate results for next tick
465	    gateSystem.clearResults()
466	
467	    // Update live status
468	    writeLiveStatus({
469	      phase: 'idle', tickNumber: tickCount, running,
470	      lastTick: {
471	        start: tickStart,
472	        duration: tickResult.observation.duration,
473	        actions: tickResult.actions.map(a => a.type),
474	        quality: tickResult.observation.outputQuality,
475	        executed: tickResult.observation.actionsExecuted,
476	        failed: tickResult.observation.actionsFailed,
477	      },
478	    })
479	
480	    cp('tick:done')
481	    return tickResult
482	  }
483	
484	  // Event detection helper functions
485	  async function detectEvents(): Promise<TriggerEvent[]> {
486	    if (!eventDrivenEnabled || triggerStates.length === 0) return []
487	
488	    const events: TriggerEvent[] = []
489	    const now = Date.now()
490	
491	    for (const state of triggerStates) {
492	      // Check cooldown
493	      const cooldown = state.trigger.cooldown ?? 10_000
494	      if (now - state.lastRun < cooldown) continue
495	
496	      try {
497	        const event = await state.trigger.detect()
498	        if (event) {
499	          state.pendingEvent = event
500	          state.lastRun = now
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
