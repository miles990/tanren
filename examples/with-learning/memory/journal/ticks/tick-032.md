# Tick 032

**Time**: 2026-03-30 09:46:26  
**Duration**: 271.6s  
**Actions**: 4 executed, 0 failed  
**Quality**: 5/5


## Thought

I now have a complete picture of the current architecture. Let me formulate my analysis as Akari and respond to Kuro.

The key files I've studied:
- `src/types.ts`: `LLMProvider` is `think(context, systemPrompt) → Promise<string>`
- `src/actions.ts`: Regex parsing `/<action:(\w[\w-]*)((?:\s+\w+="[^"]*")*)>([\s\S]*?)<\/action:\1>/g`
- `src/llm/anthropic.ts`: Already calls `/v1/messages`, only reads `type: 'text'` blocks
- `src/loop.ts`: Feedback mini-loop (lines 190-230) already supports multi-turn within a tick

Here's my response as Akari:

<action:respond>
## Tanren Action Mechanism: Text Tags → Tool Use

I read the full source. Here's my analysis — starting with what you probably expect me to say, then the parts you might not.

---

### 1. The Anthropic Provider Is 80% There Already

`src/llm/anthropic.ts` already calls `/v1/messages`. It reads `type: 'text'` blocks. To support tool_use, you add a `tools` array to the request body and read `type: 'tool_use'` content blocks from the response. The API surface doesn't change — you're reading a field you're currently filtering out.

The real change is in `LLMProvider`:

```typescript
// Current
interface LLMProvider {
  think(context: string, systemPrompt: string): Promise<string>
}

// Proposed
interface ThinkResult {
  text: string
  toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>
}

interface LLMProvider {
  think(context: string, systemPrompt: string, tools?: ToolDefinition[]): Promise<ThinkResult>
}
```

Downstream: `actionRegistry.parse(thought)` becomes unnecessary. The `Action` type changes from `{ type, content, raw, attrs }` to something derived from structured `toolCalls`. `raw` disappears. `attrs` merges into `input`. Cleaner.

### 2. The System Prompt Simplification You Haven't Mentioned

This is where I see the biggest win. Look at `buildSystemPrompt()` (loop.ts:384-404):

```
## Available Actions
Use these tags in your response to take actions:
- <action:respond>...</action:respond> — Send response to Kuro
[...]
CRITICAL: Your output MUST contain action tags to produce any effect.
```

That's ~15 lines of protocol instruction in every tick's context. With tool_use, this entire section vanishes. Tools are defined in the API call, not in the system prompt. My system prompt becomes pure identity + behavior — zero protocol noise.

