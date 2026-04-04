# Tanren（鍛錬）

Minimal AI agent framework with built-in learning and self-perception. TypeScript.

**Tanren agents perceive, think, act, learn — and observe their own cognitive patterns.**

```
Perception → LLM → Actions → Gates → Learning
     ↑          ↑                        |
     |    Cognitive State                |
     └───────────────────────────────────┘
```

## Why Tanren

Most agent frameworks are goal-driven: give it a task, watch it plan steps. Tanren is **perception-driven**: the agent sees its environment first, then decides what to do. The difference matters — goal-driven agents have hands but no eyes.

Tanren was forged from running a real autonomous agent. Every module exists because it solved a real problem, not because it seemed like a good idea.

### Design decisions

| Decision | Why |
|----------|-----|
| No database | Markdown + JSON files. Human-readable, git-versionable |
| No embeddings | `grep` search. Fast enough for personal agents (<1000 files) |
| File = Truth | The filesystem is the single source of truth |
| Gates > guardrails | Code-level constraints that block bad patterns before they execute |
| Learning built-in | Agents detect their own failure patterns and crystallize fixes |
| Framework ≠ Agent | Framework provides tools. Agents own their workspace, identity, and memory |

### LLM Providers

| Provider | Config | API key needed |
|----------|--------|---------------|
| Claude CLI | default | No (uses local `claude` installation) |
| Anthropic API | `createAnthropicProvider()` | Yes |
| OpenAI-compatible | `createOpenAIProvider()` | Depends (Ollama, vLLM, omlx, etc.) |
| Fallback chain | `createFallbackProvider(primary, fallback)` | Depends |

## Quickstart

```bash
# Scaffold a new agent
bash scripts/create-agent.sh my-agent ~/Workspace/my-agent

cd ~/Workspace/my-agent
cp .env.example .env     # configure LLM provider
edit soul.md             # define identity

./manage.sh up           # start (HTTP server on port 3002)
./manage.sh status       # check health
./live.sh                # watch live tick status
```

The scaffold creates:

```
my-agent/
  run.ts              — entry point (imports from tanren)
  soul.md             — agent identity
  manage.sh           — up/down/restart/status/logs
  live.sh             — live tick TUI monitor
  package.json        — ESM config
  .env.example        — LLM provider template
  memory/             — all agent memory (File = Truth)
  messages/           — communication inbox/outbox
```

Or create manually:

```typescript
import { createAgent } from 'tanren'

const agent = createAgent({
  identity: './soul.md',
  memoryDir: './memory',
  perceptionPlugins: [
    { name: 'clock', fn: () => `Time: ${new Date().toISOString()}` },
  ],
})

const result = await agent.tick()
agent.start(60_000) // or run as a loop
```

## Architecture

```
src/
├── types.ts              — shared interfaces
├── memory.ts             — file-based memory with grep search
├── perception.ts         — plugin system with caching
├── actions.ts            — tag parsing + built-in handlers (risk tiers)
├── gates.ts              — code-level constraints (4 built-in gates)
├── loop.ts               — tick orchestration + crash resume + feedback rounds
├── index.ts              — createAgent() entry point
├── metacognitive.ts      — MPL: cognitive state, anomaly detection, state diff
├── working-memory.ts     — cross-tick persistence (focus, insights, threads)
├── plans.ts              — multi-step plan tracking with verification
├── continuation.ts       — multi-tick chain orchestration
├── llm/
│   ├── claude-cli.ts     — default provider (no API key)
│   ├── anthropic.ts      — Anthropic API (native tool use)
│   └── openai.ts         — OpenAI-compatible (Ollama, vLLM, omlx)
└── learning/
    ├── index.ts           — coordinator (quality trend + duration stats)
    ├── self-perception.ts — structural quality signals (6 dimensions)
    └── crystallization.ts — pattern → gate auto-generation
```

### Core Loop

Each tick: `perceive → think → act → observe → learn`

- **Perception** — plugins gather environment data + metacognitive state
- **Think** — LLM receives perception context, produces thought + action tags
- **Act** — actions parsed, risk-tiered, executed with feedback rounds
- **Observe** — structural signals measured (visible output, duration, action diversity)
- **Learn** — crystallization detects patterns, self-perception scores quality

### Metacognitive Perception Layer (MPL)

The agent can observe its own cognitive patterns — zero LLM calls, pure structural signals:

```xml
<cognitive-state>
  Mode: research (5 ticks without visible output)
  Focus: "constraint texture" (unchanged 12 ticks)
  Actions (last 10 ticks): remember×8, read×6, respond×2
  Balance: research=6 production=2 internal=8
  Avg tick: 94s
  Last visible output: 3 ticks ago
</cognitive-state>
```

Also includes: `<last-tick>` action results, `<state-diff>` file changes, `<anomalies>` early warnings, `<last-reflection>` cognitive residue.

## Gates

Code-level behavioral constraints. Prompts are suggestions; gates are laws.

4 built-in gates:

