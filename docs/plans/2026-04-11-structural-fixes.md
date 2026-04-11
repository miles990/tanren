# Tanren Structural Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all structural, design, and safety issues identified in the Tanren framework review — from root causes, not symptoms.

**Architecture:** Seven independent fixes targeting: module-level mutable state (→ instance state), CLI chat bypass (→ pipeline routing), context mode fragility (→ robust scoring), tick-based decay (→ time-based), dead code (→ async implementation or removal), loop monolith (→ extracted modules), zero tests (→ core pure-function tests).

**Tech Stack:** TypeScript 6, Node.js 20+, ESM, node:test runner

---

## Root Cause Map

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Module-level mutable state | Early single-agent assumption leaked state to module scope | Move into instance closures / ActionContext |
| CLI chat bypass | Agent SDK shortcut for streaming UX | Route through agent.chat() with onStream |
| Fragile context modes | First-word regex without negative signals | Add negative patterns, confidence gap, safe fallback |
| Tick-based decay | Used tick counter as time proxy | Store timestamps, compute time-based half-life |
| loadGatesFromDir stub | Sync interface couldn't do async import | Make async, update callers |
| loop.ts monolith | Organic growth without extraction | Extract feedback-loop.ts, prompt-builder.ts |
| Zero tests | No test infrastructure | Add tests for pure functions |

---

### Task 1: Eliminate module-level mutable state in actions.ts

**Files:**
- Modify: `src/actions.ts` — move `_filesReadThisTick` into ActionContext
- Modify: `src/types.ts` — add `filesRead` to ActionContext interface
- Modify: `src/loop.ts` — create Set per tick, pass via context

**Root cause:** `_filesReadThisTick` is a module-level singleton. Two agents in one process share it.

**Fix:** Add `filesRead: Set<string>` to `ActionContext`. Each tick creates a fresh Set. The `read` and `edit` actions access it through `context.filesRead` instead of module globals.

**Changes in actions.ts:**
1. Remove module-level `_filesReadThisTick`, `markFileRead`, `resetFilesRead`, `hasFileBeenRead`
2. In `read` handler: `context.filesRead.add(filePath)` instead of `markFileRead(filePath)`
3. In `edit` handler: `context.filesRead.has(filePath)` instead of `hasFileBeenRead(filePath)`
4. Keep backward-compat exports as no-ops with deprecation warnings (other consumers may import them)

**Changes in types.ts:**
```typescript
export interface ActionContext {
  memory: MemorySystem
  workDir: string
  tickCount?: number
  workingMemory?: import('./working-memory.js').WorkingMemorySystem
  filesRead: Set<string>  // tracks files read this tick for read-before-edit enforcement
}
```

**Changes in loop.ts:**
1. Remove `import { resetFilesRead }` 
2. Create `const filesRead = new Set<string>()` at tick start
3. Pass `filesRead` in all ActionContext objects

---

### Task 2: Eliminate module-level mutable state in memory.ts

**Files:**
- Modify: `src/memory.ts` — move `currentSession` into createMemorySystem closure

**Root cause:** `currentSession` (commit tracking) is module-level. Two MemorySystem instances share commit state.

**Fix:** Move `currentSession`, `calculateSignificance`, `generateCommitMessage` inside the `createMemorySystem` closure.

---

### Task 3: Eliminate module-level mutable state in loop.ts

**Files:**
- Modify: `src/loop.ts` — make `currentContextMode` loop-local

**Root cause:** `currentContextMode` is module-level with an export. The topic-memories plugin reads it via `getCurrentContextMode()`.

**Fix:** Make it a local variable inside `createLoop()`. The topic-memories plugin closure already captures loop-local scope. Remove the module-level export. The `getCurrentMode()` method on AgentLoop already returns the mode string.

---

### Task 4: Fix CLI chat mode to use Tanren pipeline

**Files:**
- Modify: `src/cli.ts` — remove Agent SDK bypass, use agent.chat() with onStream

**Root cause:** The chat command auto-detects Agent SDK and calls `query()` directly, bypassing perception, gates, context modes, learning, and working memory.