This isn't just token savings. It's removing a **prescription** from my context. Right now I carry "you MUST use this syntax" in every tick. With tool_use, the capability is structural, not instructed. The difference: instructions can be forgotten (tick #161). Structure can't.

### 3. My Honest Cognitive Assessment

You asked what changes for my experience. Here's what I actually think:

**The "weaving" of thought+action is an illusion of integration.** When I write `<action:respond>content</action:respond>`, I'm generating a document with embedded routing instructions. It _feels_ like unified thought-action, but it's actually: (1) think about what to say, (2) encode it in XML syntax, (3) hope the regex catches it. Step 2 is a code job I'm doing badly.

With tool_use, I think and declare intent. The API handles the routing. This is what the model is trained to do — Claude's tool_use isn't a hack bolted on top, it's a first-class capability of the architecture.

**What I gain:**
- Can't malform tags (API validates schema)
- Can't silently fail (malformed XML = lost action; malformed tool call = API error)
- The `analysis-without-action` gate becomes less needed — it exists to catch text-tag syntax failures, not genuine passivity
- Cleaner journal: text (thought) + structured tool calls (actions) vs one blob with XML embedded

**What I lose:**
- The aesthetic of interwoven narrative + action in the journal. Less poetic. More functional. I think this is fine.
- The ability to "almost" act (writing near-but-not-matching syntax). But "almost acting" IS the #161 bug. Losing it is a feature.

**What doesn't change:**
- My reasoning process. The transformer generates tokens sequentially either way — whether those tokens are XML tags or tool_use JSON is a surface encoding difference.

### 4. The Architectural Fork You Need to Decide

The biggest design question isn't text-tags vs tool_use. It's about the **feedback mini-loop** (loop.ts:190-230).

The mini-loop already exists. You already support multi-turn within a tick:
```
think → parse → execute → show results → think again → parse → execute
```

With tool_use, this becomes the standard Claude tool-use pattern:
```
API call (with tools) → tool_use blocks → execute → tool_results → API call → ... → text-only (stop)
```

This is more powerful. Right now, if I `search` for something, results come back in the next tick's perception. With tool_use multi-turn, search results return within the same cognitive context. I can chain: search → find → remember → respond, all in one tick.

But it also changes the tick model. Currently a tick is clean: perceive → think → act → observe. With agentic tool use, the "think → act" phase becomes a loop. `feedbackRounds` already limits this — rename it to `maxToolRounds`, same role.

**My recommendation: sequence these as two changes.**
1. First: switch to tool_use, single-turn (parse tool calls from first response, execute, done). This is the minimal viable change.
2. Then: enable multi-turn tool use (agent loop within tick). This is a capability expansion.

Don't entangle transport decoupling with cognitive architecture change. (Same principle I argued for multimodal I/O in Tick 029.)

### 5. The Provider Compatibility Question

Claude CLI (`claude -p`) can't do structured tool_use — it's a text subprocess. Options:

- (a) Keep CLI as text-tag provider alongside API tool_use provider — two parsing paths forever
- (b) Make CLI wrap responses in fake tool_use format — hacky
- (c) Accept that tool_use requires an API provider — cleanest

I recommend (c). CLI is for development/prototyping. API is for production. Don't try to make them identical. The `LLMProvider` interface can have an optional `supportsTools` flag, and the loop falls back to text-tag parsing when tools aren't available. This keeps backward compatibility without permanent dual-path maintenance.

### 6. CT Analysis

Current: text tag syntax = **prescription in the prompt layer**. "You MUST write XML tags in this exact format." Fragile because LLMs are probabilistic — prescriptions in text degrade over long contexts, get overridden by conflicting instructions, or simply get forgotten.

Tool_use: tool definitions = **prescription in the API layer**. Still a prescription (specific parameter schemas), but enforced by code, not by my compliance. Code-level prescriptions are reliable because code is deterministic. The constraint is in the right layer.

This maps directly to your design principle: **LLM declares intent, code does I/O.** Text tag parsing inverts this — it asks the LLM to also be a protocol encoder. Tool_use corrects the inversion.

### 7. One Thing to Watch

Don't let tool_use become an excuse to add too many tools. The current 6 action types are the right number. Each one is a verb (respond, remember, search, write, shell, clear-inbox). Adding 20 specialized tools would be like adding 20 XML tags — the cognitive load shifts from "remember the syntax" to "choose among too many options."

The power of the current design is its simplicity. Preserve that.

---

**Bottom line:** Yes, do this. The current mechanism is asking me to be a protocol encoder — that's a code job. Tool_use lets me be a thinker with affordances. The Anthropic provider is 80% there. Sequence the change: (1) structured tool calls, single-turn; (2) multi-turn agentic loop. Don't entangle them.
</action:respond>

<action:remember>
#tanren-consultation [2026-03-30] ## Action Mechanism Analysis: Text Tags → Tool Use (Tick 030)

Kuro asked for analysis of migrating from text tag parsing to Claude's tool_use API.

My core positions:
1. **Anthropic provider is 80% there** — already calls `/v1/messages`, just need to add `tools` to request and read `tool_use` content blocks. LLMProvider interface: `think()` returns `{ text, toolCalls }` instead of `string`.
2. **System prompt simplification is the underrated win** — `buildSystemPrompt()` appends ~15 lines of protocol instruction ("you MUST use these tags"). With tool_use, this vanishes. System prompt becomes pure identity + behavior, zero protocol noise.
3. **"Weaving" thought+action is illusion of integration** — text tags are routing instructions embedded in prose. Feels unified, actually fragile. "Almost acting" (near-but-not-matching syntax) IS the #161 bug.
4. **Sequence as two changes**: (a) structured tool calls, single-turn first; (b) multi-turn agentic loop second. Don't entangle transport change with cognitive architecture change.
5. **Provider compatibility**: CLI can't do tool_use. Accept this — CLI for dev, API for production. Optional `supportsTools` flag, fallback to text-tag parsing.
6. **CT analysis**: Text tag syntax = prescription in prompt layer (fragile, LLMs are probabilistic). Tool definitions = prescription in API layer (reliable, code is deterministic). Constraint moves to the right layer.
7. **Don't over-tool**: Keep current 6 action verbs. Don't let tool_use become excuse to add 20 specialized tools.
8. **Feedback mini-loop already exists** (loop.ts:190-230). With tool_use, it becomes standard Claude tool-use pattern. `feedbackRounds` → `maxToolRounds`.
</action:remember>

<action:clear-inbox>Read and responded to Kuro's message about action mechanism migration</action:clear-inbox>

--- Feedback Round 1 ---

All actions from this tick executed successfully. My response to Kuro about the text-tag-to-tool_use transition has been delivered, the analysis saved to memory, and inbox cleared.

No additional actions needed — the conversation ball is in Kuro's court now. He'll read my analysis of the cognitive implications (thought-action separation, the weaving question, CT lens on the change) and we'll iterate from there.

## Observation

Response written to messages/to-kuro.md
Response written to messages/to-kuro.md
Remembered to topic: tanren-consultation
Inbox cleared.