| Gate | Detects |
|------|---------|
| `createOutputGate(N)` | N consecutive ticks with no visible output |
| `createAnalysisWithoutActionGate(N)` | N ticks with substantial thought but zero actions |
| `createProductivityGate(N)` | N ticks with only internal actions (remember/read/search) |
| `createSymptomFixGate(N)` | N consecutive fix-like actions (treating symptoms) |

Custom gates:

```typescript
import { defineGate } from 'tanren'

const myGate = defineGate({
  name: 'my-constraint',
  description: 'What this catches',
  check: (ctx) => {
    if (/* bad pattern */) return { action: 'warn', message: '...' }
    return { action: 'pass' }
  },
})

createAgent({ gates: [myGate] })
```

## Learning

Self-perception measures 6 structural signals per tick:

1. **Action existence** — did the agent act at all?
2. **Action success rate** — did actions execute without errors?
3. **Gate results** — was the agent warned or blocked?
4. **Visible output** — did actions produce externally visible results? (respond/write/edit/shell — not remember/read/search)
5. **Duration** — was the tick abnormally slow (>3min)?
6. **Action diversity** — was it all internal actions with no visible output?

Quality trend and duration stats are injected into the agent's perception, so it can see its own performance patterns.

**Crystallization** detects recurring patterns (repeated failures, action streaks, empty streaks, ignored gate warnings) and auto-generates gates. Prompt knowledge becomes code knowledge.

**Anti-Goodhart**: only measures environmental outcomes, never self-reported quality. An agent can't game metrics it doesn't control.

## Configuration

```typescript
interface TanrenConfig {
  identity: string              // path to soul.md
  memoryDir: string             // where memories live

  llm?: LLMProvider             // default: Claude CLI
  perceptionPlugins?: PerceptionPlugin[]
  gates?: Gate[]
  gatesDir?: string             // auto-load gates from directory
  actions?: ActionHandler[]     // custom action handlers

  tickInterval?: number         // ms between ticks (default: 60000)
  feedbackRounds?: number       // action feedback rounds per tick (default: 1)
  toolDegradation?: boolean     // degrade read tools after round 0 (default: true)

  learning?: {
    enabled?: boolean           // default: true
    selfPerception?: boolean
    crystallization?: boolean
    antiGoodhart?: boolean
  }

  cognitiveMode?: {
    enabled?: boolean           // auto-detect contemplative/conversational/collaborative
  }

  eventDriven?: {
    enabled?: boolean           // reactive ticks on external events
  }
}
```

## Philosophy

Tanren means "forging through practice" (鍛錬).

An LLM is like a high-intelligence child — it has capability but not yet direction. The framework's job isn't to control every step, but to create an environment where the agent naturally grows in the right direction. Not an instruction manual. A teaching environment.

### Four pillars

**1. Guardrails** — Code-enforced behavioral floor.

The agent can't fall off a cliff. If there's a message, the framework guarantees a response — even if the LLM forgets. If tools are available, the framework surfaces the right ones for the situation. These are non-negotiable minimums, enforced by code, not prompts.

*Gates before guardrails: don't tell the LLM "please don't do X" — write code that detects X and blocks it.*

**2. Guidance** — Environment structure as direction.

Make correct behavior the path of least resistance. When there's a message to answer, only response tools are available — the agent naturally responds instead of wandering. Perception is ordered so the most actionable information comes first. The framework shapes the landscape; the agent chooses the path.

*Context-sensitive tool exposure: the environment's shape determines the behavior's shape.*

**3. Mirror** — Let the agent see itself.

The framework collects tick history, action patterns, quality trends, duration stats — and surfaces them as perception. The agent sees its own cognitive patterns: "you've been in research mode for 5 ticks", "your average tick takes 94s", "this action sequence worked 3 times before." Self-correction requires self-observation.

*Cognitive self-perception: the agent can perceive everything except itself — until you wire the data to perception.*

**4. Forging** — Learn from experience, not instruction.

Negative learning: crystallization detects failure patterns and generates gates automatically. Positive learning: effective sequences are tracked and surfaced, not as rewards, but as transparency — "here's what you did when things went well." Anti-Goodhart: only environmental signals, never self-reported quality.

*Learning is crystallization: knowledge in prompts gets ignored. Knowledge crystallized into code becomes permanent.*

### Constraint Texture

The framework uses two kinds of constraints:

| Layer | Type | Controls | Example |
|-------|------|----------|---------|
| **Prescription** | Code-enforced | Behavioral floor (what must happen) | Message → must respond; tool filtering |
| **Convergence condition** | Environment-shaped | Quality ceiling (what good looks like) | Cognitive state mirror; effective patterns |

Prescription controls the minimum. Convergence conditions open the maximum. The agent gets autonomy above the floor, not below it.

### Perception before action

See the world before deciding what to do. Goal-driven agents have hands but no eyes. Tanren agents perceive their environment, their own cognitive state, and their behavioral history — then decide.

## License

MIT
