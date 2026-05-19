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

### One-command setup (interactive wizard)

```bash
bash scripts/create-agent.sh
```

Wizard asks 6 questions → generates everything:
- `soul.md` (identity, in your language — EN/中文/日本語/한국어)
- `tanren.config.mjs` (LLM, gates, hooks, learning)
- `.env` (API keys)
- `manage.sh` (start/stop/status/logs)
- `memory/` + `messages/` (ready to use)

Then:
```bash
npx tanren chat  --config tanren.config.mjs       # interactive
npx tanren serve --config tanren.config.mjs       # HTTP server
```

### Manual setup (3 lines)

```bash
echo "I am a research assistant." > soul.md
mkdir memory
npx tanren chat                                    # works immediately
```

### Production config

```typescript
// tanren.config.mjs
export default {
  identity: './soul.md',
  memoryDir: './memory',
  skillsDir: './skills',
  llm: createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  feedbackRounds: 25,
  toolDegradation: false,
  hooks: [createAutoVerifyHook()],
  learning: { enabled: true, selfPerception: true, crystallization: true },
}
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

## Orchestration API

The orchestration middleware runs worker DAG plans through `POST /plan`.
It is designed for autonomous product teams where repeated cycles must survive
process restarts and avoid stepping on each other.

- Plan lifecycle events append to `plan-events.jsonl`, including plan start/completion, step attempts, retries, repair spawning, and lock acquisition/release.
- On startup, Tanren replays `plan-events.jsonl` as the source of truth for plan state. `plans-state.json` is retained as a compatibility snapshot for older runtimes.
- Task identity is composite: `planId + stepId`, so two plans can reuse the same step ids safely.
- `schedulerLock` defaults to `true`, allowing only one active product objective per repo through an atomic lock file at `.tanren/locks/product-objective.lock` with heartbeat. Send `"schedulerLock": false` only for intentionally independent maintenance work.
- `isolation.mode: "cycle-worktree"` runs the plan in a dedicated git worktree and verifies the main repo status did not change.
- `repair.enabled` defaults to on. Failed plans create one bounded typed repair DAG: classify failure, apply focused repair, verify, then report. Repair steps go through the same artifact contract policy as normal plans.
- Step `verifyCommand` runs in the plan cwd. Step `artifactContract` can declare `allowedPaths`, `expectedPaths`, and `forbiddenPaths`.
- Writer workers (workers with `Write`, `Edit`, or `shell` backend) must include `verifyCommand`, `artifactContract.allowedPaths`, and `artifactContract.expectedPaths`; otherwise `/plan` and `/plan/validate` reject the plan. Set `mode: "read"` or `mode: "verify"` for read-only or verification steps that use a capable worker but must not write files.
- Workers can declare a `policy` so custom AI agents are governed by capabilities instead of prompts: `capabilities`, `defaultMode`, `requiresArtifactContract`, `gates`, `allowedBackends`, `escalationPolicy`, and `riskLevel`. Write/report steps assigned to a worker with required `gates` must have downstream gate steps such as `{ "gate": "review" }`.
- `POST /plan/:id/merge` is the merge gate for isolated worktree plans. By default it requires completed `review`, `qa`, and `release` gates, no failed steps, a completed plan, and a clean worktree branch before fast-forward or squash merge.

Example step contract:

```json
{
  "id": "implement-ui",
  "worker": "coder",
  "mode": "write",
  "dependsOn": [],
  "task": "Implement the dashboard UI.",
  "verifyCommand": "npm run typecheck",
  "artifactContract": {
    "allowedPaths": ["src/dashboard", "docs/dashboard.md"],
    "expectedPaths": ["src/dashboard/index.ts"],
    "forbiddenPaths": ["package-lock.json"]
  }
}
```

Example custom worker policy:

```json
{
  "name": "gameplay-engineer",
  "backend": "sdk",
  "model": "sonnet",
  "tools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  "policy": {
    "capabilities": ["read", "write", "verify", "report"],
    "defaultMode": "write",
    "requiresArtifactContract": true,
    "gates": ["review", "qa"],
    "allowedBackends": ["sdk", "acp"],
    "escalationPolicy": "only_when_blocked",
    "riskLevel": "high"
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
| Codex CLI | `createCodexCliProvider()` | text |
| Anthropic API | `createAnthropicProvider()` | native |
| OpenAI-compatible | `createOpenAIProvider()` | native |
| Provider registry | `createProviderFromEnv()` | auto |
| Fallback chain | `createFallbackProvider(a, b)` | auto |

Provider adapters can be added without editing Tanren core by calling
`registerProviderFactory(name, factory, metadata)`. `createProvider()` and
`createProviderFromEnv()` resolve registered factories through the same provider seam.

Wrap any provider with `wrapProviderWithUsageLedger(provider, { stateDir, provider, model, cloud })`
to persist `llm-usage.jsonl` and `llm-usage-summary.json` for cloud/token auditing.

`createProviderFromEnv({ stateDir })` centralizes `LLM_PROVIDER`, local-vs-cloud fallback,
Codex CLI, usage ledger wiring, and health metadata. `decideProviderUse()` and
`wrapProviderWithPolicy()` can block cloud or autonomous cloud calls before tokens are spent;
`runAgentCli()` also refuses to start autonomous mode when policy disallows autonomous cloud.

### Artifact Providers

Artifact generation is a separate provider layer from text LLM routing. Runtime presets can
enable `artifact_generate`, `image_generate`, and `audio_generate` actions through
`createArtifactProviderFromEnv()`, while `/health.capabilities.artifacts` exposes the active
artifact providers. Standard HTTP endpoints:

- `POST /artifacts` — submit an artifact job and return its final job envelope.
- `POST /artifacts/stream` — submit and receive SSE progress events.
- `GET /artifacts` — list persisted jobs.
- `GET /artifacts/:jobId` — read a job by id.
- `GET /artifacts/:jobId/file` — serve a local artifact file.
- `GET /artifacts/:jobId/stream` — replay or follow provider artifact events.
- `DELETE /artifacts/:jobId` — cancel a job and persist cancelled status.
- `GET /policy/events` — read blocked LLM/artifact policy events.

Artifact action inputs accept `inputs` prompt blocks plus `refs`/`ref`/`sourceArtifactIds`, so
provider extensions can reuse prior images, audio, files, or graph outputs without inventing a
new action schema.

Use `parseArtifactRequest()` for shared validation, `routeArtifactRequest()` for capability and
policy-aware provider selection, and `ArtifactController`/`ArtifactFileServer` for HTTP-facing
job operations.

Artifact providers also support their own cloud guard and job persistence. Set
`TANREN_ALLOW_ARTIFACT_CLOUD=0` to disable cloud artifact calls before a request is sent, and
`TANREN_DAILY_ARTIFACT_CALL_CAP=N` to cap daily persisted artifact jobs. Job envelopes are stored
under `memory/artifacts/jobs/YYYY-MM-DD/*.json`, so `/artifacts/:jobId` can survive process
restarts when the provider is configured with the file job store.

`createRuntimeLayers()` exposes the provider, artifact, MCP, and capability layers before the
full `createAgentRuntimePreset()` composition, so an agent can override one layer without
forking the whole preset. `createGenerationIO()` is the common model/artifact generation seam
for future multimodal workflows.

Use `supportsModelRequest()` and `routeModelRequest()` to choose a model provider by declared
multimodal capabilities. The router checks prompt blocks (`text`, `media`, `stream`, `ref`)
and requested output/streaming capabilities before selecting a provider, so apps can prefer
Gemini/OpenAI/Anthropic for image/audio/file tasks while keeping text-only providers as safe
fallbacks.
`serve()` can expose that same router through `POST /model/route-preview`, allowing a UI to show
which provider would handle a text/media request without spending LLM tokens. When the caller
intentionally wants execution, `POST /model/generate` and `POST /model/stream` use the same
capability router to select and invoke the matching model provider.

### Agent Native UI Protocol

Tanren exposes an Agent Native UI Protocol (ANUP) for human-readable agent workbenches:

- `GET /workbench` / `GET /chat-ui` — browser chat plus ANUP state panel.
- `GET /loop/status` — live loop/pool status plus `live-status.json`.
- `GET /logs` — recent tick JSONL entries, markdown tick logs, and policy events.
- `GET /context` — memory/topic/working-memory snapshot for human inspection.
- `GET /api/dashboard/behaviors` — behavior digest from recent tick history.
- `GET /api/dashboard/learning` — learning/action-health/gate/working-memory state.
- `GET /api/dashboard/journal` — recent journal entries and tick markdown files.
- `POST /model/route-preview` — preview provider routing for text/media requests without invoking an LLM.
- `POST /model/generate` — route and execute a model request through the selected provider.
- `POST /model/stream` — route and execute a model request as SSE chunks.
- `GET /anup/overview` — project runtime capabilities, tasks, artifacts, and policy events.
- `GET /anup/tasks/:taskId` — project one long task into task/state/trace/result blocks.
- `GET /anup/runs` / `GET /anup/runs/:runId` — read persisted ANUP runs.
- `POST /anup/runs` / `POST /anup/runs/:runId/blocks` — persist agent UI blocks.
- `POST /anup/runs/:runId/actions` — record structured human approvals or modifications.
- `GET /anup/approvals` — list pending approval blocks.
- `POST /demo/anup` — seed a demo decision/approval/trace/media run.

`/chat` and `/chat/stream` automatically persist a chat ANUP run after completion. The run
contains a task contract, agent state, tool trace, response artifact, and approval review blocks
for high-risk actions such as `shell`, `edit`, and `git`. This makes browser workbench sessions
observable and replayable without exposing raw chain-of-thought.

For pre-execution safety, pass `enableApprovalGuard: true` to `createAgentRuntimePreset()`
or provide a custom `approvalGuard` in `TanrenConfig`. When enabled, high-risk actions are
blocked before their handler runs and an ANUP approval run is persisted under
`memory/state/anup`. The workbench can record approve/reject/modify responses against that run;
matching approved actions are allowed on retry, while rejected actions stay blocked.
Workbench chat also supports lightweight attachment refs by URL/path/media type; these are sent
as a structured `attachments: [{ uri, mediaType?, label? }]` request field, projected into ANUP
`media_ref` blocks, and summarized into the current text loop. Hosts with native multimodal
providers can route the same data as `PromptContentBlock[]`; the browser workbench calls
`/model/route-preview` while attachments are being entered so humans can see whether the current
provider pool will handle the media natively or preserve it as a reference.

### Resumable Long Tasks

Tanren can turn large review/research/implementation work into persisted DAG jobs instead of
forcing one LLM call to finish inside a tick. `LongTaskController` stores state under
`memory/tasks/{taskId}/`:

- `task.json` / `plan.json` — task envelope and ActionPlan.
- `events.jsonl` — step dispatch/completion/retry/cancel events.
- `checkpoints/*.json` — completed step results for resume.
- `result.md` / `result.json` — final digest.

Runtime presets enable long-task actions by default:

- `long_task_create` — create a generic ActionPlan-backed job.
- `review_task_create` — split long review work into intake, focused reviews, and synthesis.
- `long_task_status`, `long_task_resume`, `long_task_cancel`.

The built-in HTTP server exposes the same controller:

- `GET /tasks`
- `POST /tasks`
- `GET /tasks/:taskId`
- `DELETE /tasks/:taskId`
- `POST /tasks/:taskId/resume`
- `GET /tasks/:taskId/events`
- `GET /tasks/:taskId/result`

### Orchestration

Tanren also exports reusable worker orchestration modules:

- `PlanEngine` — DAG execution with dependencies, retry, verification, and convergence.
- `ResultBuffer` — task state, JSONL persistence, and event subscription.
- `createWorkerRuntime()` — backend routing for SDK, ACP, shell, webhook, logic, and middleware workers.
- `WORKERS` / `WorkerDefinition` — reusable worker presets and extension seam.

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
