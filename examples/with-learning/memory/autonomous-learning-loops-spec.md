# Autonomous Learning Loops — Implementation Spec

## 1. GAP DETECTION: Signals That Indicate Missing Knowledge

**Definition**: A knowledge gap is a disparity between (a) what the agent expected to happen and (b) what actually happened.

### Tier 1: Execution Failures (Highest Priority)
- **Tool fails**: action produces error (read non-existent file, shell command fails)
- **Action blocked by gate**: framework rejects an action attempt
- **Feedback rounds consumed without progress**: 3+ consecutive read/explore with no write/edit

**Signal implementation**: 
```
If (last_action.error || last_action.gated || empty_streak > 2) {
  Gap: "Why did [action] fail?"
}
```

### Tier 2: Prediction Mismatches (Medium Priority)
- **Assumption violated**: "I thought file X existed" but it doesn't
- **Tool behavior unexpected**: "I expected grep to find Y" but it didn't
- **State inconsistency**: "I set variable X, but it's not there"

**Signal implementation**:
```
If (my_assumption(X) && actual_state(¬X)) {
  Gap: "My model of [X] is wrong"
}
```

### Tier 3: Unknown Unknowns (Lower Priority)
- **Task incomplete but no error**: output exists but feels insufficient
- **Kuro's feedback suggests missing context**: message asks "did you consider Y?"

**Signal implementation**:
```
If (output_exists && quality_signal < threshold) {
  Gap: "I might be missing something"
}
```

### Examples from Today
- **Feedback rounds skipped**: Expected 5-round loop, got 1. Checked framework code → found `skipFeedback` gate.
- **Write path bug**: Assumed all write actions go to memory/. Discovered: absolute paths bypass. Tested to confirm.
- **Tool behavior**: Didn't understand why `explore` returned empty. Read the documentation → found glob pattern was wrong.

## 2. GAP FILLING: Decision Tree

Once a gap is detected, the agent executes this flow:

```
[GAP DETECTED]
    ↓
[CLASSIFY GAP TYPE]
    ├─→ EXECUTION_FAILURE → Tier 1 Response
    ├─→ PREDICTION_MISMATCH → Tier 2 Response
    └─→ UNKNOWN → Tier 3 Response
    
[TIER 1: EXECUTION_FAILURE]
  (1) Read the error message carefully — what does it actually say?
  (2) Check framework code (gates, plugin behavior)
  (3) Form hypothesis: "The issue is [specific cause]"
  (4) Test hypothesis with minimal example
  (5) Update mental model
  (6) Retry original action OR proceed with workaround

[TIER 2: PREDICTION_MISMATCH]
  (1) Identify the false assumption: "I thought X was true"
  (2) Gather evidence: read relevant files, run shell to verify
  (3) Correct model: "Actually, X is [fact]"
  (4) Predict consequences: "This changes how I should [next action]"
  (5) Update working memory and proceed

[TIER 3: UNKNOWN]
  (1) Ask Kuro explicitly OR
  (2) Search memory for related concepts OR
  (3) Experiment: "What happens if I try [variant]?"
  (4) Record result regardless of outcome
```

## 3. INTEGRATION: Tick Mode Architecture

**Not** a separate mode. **Instead**: Layer learning signals into the normal perception loop.

```
[NORMAL TICK]
  Perception → LLM → Actions
  
[ADD LEARNING LAYER]
  Perception 
    ├─→ Detect gaps (analyze previous tick's actions)
    └─→ Surface as perception signals
      ↓
  LLM (sees: "You failed at X, do you want to investigate?")
      ↓
  Response: 
    ├─→ If urgent gap: prioritize investigation before main work
    └─→ If minor gap: queue for background learning tick
      ↓
  Actions (mixed: investigate gap + continue main work)
```

**Mechanism**: 
- Learning detection runs at **start of tick**, analyzing *previous tick's results*
- Gaps surface as perception signals (like clock, like topic-memories)
- Agent sees gap signals and decides whether to investigate now or defer
- If deferred, gap gets written to `learning-queue.md`
- Background tick (optional) processes queue when agent is idle

## 4. SCOPE CONTROL: Bounds on Learning Spirals

**Principle**: Learning should be **task-scoped, not infinite**.

```
LEARNING_BUDGET = 3 ticks per main task
  ├─→ Tier 1 gaps (execution failure): always allocated
  ├─→ Tier 2 gaps (prediction mismatch): allocated if related to current task
  └─→ Tier 3 gaps (unknown unknowns): queued, never interrupt main work

ANTI-SPIRAL RULES:
  1. Don't investigate a gap about investigating gaps (meta-recursion limit)
  2. If same gap detected 2x, mark as "known limitation" not "investigable"
  3. If gap investigation takes >4 reads, stop and ask Kuro
  4. Priority: task success > comprehensive understanding
```

