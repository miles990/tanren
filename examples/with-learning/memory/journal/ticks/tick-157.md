# Tick 157

**Time**: 2026-04-01 05:49:52  
**Duration**: 2.2s  
**Actions**: 3 executed, 0 failed  
**Quality**: 5/5


## Thought

I need to read the Tanren source first to understand the system before designing WorkingMemory. Let me gather the code context.

## Observation

/Users/user/Workspace/tanren/src/loop.ts (lines 95-180 of 909)
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
/Users/user/Workspace/tanren/src/memory.ts (lines 1-80 of 383)
1	/**
2	 * Tanren — Memory System
3	 *
4	 * File-based memory. No database. Human-readable. Git-friendly.
5	 *
6	 * Convergence Condition: Information stored is retrievable when relevant.
7	 * Agent doesn't lose knowledge across sessions. A human can read and
8	 * audit all memory with standard tools (cat, grep, git).
9	 */
10	
11	import { readFile, writeFile, appendFile, mkdir, readdir, stat } from 'node:fs/promises'
12	import { existsSync, mkdirSync } from 'node:fs'
13	import { join, relative, dirname } from 'node:path'
14	import { execFileSync } from 'node:child_process'
15	import type { MemorySystem, SearchResult } from './types.js'
16	
17	export function createMemorySystem(memoryDir: string, searchPaths?: string[]): MemorySystem {
18	  // Ensure directory structure exists
19	  ensureDir(memoryDir)
20	  ensureDir(join(memoryDir, 'topics'))
21	  ensureDir(join(memoryDir, 'daily'))
22	  ensureDir(join(memoryDir, 'state'))
23	
24	  const self: MemorySystem = {
25	    async read(path: string): Promise<string | null> {
26	      const fullPath = resolvePath(memoryDir, path)
27	      try {
28	        return await readFile(fullPath, 'utf-8')
29	      } catch {
30	        return null
31	      }
32	    },
33	
34	    async write(path: string, content: string): Promise<void> {
35	      const fullPath = resolvePath(memoryDir, path)
36	      ensureDir(dirname(fullPath))
37	      await writeFile(fullPath, content, 'utf-8')
38	    },
39	
40	    async append(path: string, line: string): Promise<void> {
41	      const fullPath = resolvePath(memoryDir, path)
42	      ensureDir(dirname(fullPath))
43	      const suffix = line.endsWith('\n') ? '' : '\n'
44	      await appendFile(fullPath, line + suffix, 'utf-8')
45	    },
46	
47	    async search(query: string): Promise<SearchResult[]> {
48	      // Search own memory first
49	      const results = grepSearch(memoryDir, query)
50	      // Then search additional paths (read-only knowledge sources)
51	      if (searchPaths?.length) {
52	        for (const sp of searchPaths) {
53	          if (!existsSync(sp)) continue
54	          const external = grepSearch(sp, query)
55	          // Prefix external results with source label
56	          const label = sp.split('/').pop() ?? sp
57	          for (const r of external) {
58	            results.push({ ...r, file: `[${label}] ${r.file}` })
59	          }
60	          if (results.length >= 50) break
61	        }
62	      }
63	      return results.slice(0, 50)
64	    },
65	
66	    async remember(content: string, opts?: { topic?: string; tickCount?: number }): Promise<void> {
67	      const timestamp = new Date().toISOString()
68	      const tickTag = opts?.tickCount != null ? ` [tick:${opts.tickCount}]` : ''
69	      const entry = `- [${timestamp.slice(0, 10)}]${tickTag} ${content}\n`
70	
71	      if (opts?.topic) {
72	        const topicFile = `topics/${sanitizeFilename(opts.topic)}.md`
73	        const existing = await self.read(topicFile)
74	        if (!existing) {
75	          await self.write(topicFile, `# ${opts.topic}\n\n${entry}`)
76	        } else {
77	          await self.append(topicFile, entry)
78	        }
79	      } else {
80	        await self.append('memory.md', entry)
/Users/user/Workspace/tanren/src/types.ts (lines 1-60 of 242)
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
