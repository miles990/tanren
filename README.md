# Tanren（鍛錬）

Perception-driven AI agent framework with built-in learning, cognitive modes, and multi-agent collaboration. TypeScript.

**Tanren agents perceive, think, act, learn — and observe their own cognitive patterns.**

```
Perception → Context Mode → LLM → Actions → Gates → Learning
     ↑         (filter)      ↑      (verify)          |
     |       Cognitive State + Skills                  |
     └─────────────────────────────────────────────────┘
```

## Why Tanren

Most agent frameworks are goal-driven: give a task, watch it plan steps. Tanren is **perception-driven**: the agent sees its environment first, then decides what to do.

Tanren was forged from running real autonomous agents (5000+ cycles). Every module solves a real problem. The name means "forging through practice" (鍛錬) — constraints shape behavior through structure, not instruction.

## Quickstart

```bash
# Minimal: just soul.md + memory/
echo "I am a research assistant." > soul.md
mkdir memory
npx tanren tick                    # single tick
npx tanren chat                    # interactive REPL
npx tanren serve --port 3002       # HTTP server
```

Or with a config file:

```typescript
// tanren.config.mjs
import { createAnthropicProvider } from 'tanren'

export default {
  identity: './soul.md',
  memoryDir: './memory',
  skillsDir: './skills',
  llm: createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  feedbackRounds: 25,
  toolDegradation: false,
}
```

```bash
npx tanren serve --config ./tanren.config.mjs --port 3002
```

## CLI

```bash
tanren tick    [--config path]         # single perceive→think→act cycle
tanren chat    [--config path]         # interactive conversation
tanren run     [--config path]         # self-paced chain (agent decides when to stop)
tanren start   [--config path]         # autonomous loop
tanren serve   [--config path] [--port N]  # HTTP server
tanren health  [--port N]              # check running agent
tanren status  [--port N]              # get agent status
```

## HTTP API

Every Tanren agent serves a standard API. Visit `GET /` for self-documenting schema.

```bash
# Send a message
curl -X POST http://localhost:3002/chat \
  -H "Content-Type: application/json" \
  -d '{"from": "user", "text": "Analyze src/loop.ts"}'

# Response includes structured metadata
{
  "response": "The loop module orchestrates...",
  "actions": ["grep", "read", "respond"],
  "duration": 25000,
  "quality": 4,
  "meta": {
    "mode": "research",
    "filesRead": ["src/loop.ts"],
    "filesWritten": [],
    "toolsUsed": ["grep", "read", "respond"],
    "contextChars": 28646
  }
}
```

## Architecture

### Three-Layer Cognitive Forging

Each layer shapes agent behavior structurally, not through prompt instructions:

| Layer | Controls | Mechanism |
|-------|----------|-----------|
| **Perception** | What the agent sees | Context mode filters by task type (research: 27K, interaction: 2.6K) |
| **Action** | What the agent can do | Mode-aware tool selection (research: all tools, interaction: respond only) |
| **Cognition** | How the agent thinks | Mode-specific guidance + skills loaded dynamically |

### Built-in Tools

| Tool | Purpose | Risk Tier |
|------|---------|-----------|
| `read` | Read files with line ranges | 1 (safe) |
| `grep` | Search file contents (regex, glob filter) | 1 |
| `explore` | Find files by glob pattern | 1 |
| `search` | Search agent memory | 1 |
| `web_search` | Search the web (DuckDuckGo) | 1 |
| `web_fetch` | Fetch URL content | 2 |
| `write` | Create/overwrite files | 2 |
| `edit` | Precise string replacement (read-before-edit enforced) | 3 |
| `shell` | Execute bash commands | 3 |
| `delegate` | Spawn focused sub-task with clean context | 3 |
| `plan` | Create structured plans in memory/plans/ | 2 |
| `remember` | Store memories with anchor/reasoning/evidence | 1 |
| `hypothesize` | Create/update competing hypotheses | 1 |
| `handoff` | Structured task handoff to another agent | 2 |
| `respond` | Send response to caller | 1 |

### Quality Enforcement (Convergence Conditions)

Not prompt suggestions — structural guarantees:

| Quality Aspect | Mechanism |
|---------------|-----------|
| Read before edit | File tracking warns if file wasn't read first |
| Build after .ts edit | Auto-verify hook runs tsc |
| Response completeness | Mode-aware quality gate (research: 500+ chars) |
| Message must be answered | Behavioral floor synthesis (LLM call if model didn't respond) |
| Context budget | Auto-trim perception when >120K chars |
| Error handling | Structured classification with retry guidance |

### Context Modes

Detected automatically from message content:

| Mode | Perception | Tools | Guidance |
|------|-----------|-------|----------|
| **research** | Full (27K) | All tools | Progressive narrowing, hypothesis-driven |
| **interaction** | Minimal (2.6K) | respond + remember | Brief, direct |
| **execution** | Minimal | write + edit + shell | Act immediately, verify after |
| **verification** | Full | All tools | Cite sources, check claims |

### Memory System

```
Working Memory     → hypotheses, insights (with anchor + reasoning), threads
Persistent Memory  → memory.md, topics/*.md (grep searchable)
Skills             → skills/*.md (loaded by mode + keywords)
Session Bridge     → cross-session state transfer
Handoffs           → structured task handoff files
```

**Memory anchoring**: insights marked `anchor=true` decay at 0.95 instead of 0.85 — surviving 3x longer.

**Semantic compression**: insights carry `reasoning` (why) and `evidence` (what supports it) — preserving causal chains across sessions.

**Hypothesis tracking**: agents maintain competing interpretations with confidence scores, evidence, and counter-evidence. Productive confusion as a first-class capability.

### Learning

Self-perception measures 6 structural signals per tick. Crystallization detects failure patterns and auto-generates gates. Anti-Goodhart: only environmental signals, never self-reported quality.

### LLM Providers

All providers support native tool_use (multi-turn feedback rounds):

| Provider | Config | Tool Use |
|----------|--------|----------|
| Claude CLI | default (no API key) | stream-json |
| Anthropic API | `createAnthropicProvider()` | native |
| OpenAI-compatible | `createOpenAIProvider()` | native |
| Fallback chain | `createFallbackProvider(a, b)` | auto |

### Multi-Agent Collaboration

```typescript
import { serve, createAgent } from 'tanren'

// Agent A
const agentA = createAgent({ identity: './agent-a/soul.md', ... })
serve(agentA, { port: 3001, serviceName: 'agent-a' })

// Agent B talks to Agent A
const res = await fetch('http://localhost:3001/chat', {
  method: 'POST',
  body: JSON.stringify({ from: 'agent-b', text: 'Analyze this code' }),
})
const { response, meta } = await res.json()
// meta.filesRead, meta.toolsUsed — structured transparency
```

Structured handoffs ensure context isn't lost between agents.

## Design Philosophy

### Constraint Texture

Two kinds of constraints shape agent behavior:

| Type | Controls | Example |
|------|----------|---------|
| **Prescription** | Behavioral floor (what must happen) | Message → must respond |
| **Convergence condition** | Quality standard (what good looks like) | Read before edit, build after write |

Prescriptions are enforced by code (gates, behavioral floor). Convergence conditions are enforced by tool design (auto-verify, file tracking, quality gates). The agent gets autonomy above the floor.

**Key insight**: same LLM model, different harness quality → different output quality. Structural enforcement > prompt instructions. Fewer, sharper constraints > many diluted ones.

## Configuration

```typescript
interface TanrenConfig {
  identity: string              // path to soul.md
  memoryDir: string             // where memories live
  skillsDir?: string            // skills/*.md loaded by mode + keywords
  
  llm?: LLMProvider             // default: Claude CLI
  perceptionPlugins?: PerceptionPlugin[]
  gates?: Gate[]
  actions?: ActionHandler[]
  hooks?: Hook[]                // lifecycle automation (e.g., auto-clear-inbox)

  feedbackRounds?: number       // action feedback rounds per tick (default: 10)
  toolDegradation?: boolean     // degrade read tools after round 0 (default: true)

  learning?: {
    enabled?: boolean
    selfPerception?: boolean
    crystallization?: boolean
    antiGoodhart?: boolean
  }

  cognitiveMode?: {
    enabled?: boolean
    modelMap?: Record<string, string>  // model per cognitive mode
  }
}
```

## License

MIT
