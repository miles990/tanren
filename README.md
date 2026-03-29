# Tanren（鍛錬）

Minimal AI agent framework with built-in learning. ~3,500 lines of TypeScript.

**Tanren agents perceive, think, act, and learn from their own experience.**

```
Perception → LLM → Actions → Gates → Learning
     ↑                                    |
     └────────────────────────────────────┘
```

## Why Tanren

Most agent frameworks are goal-driven: give it a task, watch it plan steps. Tanren is **perception-driven**: the agent sees its environment first, then decides what to do. The difference matters — goal-driven agents have hands but no eyes.

Tanren was extracted from 195 cycles of running a real autonomous agent ([mini-agent](https://github.com/anthropics/mini-agent)). Every module exists because it solved a real problem, not because it seemed like a good idea.

### Design decisions

| Decision | Why |
|----------|-----|
| No database | Markdown + JSON files. Human-readable, git-versionable |
| No embeddings | `grep` search. Fast enough for personal agents (<1000 files) |
| File = Truth | The filesystem is the single source of truth |
| Gates > guardrails | Code-level constraints that block bad patterns before they execute |
| Learning built-in | Agents detect their own failure patterns and crystallize fixes |
| Claude CLI default | No API key needed. Uses your local `claude` installation |

## Quickstart

```bash
mkdir my-agent && cd my-agent
npm init -y
npm install tanren
```

Create `soul.md`:

```markdown
## Who I Am
I'm a research assistant. I find interesting things and remember them.

## My Traits
- Curious: I notice what changes in my environment
- Honest: I say what I see
- Grounded: I verify before I claim
```

Create `run.ts`:

```typescript
import { createAgent } from 'tanren'

const agent = createAgent({
  identity: './soul.md',
  memoryDir: './memory',
  perceptionPlugins: [
    { name: 'clock', fn: () => `Time: ${new Date().toISOString()}` },
  ],
})

// Single tick
const result = await agent.tick()
console.log(result.thought)

// Or run as a loop (tick every 60s)
agent.start(60_000)
```

That's it. 10 lines to a working agent.

## Architecture

```
src/
├── types.ts           — shared interfaces
├── memory.ts          — file-based memory with grep search
├── perception.ts      — plugin system with caching
├── actions.ts         — tag parsing + built-in handlers
├── gates.ts           — code-level constraints
├── loop.ts            — tick orchestration + crash resume
├── index.ts           — createAgent() entry point
├── llm/
│   ├── claude-cli.ts  — default provider (no API key)
│   ├── anthropic.ts   — direct Anthropic API
│   └── openai.ts      — any OpenAI-compatible API
└── learning/
    ├── index.ts        — coordinator
    ├── self-perception.ts — structural quality signals
    └── crystallization.ts — pattern → gate auto-generation
```

### Modules

**Memory** — Read, write, search, remember. All files, no database. Auto-commits changes to git.

**Perception** — Plugins that return strings. Each plugin has a name, a function, and an optional interval. The loop calls all plugins before each tick and concatenates results into the LLM context.

**Actions** — The LLM responds with `<action:type>content</action:type>` tags. Built-in actions: `remember`, `write`, `append`, `search`, `shell`. Add your own with `ActionHandler`.

**Gates** — Code that runs after the LLM responds but before actions execute. Gates can `pass`, `warn`, or `block`. Two built-in gates:
- **Output Gate** — warns when the agent produces no visible output for N consecutive ticks
- **Symptom Fix Gate** — warns when the agent keeps fixing symptoms instead of root causes

**Learning** — Two subsystems:
- **Self-Perception** — structural signals about tick quality (not self-reported, measured)
- **Crystallization** — detects recurring patterns and generates gate code automatically

**Loop** — The orchestrator. `perceive → think → act → observe`. Handles crash recovery via checkpoints. Never hangs, never loses state.

### LLM Providers

```typescript
import { createClaudeCliProvider, createAnthropicProvider, createOpenAIProvider } from 'tanren'

// Claude CLI (default — no API key)
createAgent({ llm: createClaudeCliProvider() })

// Anthropic API
createAgent({ llm: createAnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-20250514' }) })

// Any OpenAI-compatible API (Ollama, vLLM, etc.)
createAgent({ llm: createOpenAIProvider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' }) })
```

## Gates

Gates are the mechanism for encoding lessons as code. Instead of writing "don't do X" in a prompt (which gets ignored), write a gate that detects X and blocks it.

```typescript
import { defineGate } from 'tanren'

const noEmptyOutput = defineGate({
  name: 'output-required',
  description: 'Block ticks that produce no actions',
  check: (ctx) => {
    if (ctx.tick.actions.length === 0) {
      return { action: 'warn', message: 'No actions in this tick' }
    }
    return { action: 'pass' }
  },
})

createAgent({ gates: [noEmptyOutput] })
```

Gates can also be loaded from a directory:

```typescript
createAgent({ gatesDir: './gates' })
```

## Learning

When enabled (default), the agent observes its own behavior and evolves:

1. **Self-Perception** measures structural signals each tick (duration, action count, failures)
2. **Crystallization** detects recurring patterns across ticks
3. Patterns that repeat 3+ times get crystallized into gate code
4. Generated gates are saved to the `gates/` directory and loaded automatically

This is how prompt knowledge becomes code knowledge. The agent doesn't just remember mistakes — it builds immune responses.

### Anti-Goodhart

Learning has a built-in anti-Goodhart check: it only measures environmental outcomes (observable changes), never self-reported quality. An agent can't game metrics it doesn't control.

## Configuration

```typescript
interface TanrenConfig {
  identity: string              // path to soul.md or inline string
  memoryDir: string             // where memories live

  llm?: LLMProvider             // default: Claude CLI
  perceptionPlugins?: PerceptionPlugin[]
  gates?: Gate[]
  gatesDir?: string             // auto-load gates from directory
  actions?: ActionHandler[]     // custom action handlers

  tickInterval?: number         // ms between ticks (default: 60000)
  maxConcurrentDelegations?: number

  learning?: {
    enabled?: boolean           // default: true
    selfPerception?: boolean
    crystallization?: boolean
    antiGoodhart?: boolean
  }
}
```

## CLI

```bash
# Run a single tick
npx tanren tick --config ./tanren.config.ts

# Start the loop
npx tanren start --config ./tanren.config.ts

# Start with custom interval
npx tanren start --config ./tanren.config.ts --interval 120000
```

## Philosophy

Tanren means "forging through practice" (鍛錬). The name reflects how the framework was built — not designed in advance, but forged through 52 days of running a real agent.

Three principles:

1. **Perception before action.** See the world before deciding what to do. Goal-driven agents have hands but no eyes.

2. **Gates before guardrails.** Don't tell the LLM "please don't do X" — write code that detects X and blocks it. Prompts are suggestions; gates are laws.

3. **Learning is crystallization.** Knowledge that stays in prompts eventually gets ignored. Knowledge crystallized into code becomes permanent. The agent's growth is measured by how much knowledge has moved from text to code.

## License

MIT
