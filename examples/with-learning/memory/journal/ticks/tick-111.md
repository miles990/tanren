# Tick 111

**Time**: 2026-03-31 09:58:37  
**Duration**: 17.1s  
**Actions**: 6 executed, 0 failed  
**Quality**: 4/5

## Gate Results
- [warn] 4 consecutive ticks without visible output. Are you producing value, or just thinking?

## Thought

Looking at Alex's message forwarded by Kuro - this is the performance optimization implementation we discussed. Time to get hands-on with the loop.ts modifications.

Let me first understand the current structure and then implement the conditional feedback and conversational mode optimizations.

--- Feedback Round 1 ---

Let me continue reading the loop.ts file to understand the structure:

--- Feedback Round 2 ---

Let me continue reading to see the complete feedback loop and where to implement the optimizations:

--- Feedback Round 3 ---

Let me see the helper functions at the end:

--- Feedback Round 4 ---

Now let me look at the action registry to understand which actions are simple vs complex:

--- Feedback Round 5 ---

Let me get the builtin actions to identify the simple ones:

## Observation

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
src/loop.ts (lines 400-600 of 840)
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
501	          events.push(event)
502	        }
503	      } catch (err) {
504	        console.warn(`[tanren] trigger ${state.trigger.name} error:`, err)
505	      }
506	    }
507	
508	    return events
509	  }
510	
511	  function shouldRunReactiveTick(event: TriggerEvent): boolean {
512	    if (!eventDrivenEnabled) return false
513	    
514	    // Check rate limiting
515	    const now = Date.now()
516	    if (now - reactiveTickWindowStart >= reactiveWindowMs) {
517	      reactiveTickCount = 0
518	      reactiveTickWindowStart = now
519	    }
520	
521	    // Urgent events bypass rate limiting if enabled
522	    if (event.priority === 'urgent' && urgentBypass) return true
523	    
524	    // Check rate limit
525	    if (reactiveTickCount >= maxReactiveRate) return false
526	    
527	    return true
528	  }
529	
530	  function start(interval?: number): void {
531	    if (running) return
532	    running = true
533	    const ms = interval ?? config.tickInterval ?? 60_000
534	
535	    const scheduleNext = () => {
536	      if (!running) return
537	      timer = setTimeout(async () => {
538	        try {
539	          await tick()
540	        } catch (err: unknown) {
541	          const msg = err instanceof Error ? err.message : String(err)
542	          console.error(`[tanren] tick error: ${msg}`)
543	        }
544	        scheduleNext()
545	      }, ms)
546	    }
547	
548	    // Event detection loop (if enabled)
549	    if (eventDrivenEnabled && triggerStates.length > 0) {
550	      const runEventLoop = async () => {
551	        if (!running) return
552	        
553	        try {
554	          const events = await detectEvents()
555	          for (const event of events) {
556	            if (shouldRunReactiveTick(event)) {
557	              reactiveTickCount++
558	              console.log(`[tanren] reactive tick triggered by ${event.source}`)
559	              await tick('reactive', event)
560	            }
561	          }
562	        } catch (err: unknown) {
563	          const msg = err instanceof Error ? err.message : String(err)
564	          console.error(`[tanren] event detection error: ${msg}`)
565	        }
566	
567	        // Schedule next event detection
568	        if (running) {
569	          eventTimer = setTimeout(runEventLoop, 1000) // Check events every second
570	        }
571	      }
572	
573	      // Start event loop
574	      runEventLoop()
575	    }
576	
577	    // Run first tick immediately
578	    tick()
579	      .catch((err: unknown) => {
580	        const msg = err instanceof Error ? err.message : String(err)
581	        console.error(`[tanren] first tick error: ${msg}`)
582	      })
583	      .finally(scheduleNext)
584	  }
585	
586	  function stop(): void {
587	    running = false
588	    if (timer) {
589	      clearTimeout(timer)
590	      timer = null
591	    }
592	    if (eventTimer) {
593	      clearTimeout(eventTimer)
594	      eventTimer = null
595	    }
596	    writeLiveStatus({ phase: 'stopped', tickNumber: tickCount, running: false })
597	  }
598	
599	  return {
600	    tick,
src/loop.ts (lines 600-840 of 840)
600	    tick,
601	    start,
602	    stop,
603	    isRunning: () => running,
604	    getRecentTicks: () => [...recentTicks],
605	  }
606	}
607	
608	// === Helpers ===
609	
610	async function loadIdentity(identity: string, memory: MemorySystem): Promise<string> {
611	  // If it looks like a file path, read it
612	  if (identity.endsWith('.md') || identity.includes('/')) {
613	    const content = await memory.read(identity)
614	    if (content) return content
615	    // Try as absolute path
616	    try {
617	      const { readFile } = await import('node:fs/promises')
618	      return await readFile(identity, 'utf-8')
619	    } catch {
620	      return identity  // fall back to treating as inline string
621	    }
622	  }
623	  return identity
624	}
625	
626	function buildContext(
627	  identity: string,
628	  perception: string,
629	  gateWarnings: string[],
630	  _memory: MemorySystem,
631	  learningContext: string = '',
632	): string {
633	  const sections: string[] = []
634	
635	  if (perception) {
636	    sections.push(perception)
637	  }
638	
639	  if (gateWarnings.length > 0) {
640	    sections.push(
641	      `<gate-warnings>\n${gateWarnings.map(w => `- ${w}`).join('\n')}\n</gate-warnings>`
642	    )
643	  }
644	
645	  if (learningContext) {
646	    sections.push(learningContext)
647	  }
648	
649	  sections.push(`<current-time>${new Date().toISOString()}</current-time>`)
650	
651	  return sections.join('\n\n')
652	}
653	
654	function buildSystemPrompt(identity: string, actions: ActionRegistry): string {
655	  const actionTypes = actions.types()
656	
657	  const actionLines = actionTypes.map(t => {
658	    const desc = actions.getDescription(t)
659	    return desc ? `- <action:${t}>...</action:${t}> — ${desc}` : `- <action:${t}>...</action:${t}>`
660	  })
661	
662	  return `${identity}
663	
664	## Available Actions
665	
666	Use these tags in your response to take actions:
667	
668	${actionLines.join('\n')}
669	
670	You can include multiple actions in a single response. Actions are executed in order.
671	
672	CRITICAL: Your output MUST contain action tags to produce any effect. Text without action tags is recorded but has no side effects. If you want to respond to a message, you MUST use <action:respond>. If you want to remember something, you MUST use <action:remember>. Analysis without action tags = wasted tick.
673	
674	IMPORTANT: Action tags are executed by the Tanren framework on your behalf. You do NOT need file access, write permissions, or any external tools. Simply include the action tag in your response and the framework handles all I/O. For example, <action:respond>your message</action:respond> will be delivered to Kuro automatically — you don't write to any file yourself.`
675	}
676	
677	function createEmptyObservation(tickStart: number): Observation {
678	  return {
679	    outputExists: false,
680	    outputQuality: 0,
681	    confidenceCalibration: 0,
682	    actionsExecuted: 0,
683	    actionsFailed: 0,
684	    duration: Date.now() - tickStart,
685	  }
686	}
687	
688	function writeCheckpoint(path: string, data: Checkpoint): void {
689	  try {
690	    writeFileSync(path, JSON.stringify(data), 'utf-8')
691	  } catch { /* best effort */ }
692	}
693	
694	function clearCheckpoint(path: string): void {
695	  try {
696	    if (existsSync(path)) unlinkSync(path)
697	  } catch { /* best effort */ }
698	}
699	
700	function loadGateState(path: string): Record<string, unknown> {
701	  try {
702	    if (existsSync(path)) {
703	      return JSON.parse(readFileSync(path, 'utf-8'))
704	    }
705	  } catch { /* start fresh */ }
706	  return {}
707	}
708	
709	function saveGateState(path: string, state: Record<string, unknown>): void {
710	  try {
711	    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
712	  } catch { /* best effort */ }
713	}
714	
715	function persistTick(journalDir: string, journalPath: string, tick: TickResult): void {
716	  try {
717	    if (!existsSync(journalDir)) {
718	      mkdirSync(journalDir, { recursive: true })
719	    }
720	    const entry = JSON.stringify({
721	      t: tick.timestamp,
722	      thought: tick.thought,
723	      actions: tick.actions.map(a => ({ type: a.type, content: a.content })),
724	      observation: {
725	        outputExists: tick.observation.outputExists,
726	        quality: tick.observation.outputQuality,
727	        actionsExecuted: tick.observation.actionsExecuted,
728	        actionsFailed: tick.observation.actionsFailed,
729	        duration: tick.observation.duration,
730	        feedback: tick.observation.environmentFeedback,
731	      },
732	      gates: tick.gateResults.filter(g => g.action !== 'pass'),
733	      perception: tick.perception.slice(0, 500),  // truncate for space
734	    })
735	    appendFileSync(journalPath, entry + '\n', 'utf-8')
736	
737	    // Human-readable tick log (one file per tick)
738	    const ticksDir = join(journalDir, 'ticks')
739	    if (!existsSync(ticksDir)) {
740	      mkdirSync(ticksDir, { recursive: true })
741	    }
742	    const existing = readdirSync(ticksDir).filter(f => f.endsWith('.md')).length
743	    const tickNum = String(existing + 1).padStart(3, '0')
744	    const date = new Date(tick.timestamp).toISOString().replace('T', ' ').slice(0, 19)
745	    const duration = (tick.observation.duration / 1000).toFixed(1)
746	    const gateNotes = tick.gateResults
747	      .filter(g => g.action !== 'pass')
748	      .map(g => `- [${g.action}] ${(g as { message: string }).message}`)
749	      .join('\n')
750	
751	    const md = [
752	      `# Tick ${tickNum}`,
753	      ``,
754	      `**Time**: ${date}  `,
755	      `**Duration**: ${duration}s  `,
756	      `**Actions**: ${tick.observation.actionsExecuted} executed, ${tick.observation.actionsFailed} failed  `,
757	      `**Quality**: ${tick.observation.outputQuality}/5`,
758	      gateNotes ? `\n## Gate Results\n${gateNotes}` : '',
759	      ``,
760	      `## Thought`,
761	      ``,
762	      tick.thought,
763	      ``,
764	      `## Observation`,
765	      ``,
766	      tick.observation.environmentFeedback ?? '_No feedback_',
767	      ``,
768	    ].join('\n')
769	
770	    writeFileSync(join(ticksDir, `tick-${tickNum}.md`), md, 'utf-8')
771	  } catch { /* best effort — don't break the loop */ }
772	}
773	
774	// === Tool Use Integration ===
775	
776	function isToolUseProvider(provider: LLMProvider): provider is ToolUseLLMProvider {
777	  return 'thinkWithTools' in provider && typeof (provider as ToolUseLLMProvider).thinkWithTools === 'function'
778	}
779	
780	function parseToolUseResponse(response: ToolUseResponse, registry: ActionRegistry): { thought: string; actions: Action[] } {
781	  const textParts: string[] = []
782	  const actions: Action[] = []
783	
784	  for (const block of response.content) {
785	    if (block.type === 'text') {
786	      textParts.push(block.text)
787	    } else if (block.type === 'tool_use') {
788	      actions.push(registry.fromToolUse(block.name, block.id, block.input as Record<string, unknown>))
789	    }
790	  }
791	
792	  return { thought: textParts.join('\n'), actions }
793	}
794	
795	/** Build assistant content blocks for multi-turn conversation */
796	function buildAssistantContent(thought: string, actions: Action[]): ContentBlock[] {
797	  const blocks: ContentBlock[] = []
798	  if (thought) {
799	    blocks.push({ type: 'text', text: thought })
800	  }
801	  for (const action of actions) {
802	    if (action.toolUseId) {
803	      blocks.push({
804	        type: 'tool_use',
805	        id: action.toolUseId,
806	        name: action.type,
807	        input: action.input ?? { content: action.content },
808	      })
809	    }
810	  }
811	  return blocks
812	}
813	
814	function buildToolUseSystemPrompt(identity: string): string {
815	  return `${identity}
816	
817	## Instructions
818	
819	You have tools available. Use them to take actions. Your text response is your thinking/reflection — it will be recorded but has no side effects. Only tool calls produce effects.
820	
821	CRITICAL: You MUST call at least one tool per tick to produce any effect. If you want to respond to a message, call the 'respond' tool. If you want to remember something, call the 'remember' tool. Thinking without tool calls = wasted tick.`
822	}
823	
824	function extractMessageContent(perception: string): string {
825	  // Extract content from kuro-message or other structured message formats
826	  const kuronMessageMatch = perception.match(/<kuro-message>([\s\S]*?)<\/kuro-message>/i)
827	  if (kuronMessageMatch) {
828	    return kuronMessageMatch[1].trim()
829	  }
830	  
831	  // Extract from inbox patterns
832	  const inboxMatch = perception.match(/<inbox>([\s\S]*?)<\/inbox>/i)
833	  if (inboxMatch) {
834	    return inboxMatch[1].trim()
835	  }
836	  
837	  // Fallback: return first 500 chars of perception for basic pattern detection
838	  return perception.slice(0, 500)
839	}
840	
src/actions.ts (lines 1-100 of 467)
1	/**
2	 * Tanren — Action System
3	 *
4	 * Parses actions from LLM output and routes them to handlers.
5	 * Actions are tags in the LLM response: <action:type>content</action:type>
6	 */
7	
8	import type { Action, ActionHandler, ActionContext, ToolDefinition } from './types.js'
9	
10	export interface ActionRegistry {
11	  register(handler: ActionHandler): void
12	  parse(response: string): Action[]
13	  execute(action: Action, context: ActionContext): Promise<string>
14	  has(type: string): boolean
15	  types(): string[]
16	  getDescription(type: string): string | undefined
17	  /** Convert registered actions to Anthropic tool definitions */
18	  toToolDefinitions(): ToolDefinition[]
19	  /** Convert a tool_use block back to an Action */
20	  fromToolUse(name: string, id: string, input: Record<string, unknown>): Action
21	}
22	
23	export function createActionRegistry(): ActionRegistry {
24	  const handlers = new Map<string, ActionHandler>()
25	
26	  return {
27	    register(handler: ActionHandler): void {
28	      handlers.set(handler.type, handler)
29	    },
30	
31	    parse(response: string): Action[] {
32	      return parseActions(response)
33	    },
34	
35	    execute(action: Action, context: ActionContext): Promise<string> {
36	      const handler = handlers.get(action.type)
37	      if (!handler) {
38	        return Promise.resolve(`[unknown action type: ${action.type}]`)
39	      }
40	      return handler.execute(action, context)
41	    },
42	
43	    has(type: string): boolean {
44	      return handlers.has(type)
45	    },
46	
47	    types(): string[] {
48	      return [...handlers.keys()]
49	    },
50	
51	    getDescription(type: string): string | undefined {
52	      return handlers.get(type)?.description
53	    },
54	
55	    toToolDefinitions(): ToolDefinition[] {
56	      const defs: ToolDefinition[] = []
57	      for (const [name, handler] of handlers) {
58	        const schema = handler.toolSchema ?? {
59	          properties: { content: { type: 'string', description: 'Action content' } },
60	          required: ['content'],
61	        }
62	        defs.push({
63	          name,
64	          description: handler.description ?? `Execute ${name} action`,
65	          input_schema: { type: 'object', ...schema },
66	        })
67	      }
68	      return defs
69	    },
70	
71	    fromToolUse(name: string, id: string, input: Record<string, unknown>): Action {
72	      // Build content string from structured input for backward compatibility
73	      const content = typeof input.content === 'string'
74	        ? input.content
75	        : Object.entries(input).map(([k, v]) => `${k}: ${String(v)}`).join('\n')
76	
77	      return {
78	        type: name,
79	        content,
80	        raw: JSON.stringify({ tool_use: name, id, input }),
81	        input,
82	        toolUseId: id,
83	      }
84	    },
85	  }
86	}
87	
88	/**
89	 * Parse <action:type>content</action:type> tags from LLM response.
90	 * Supports nested content (but not nested action tags).
91	 */
92	function parseActions(response: string): Action[] {
93	  const actions: Action[] = []
94	  const regex = /<action:(\w[\w-]*)((?:\s+\w+="[^"]*")*)>([\s\S]*?)<\/action:\1>/g
95	  let match: RegExpExecArray | null
96	
97	  while ((match = regex.exec(response)) !== null) {
98	    const attrs: Record<string, string> = {}
99	    if (match[2]) {
100	      const attrRegex = /(\w+)="([^"]*)"/g
Found 2 file(s) matching '**/*action*.ts':
dist/actions.d.ts
src/actions.ts