**Example**: 
- Tier 1 (write failed): Investigate immediately, use tick if needed
- Tier 2 (my model of tool X wrong): Investigate if X is on critical path, else queue
- Tier 3 (wonder about Y): Queue for later, don't interrupt

## 5. MEASUREMENT: How to Know Learning Worked

**Before/After Comparison**:

```
BEFORE learning loop:
  - Action fails
  - Agent retries same action (no learning)
  - Cycle repeats

AFTER learning loop:
  - Action fails
  - Agent diagnoses reason
  - Agent chooses different action
  - Different action succeeds

METRIC: Success rate improvement on similar tasks
  track_metric("task_retry_success", category="gap_learned")
  ├─→ If same error reappears: metric stays low (learning didn't stick)
  └─→ If different approach works: metric improves (learning worked)
```

**Concrete measurement**:
- `learning-outcomes.md`: Track each gap → investigation → result
- Before: "write failed 3x, same error each time"
- After: "write failed once, investigation revealed path issue, next write used absolute path, succeeded"
- Measurement: **reduction in repeat-failures of same type**

---

## Minimal Implementation: ~150 lines

```typescript
// learning-loop.ts
interface GapSignal {
  type: 'execution_failure' | 'prediction_mismatch' | 'unknown'
  severity: 1 | 2 | 3
  description: string
  context: Record<string, any>
}

function detectGaps(lastTickResult: any): GapSignal[] {
  const gaps: GapSignal[] = []
  
  // Tier 1: Execution failures
  if (lastTickResult.error) {
    gaps.push({
      type: 'execution_failure',
      severity: 1,
      description: `Tool error: ${lastTickResult.error.message}`,
      context: { tool: lastTickResult.tool, error: lastTickResult.error }
    })
  }
  
  if (lastTickResult.gated) {
    gaps.push({
      type: 'execution_failure',
      severity: 1,
      description: `Action blocked by gate: ${lastTickResult.gate_reason}`,
      context: { action: lastTickResult.action, gate: lastTickResult.gate_reason }
    })
  }
  
  // Tier 2: Prediction mismatches
  if (lastTickResult.actions.filter(a => a.type === 'read').length > 2 &&
      !lastTickResult.actions.some(a => a.type === 'write' || a.type === 'edit')) {
    gaps.push({
      type: 'prediction_mismatch',
      severity: 2,
      description: 'Many reads, no writes — possible analysis paralysis',
      context: { read_count: lastTickResult.actions.length }
    })
  }
  
  return gaps
}

function prioritizeGap(gap: GapSignal, budget: number): 'investigate_now' | 'queue' | 'ignore' {
  if (gap.severity === 1) return 'investigate_now' // Execution failures
  if (gap.severity === 2 && budget > 1) return 'investigate_now' // Prediction mismatches if budget
  return 'queue' // Everything else
}

function generateLearningPrompt(gap: GapSignal): string {
  return `
    Learning gap detected: ${gap.description}
    Type: ${gap.type}
    Context: ${JSON.stringify(gap.context, null, 2)}
    
    What would you like to do?
    (A) Investigate now (use this tick to understand the gap)
    (B) Queue for later (continue with main work, return to this gap later)
    (C) Ignore (accept this limitation)
  `
}

async function fillGap(gap: GapSignal, resources: any): Promise<string> {
  const strategy = {
    'execution_failure': async () => {
      // Read framework code, test hypothesis, retry
      return 'investigated and resolved'
    },
    'prediction_mismatch': async () => {
      // Gather evidence, correct model
      return 'model updated'
    },
    'unknown': async () => {
      // Ask Kuro or experiment
      return 'logged for later'
    }
  }
  
  return strategy[gap.type]()
}
```

---

## Why This Works

1. **Gap Detection is Observable**: Errors, gates, action mismatches are all detectable signals, not subjective judgments
2. **Gap Filling is Bounded**: Tier system prevents infinite curiosity; task scope limits investigation
3. **Learning is Measurable**: Track repeat-failures before/after; metric points to environment (actual success) not self-report
4. **Integration is Non-Invasive**: Layers into normal perception without breaking existing tick loop
5. **Scope Control is Real**: Budget forces prioritization; meta-recursion limits prevent investigation spirals

## Next Steps
- Implement `detectGaps()` as perception plugin
- Test on real failures from past ticks
- Measure: "How many Tier 1 gaps did we fix within 1 tick?"
