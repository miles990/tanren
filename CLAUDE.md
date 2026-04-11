# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm run typecheck    # tsc --noEmit
npm run test         # node --test dist/**/*.test.js (must build first)
```

Run a single test after build:
```bash
node --test dist/path/to/file.test.js
```

## Architecture

Tanren (鍛錬) is a perception-driven AI agent framework. Behavior is shaped through **structural constraint texture** — gates and tool design enforce rules, not prompts.

### Core Pipeline

```
perceive → think (LLM) → parse actions → gates → execute → observe → learn
```

The **tick** is the atomic unit. `loop.ts` orchestrates the full cycle. `actions.ts` parses `<action:type>` tags or native `tool_use` blocks and routes execution. `gates.ts` runs code-level constraints (block/warn/pass) before actions execute.

### Key Modules

- **`loop.ts`** — Tick orchestrator. Checkpoint recovery, message injection, multi-round tool-use feedback, autonomous objective synthesis.
- **`actions.ts`** — 30+ built-in actions across risk tiers (1=safe, 2=verify, 3=full feedback). Enforces read-before-edit via `_filesReadThisTick`.
- **`gates.ts`** — Quality gates: output-gate (must produce output), analysis-without-action, productivity, symptom-fix detection.
- **`context-modes.ts`** — Auto-detects mode from message (research/interaction/execution/verification). Each mode has its own context budget and tool set.
- **`memory.ts`** — File-based persistent memory (memory.md, topics/, daily/, state/). Git-friendly, grep-searchable.
- **`working-memory.ts`** — Hot cross-tick state with decay (0.85/tick, 0.95 if anchored). Tracks hypotheses with evidence/counter-evidence.
- **`perception.ts`** — Plugin-based environment sensing, filtered by context mode categories.
- **`learning/`** — Self-perception (6 structural signals, never self-report) + crystallization (patterns → auto-generated gates).

### LLM Providers (`src/llm/`)

All implement `LLMProvider.think(context, systemPrompt)`. **Critical**: `systemPrompt` stays separate at the backend's native system-prompt level — never concatenated into context.

| Provider | Auth | Tool Use |
|----------|------|----------|
| `claude-cli.ts` | Local `claude` CLI | Text `<action:type>` tags |
| `agent-sdk.ts` | Subscription (no API key) | Native built-in tools + budget control |
| `anthropic.ts` | `ANTHROPIC_API_KEY` | Native `tool_use` blocks |
| `openai.ts` | Any OpenAI-compatible endpoint | Native tool_use |

### Entry Points

- **`cli.ts`** — Commands: `tick`, `chat`, `run`, `start`, `serve`, `health`, `status`. Chat mode uses Agent SDK with session persistence and streaming.
- **`serve.ts`** — HTTP server. `POST /chat`, `POST /chat/stream` (SSE), `GET /health`, `GET /status`.
- **`index.ts`** — Library exports for programmatic use.

### Configuration

Config discovery: `tanren.config.ts|js|mjs`, fallback `soul.md`. See `examples/` for minimal/production configs.

`TanrenConfig` controls: identity, memoryDir, llm provider, gates, hooks, perception plugins, feedbackRounds, learning settings, cognitive mode settings.

## Design Invariants

- **Structural enforcement over prompt suggestions** — Gates block at execution time; tool shapes constrain what's possible.
- **Identity layer separation** — System prompt never mixed into context string.
- **Read-before-edit** — `actions.ts` tracks `_filesReadThisTick`; edit without prior read is rejected.
- **Anti-Goodhart** — Learning quality assessed from structural signals (duration, action counts, output existence), never from agent self-assessment.
- **Perception scarcity** — Context budget varies by mode (research: 27K, interaction: 2.6K). Only load what the task needs.
- **Risk-tiered feedback** — Tier 1 (safe: respond, read, search), Tier 2 (moderate: write, web_fetch), Tier 3 (high: shell, edit, git).

## Agent Integrity Gates

`defaultGates()` in `gates.ts` provides 7 gates — active by default when `config.gates` is not specified.

| Gate | Prevents |
|------|----------|
| `output-gate` | Consecutive ticks without visible output |
| `analysis-without-action` | Substantial thought but zero actions (cognitive paralysis) |
| `productivity-gate` | Only internal actions (read/remember) with no external output |
| `symptom-fix-streak` | Consecutive fix-like actions without stepping back to root cause |
| `ground-before-opine` | Responding about unread resources (URLs, projects) |
| `write-through` | Claiming "done" without persistent state change |
| `commitment` | Promising action without follow-through |

The principle behind all 7: use the smartest approach, find your own tools, adapt fast, complete perfectly, exceed expectations. Gates enforce this structurally where the failure mode is mechanical and detectable.

## TypeScript Conventions

- ES2022 target, Node16 module system, strict mode
- ESM (`"type": "module"` in package.json)
- Node.js native test runner (no external test framework)
- Node >=20.0.0 required
