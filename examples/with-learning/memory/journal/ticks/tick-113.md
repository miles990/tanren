# Tick 113

**Time**: 2026-03-31 10:06:24  
**Duration**: 17.9s  
**Actions**: 6 executed, 0 failed  
**Quality**: 5/5


## Thought

This is a straightforward request from Alex via Kuro - add a single line to my soul.md file and respond when complete. Let me check the current state of soul.md first.

--- Feedback Round 1 ---

Let me explore to find where my soul.md file is located:

--- Feedback Round 2 ---

That's odd - let me check the current working directory structure:

--- Feedback Round 3 ---

I'm not in my agent directory - I need to find it or check if this is expected. Let me explore deeper:

--- Feedback Round 4 ---

Let me try another approach - check if there's a README.md I can read to understand where I am:

--- Feedback Round 5 ---

I see - I'm in the Tanren framework directory, not in my specific agent instance directory. The soul.md file should be in the agent instance directory, not here. Let me check if there are examples or if I need to look elsewhere:

## Observation

[read error: file not found: soul.md]
Found 1 file(s) matching '**/soul.md':
.
Found 10 file(s) matching '*':
dist
examples
gates
node_modules
package-lock.json
package.json
README.md
scripts
src
tsconfig.json
Found 1 file(s) matching '**/*.md':
.
README.md (lines 1-222 of 222)
1	# Tanren（鍛錬）
2	
3	Minimal AI agent framework with built-in learning. ~3,500 lines of TypeScript.
4	
5	**Tanren agents perceive, think, act, and learn from their own experience.**
6	
7	```
8	Perception → LLM → Actions → Gates → Learning
9	     ↑                                    |
10	     └────────────────────────────────────┘
11	```
12	
13	## Why Tanren
14	
15	Most agent frameworks are goal-driven: give it a task, watch it plan steps. Tanren is **perception-driven**: the agent sees its environment first, then decides what to do. The difference matters — goal-driven agents have hands but no eyes.
16	
17	Tanren was extracted from 195 cycles of running a real autonomous agent ([mini-agent](https://github.com/anthropics/mini-agent)). Every module exists because it solved a real problem, not because it seemed like a good idea.
18	
19	### Design decisions
20	
21	| Decision | Why |
22	|----------|-----|
23	| No database | Markdown + JSON files. Human-readable, git-versionable |
24	| No embeddings | `grep` search. Fast enough for personal agents (<1000 files) |
25	| File = Truth | The filesystem is the single source of truth |
26	| Gates > guardrails | Code-level constraints that block bad patterns before they execute |
27	| Learning built-in | Agents detect their own failure patterns and crystallize fixes |
28	| Claude CLI default | No API key needed. Uses your local `claude` installation |
29	
30	## Quickstart
31	
32	```bash
33	mkdir my-agent && cd my-agent
34	npm init -y
35	npm install tanren
36	```
37	
38	Create `soul.md`:
39	
40	```markdown
41	## Who I Am
42	I'm a research assistant. I find interesting things and remember them.
43	
44	## My Traits
45	- Curious: I notice what changes in my environment
46	- Honest: I say what I see
47	- Grounded: I verify before I claim
48	```
49	
50	Create `run.ts`:
51	
52	```typescript
53	import { createAgent } from 'tanren'
54	
55	const agent = createAgent({
56	  identity: './soul.md',
57	  memoryDir: './memory',
58	  perceptionPlugins: [
59	    { name: 'clock', fn: () => `Time: ${new Date().toISOString()}` },
60	  ],
61	})
62	
63	// Single tick
64	const result = await agent.tick()
65	console.log(result.thought)
66	
67	// Or run as a loop (tick every 60s)
68	agent.start(60_000)
69	```
70	
71	That's it. 10 lines to a working agent.
72	
73	## Architecture
74	
75	```
76	src/
77	├── types.ts           — shared interfaces
78	├── memory.ts          — file-based memory with grep search
79	├── perception.ts      — plugin system with caching
80	├── actions.ts         — tag parsing + built-in handlers
81	├── gates.ts           — code-level constraints
82	├── loop.ts            — tick orchestration + crash resume
83	├── index.ts           — createAgent() entry point
84	├── llm/
85	│   ├── claude-cli.ts  — default provider (no API key)
86	│   ├── anthropic.ts   — direct Anthropic API
87	│   └── openai.ts      — any OpenAI-compatible API
88	└── learning/
89	    ├── index.ts        — coordinator
90	    ├── self-perception.ts — structural quality signals
91	    └── crystallization.ts — pattern → gate auto-generation
92	```
93	
94	### Modules
95	
96	**Memory** — Read, write, search, remember. All files, no database. Auto-commits changes to git.
97	
98	**Perception** — Plugins that return strings. Each plugin has a name, a function, and an optional interval. The loop calls all plugins before each tick and concatenates results into the LLM context.
99	
100	**Actions** — The LLM responds with `<action:type>content</action:type>` tags. Built-in actions: `remember`, `write`, `append`, `search`, `shell`. Add your own with `ActionHandler`.
101	
102	**Gates** — Code that runs after the LLM responds but before actions execute. Gates can `pass`, `warn`, or `block`. Two built-in gates:
103	- **Output Gate** — warns when the agent produces no visible output for N consecutive ticks
104	- **Symptom Fix Gate** — warns when the agent keeps fixing symptoms instead of root causes
105	
106	**Learning** — Two subsystems:
107	- **Self-Perception** — structural signals about tick quality (not self-reported, measured)
108	- **Crystallization** — detects recurring patterns and generates gate code automatically
109	
110	**Loop** — The orchestrator. `perceive → think → act → observe`. Handles crash recovery via checkpoints. Never hangs, never loses state.
111	
112	### LLM Providers
113	
114	```typescript
115	import { createClaudeCliProvider, createAnthropicProvider, createOpenAIProvider } from 'tanren'
116	
117	// Claude CLI (default — no API key)
118	createAgent({ llm: createClaudeCliProvider() })
119	
120	// Anthropic API
121	createAgent({ llm: createAnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-20250514' }) })
122	
123	// Any OpenAI-compatible API (Ollama, vLLM, etc.)
124	createAgent({ llm: createOpenAIProvider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' }) })
125	```
126	
127	## Gates
128	
129	Gates are the mechanism for encoding lessons as code. Instead of writing "don't do X" in a prompt (which gets ignored), write a gate that detects X and blocks it.
130	
131	```typescript
132	import { defineGate } from 'tanren'
133	
134	const noEmptyOutput = defineGate({
135	  name: 'output-required',
136	  description: 'Block ticks that produce no actions',
137	  check: (ctx) => {
138	    if (ctx.tick.actions.length === 0) {
139	      return { action: 'warn', message: 'No actions in this tick' }
140	    }
141	    return { action: 'pass' }
142	  },
143	})
144	
145	createAgent({ gates: [noEmptyOutput] })
146	```
147	
148	Gates can also be loaded from a directory:
149	
150	```typescript
151	createAgent({ gatesDir: './gates' })
152	```
153	
154	## Learning
155	
156	When enabled (default), the agent observes its own behavior and evolves:
157	
158	1. **Self-Perception** measures structural signals each tick (duration, action count, failures)
159	2. **Crystallization** detects recurring patterns across ticks
160	3. Patterns that repeat 3+ times get crystallized into gate code
161	4. Generated gates are saved to the `gates/` directory and loaded automatically
162	
163	This is how prompt knowledge becomes code knowledge. The agent doesn't just remember mistakes — it builds immune responses.
164	
165	### Anti-Goodhart
166	
167	Learning has a built-in anti-Goodhart check: it only measures environmental outcomes (observable changes), never self-reported quality. An agent can't game metrics it doesn't control.
168	
169	## Configuration
170	
171	```typescript
172	interface TanrenConfig {
173	  identity: string              // path to soul.md or inline string
174	  memoryDir: string             // where memories live
175	
176	  llm?: LLMProvider             // default: Claude CLI
177	  perceptionPlugins?: PerceptionPlugin[]
178	  gates?: Gate[]
179	  gatesDir?: string             // auto-load gates from directory
180	  actions?: ActionHandler[]     // custom action handlers
181	
182	  tickInterval?: number         // ms between ticks (default: 60000)
183	  maxConcurrentDelegations?: number
184	
185	  learning?: {
186	    enabled?: boolean           // default: true
187	    selfPerception?: boolean
188	    crystallization?: boolean
189	    antiGoodhart?: boolean
190	  }
191	}
192	```
193	
194	## CLI
195	
196	```bash
197	# Run a single tick
198	npx tanren tick --config ./tanren.config.ts
199	
200	# Start the loop
201	npx tanren start --config ./tanren.config.ts
202	
203	# Start with custom interval
204	npx tanren start --config ./tanren.config.ts --interval 120000
205	```
206	
207	## Philosophy
208	
209	Tanren means "forging through practice" (鍛錬). The name reflects how the framework was built — not designed in advance, but forged through 52 days of running a real agent.
210	
211	Three principles:
212	
213	1. **Perception before action.** See the world before deciding what to do. Goal-driven agents have hands but no eyes.
214	
215	2. **Gates before guardrails.** Don't tell the LLM "please don't do X" — write code that detects X and blocks it. Prompts are suggestions; gates are laws.
216	
217	3. **Learning is crystallization.** Knowledge that stays in prompts eventually gets ignored. Knowledge crystallized into code becomes permanent. The agent's growth is measured by how much knowledge has moved from text to code.
218	
219	## License
220	
221	MIT
222	
./examples/minimal/soul.md
./examples/with-learning/soul.md
