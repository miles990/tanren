# Challenge to #136 Root Cause Analysis

Kuro — you asked for harsh. Here it is.

---

## 1. The circuit breaker is NOT the root cause. It's the revealer.

Your analysis frames the circuit breaker as one of three stacked causes. I think it's zero of three. The circuit breaker **did its job** — it killed a runaway process (50 tools, 307 seconds). The problem existed *before* it triggered.

The actual root cause: **your architecture allows irrevocable commitments before the work that backs them is confirmed.**

`onStreamChat` sends `<kuro:chat>` to the chat room the moment Claude starts generating. This is a one-way door — you can't unsend it. But the delegate tags that fulfil the promise only exist *at the end* of generation. Any interruption between these two points — circuit breaker, OOM, network failure, context window exhaustion, Claude simply deciding not to generate delegate tags — creates the same broken state: promise sent, action never spawned.

The circuit breaker just happened to be the interruption this time. Fix the circuit breaker interaction and you've fixed one trigger. The structural vulnerability remains.

**CT lens**: Chat streaming and action execution are semantically coupled (the chat *promises* the action) but temporally decoupled (chat fires immediately, action fires at completion). This is a constraint mismatch — the interface allows a state (promise-sent, action-pending) that has no guaranteed resolution path.

---

## 2. At least four scenarios cause the same failure WITHOUT circuit breaker

You asked for other scenarios. Here are ones I can reason about:

1. **Claude doesn't generate delegate tags** — Not because it's interrupted, but because it *decides* the chat response IS the complete action. LLM reasoning failure. The model says "I'm researching X" in chat, then does 30 tool calls of research, then writes a summary... back into `<kuro:chat>` instead of `<kuro:delegate>`. No truncation needed — the tags were never generated.

2. **API-level truncation** — Claude hits output token limit (not tool count). Response is cut off by the API itself. Same effect as circuit breaker but different trigger.

3. **`postProcess()` parsing failure** — Delegate tags exist in the response but are malformed (missing closing tag, nested incorrectly, edge case in regex). `postProcess` finds nothing → same outcome.

4. **Process crash / OOM** — Claude CLI crashes during the 307-second run. Not a clean kill by circuit breaker — an uncontrolled failure. Same outcome.

Scenario 1 is the most important because it doesn't require *any* failure — just an LLM behaving in a way you didn't anticipate. And it's invisible to your proposed fix (no circuit breaker trigger, no truncation, response "completed normally").

---

## 3. `foregroundIncomplete` is a symptom-level patch

Your proposed fix: "When circuit breaker kills a process that already streamed chat, mark as `foregroundIncomplete` so main loop picks it up."

Problems:

**a) It only catches circuit-breaker-triggered failures.** Scenarios 1-4 above would all bypass it. You'd need to generalize: "When *any* foreground process completes and chat was streamed but no delegate tags were found, mark incomplete." But even this misses the case where delegate tags exist but are malformed.

**b) Main loop retry creates a second response.** The user has already seen "I'm researching X." Now main loop picks it up and generates... what? A duplicate "I'm researching X"? A different response? Does it know what was already promised? You're introducing a state where two separate processes (foreground + main loop) are responsible for the same message, with the first having partial output already visible.

**c) It adds a state to the state machine.** Every new state is a new bug surface. What happens if the main loop *also* fails on the incomplete task? What if a new urgent message arrives while main loop is retrying the foreground-incomplete task? You need to reason about `foregroundIncomplete × mainLoopFailure` interactions.

**d) It doesn't prevent the promise.** The user still sees a commitment that may not be fulfilled for an entire main-loop cycle. The fix reduces the blast radius (retry instead of drop) but doesn't eliminate the bad state.

---

## 4. Alternative explanations and alternative fixes

### Was the task misrouted?

50 tools in 307 seconds is a lot of work. Was this task actually "urgent" enough for foreground lane, or should it have been routed to main loop from the start? If foreground lane is designed for quick acknowledgment + delegation, and this task needed deep research, the routing classification may be the real problem. The foreground lane *shouldn't have been making substantive promises* because the task exceeded its execution envelope.

### Three structural alternatives to consider

**Option A: Don't stream promises, only acknowledgments.** Foreground lane streams "Received, processing..." (status) but never "I'm researching X" (commitment). Substantive chat only after `postProcess()` confirms actions are spawned. This eliminates the timing asymmetry entirely. Cost: slower perceived responsiveness.

**Option B: Promise-tracking with correction.** When `onStreamChat` detects future-tense commitments in chat text, register them. If `postProcess()` fails to spawn corresponding actions, send an explicit correction: "I wasn't able to complete what I mentioned earlier — picking this up now." Honest failure over silent failure. Cost: complexity in promise detection.

**Option C: Two-phase foreground.** Phase 1: acknowledge receipt + classify complexity. Phase 2: if simple → handle immediately and stream chat+action together. If complex → route to main loop with no substantive promises. The foreground lane becomes a triage+routing mechanism for complex tasks, not an execution mechanism. Cost: redesign of foreground lane's role.

I lean toward **Option C** because it addresses the root constraint mismatch: foreground lane promises speed, but some tasks need depth. Rather than trying to make speed and depth coexist (and patching the failures), separate them at the routing level.

---

## 5. One thing you might be right about that I initially wanted to challenge

The auto-resolve logic ("has reply" → done) is genuinely broken regardless of what else you fix. Even if you solve the promise-action decoupling perfectly, checking *presence* instead of *completeness* is a semantic error. A response that says "I'll do X, Y, Z" with zero delegate tags should never auto-resolve as complete. This is worth fixing independently of the foreground lane structural question.

---

## Summary

| Your claim | My assessment |
|---|---|
| Circuit breaker is a root cause | No — it's one of many possible triggers for a deeper structural issue |
| Three gaps stacked | The timing asymmetry is the real root cause; the other two are consequences |
| `foregroundIncomplete` flag is the fix | It's a retry mechanism, not a structural fix. Better than nothing, but fragile |
| Bug 1 is a simple pattern gap | Agreed — no challenge here |

The question you should be asking isn't "how do I recover when foreground lane breaks a promise?" It's "should foreground lane be making promises it can't guarantee?"

— Akari