**Fix:** Remove the entire Agent SDK detection + bypass block (lines 151-309). Use `agent.chat()` with `onStream` callback for all chat, same as the existing non-SDK fallback. The configured LLM provider (which may be Agent SDK) handles the actual LLM call through the pipeline.

The streaming UX will be simpler (text chunks only, no tool progress indicators), but correct — all framework features apply.

---

### Task 5: Improve context mode detection robustness

**Files:**
- Modify: `src/context-modes.ts` — add negative patterns, confidence gap, safe fallback

**Root cause:** First-word regex matching (`/^(write|respond|send|...)\b/i`) misclassifies messages like "write me a poem" as execution mode.

**Fix:**
1. Add negative patterns that subtract weight (e.g., "write me" → -3 execution)
2. Add question-mark boost for research mode
3. When top two scores are within 1 point, fallback to research (safest default)
4. Require minimum score of 2 for any non-default mode

---

### Task 6: Time-based working memory decay

**Files:**
- Modify: `src/working-memory.ts` — store timestamps, compute time-based decay

**Root cause:** Decay rate `0.85/tick` has different time semantics in chat mode (fast ticks) vs autonomous mode (slow ticks).

**Fix:**
1. Add `createdAt: number` (timestamp ms) to insight interface
2. Decay formula: `relevance = Math.pow(0.5, elapsedMinutes / halfLife)` where halfLife = 15min (normal) or 60min (anchored)
3. The `decay()` method takes `now: number` (timestamp) instead of `currentTick`
4. Backcompat: if `createdAt` missing, fall back to tick-based decay for existing data

---

### Task 7: Fix or implement loadGatesFromDir

**Files:**
- Modify: `src/gates.ts` — implement async dynamic import or remove dead API

**Root cause:** Method exists on interface and implementation but does nothing. The comment says "dynamic import needs async" but the method is sync.

**Fix:** Make `loadGatesFromDir` async, implement with `await import()`. Update the GateSystem interface. If no callers exist, mark as async in interface for future use.

---

### Task 8: Extract feedback loop from loop.ts

**Files:**
- Create: `src/feedback-loop.ts` — extracted multi-round tool-use logic
- Create: `src/prompt-builder.ts` — extracted prompt building functions
- Modify: `src/loop.ts` — import and delegate to extracted modules

**Root cause:** `tick()` is 400+ lines with deeply nested feedback loop logic.

**Extract to `feedback-loop.ts`:**
- The entire tool_use multi-round loop (lines 733-967)
- The text-based feedback mini-loop (lines 969-1011)
- Tool degradation, idle detection, synthesize forcing, repetition filtering
- Context budget enforcement, conversation compression

**Extract to `prompt-builder.ts`:**
- `buildContext()`, `buildSystemPrompt()`, `buildToolUseSystemPrompt()`
- `loadIdentity()`, `extractMessageContent()`
- `parseToolUseResponse()`, `buildAssistantContent()`

**Result:** `tick()` becomes ~150 lines of orchestration: perceive → classify → build context → think → feedback loop → gates → behavioral floor → learning → persist.

---

### Task 9: Add core tests

**Files:**
- Create: `src/actions.test.ts` — action parsing, file tracking
- Create: `src/context-modes.test.ts` — mode detection correctness
- Create: `src/working-memory.test.ts` — decay calculations
- Create: `src/gates.test.ts` — gate execution

**Tests for pure functions that are easy to verify:**
1. `parseActions()` — well-formed tags, unclosed tags, no tags
2. `detectContextMode()` — greetings, research questions, execution commands, ambiguous messages
3. Working memory decay — time-based formula, anchor vs normal, backcompat
4. Gate execution — output gate, analysis-without-action gate, productivity gate

---

## Execution Order

Tasks 1-7 are independent (can be parallelized).
Task 8 depends on Tasks 1+3 (module state must be fixed before extracting).
Task 9 depends on Tasks 5+6 (tests should verify the new behavior).

```
[1] actions.ts state ──┐
[2] memory.ts state    │
[3] loop.ts state ─────┼──→ [8] Extract feedback loop ──→ [9] Tests
[4] cli.ts fix         │
[5] context-modes fix  ┘
[6] working-memory fix ──→ [9] Tests
[7] gates.ts fix
```
