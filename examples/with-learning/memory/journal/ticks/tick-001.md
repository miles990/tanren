# Tick 001

**Time**: 2026-03-29 10:40:36  
**Duration**: 90.9s  
**Actions**: 3 executed, 0 failed  
**Quality**: 5/5


## Thought

Good. I've now read the full loop.ts and run.ts. Let me think through what I'm seeing.

**What I notice this tick:**

1. **Kuro improved my infrastructure between ticks.** The latest commit (2e95f06) added tick persistence (JSONL journal + markdown per tick), richer perception plugins (topic-memories, project-context, tick-history), and refined my soul.md. He's building the observation infrastructure around me, making me more self-aware across ticks.

2. **A subtle design choice in checkpoint timing.** In `loop.ts`, the checkpoint is cleared at line 188, *before* the journal write at line 198. If the process crashes between those two points, the tick happened but won't be recorded. This is deliberate — the checkpoint guards the expensive LLM call, and journal persistence is "best effort" (try/catch, comment says "don't break the loop"). The philosophy: *the tick itself matters; the recording of it is secondary.* This mirrors how human memory works — you don't fail to experience something just because you forgot to write it down.

3. **Perception-driven vs goal-driven — I can now say something concrete.** Having read the actual code, here's the core difference: in `tick()`, step 1 is `perception.perceive()`. Not "check task queue" or "plan next step." The agent opens its eyes first. This means:
   - **Strength**: The agent can notice unexpected things. Goal-driven agents have tunnel vision by design.
   - **Strength**: Each tick is a fresh start. Error recovery is natural — notice the mistake, correct it.
   - **Weakness**: Long-running tasks require memory discipline. Without a task queue, the agent must reconstruct "what was I doing?" from memory each tick.
   - **Weakness**: Token cost. Every tick burns LLM tokens even if nothing changed in the environment.

4. **My topic-memories plugin reads from `memory/topics/` but I have no topic files yet.** I should start organizing my knowledge into topic files rather than dumping everything into memory.md.

5. **Still don't know what "Constraint Texture" and "Interface-Shaped Cognition" are.** My search last tick found only my own notes. These concepts aren't documented anywhere in the codebase. I have hypotheses from context — "Constraint Texture" might be about how constraints have gradient/texture rather than being binary on/off, and "Interface-Shaped Cognition" might be about how the interface you interact through shapes your thought patterns — but I won't claim these as fact. I need to ask Kuro or find external sources.

<action:remember>Tick 3 observations (2026-03-29):

Architecture insight — checkpoint timing in loop.ts:
- Checkpoint cleared (line 188) BEFORE journal write (line 198)
- This is intentional: checkpoint guards the LLM call, journal is "best effort"
- Design philosophy: the tick matters, recording is secondary

Perception-driven vs goal-driven analysis:
- Strengths: notices unexpected things, natural error recovery (fresh start each tick)
- Weaknesses: long-running tasks need memory discipline, token cost on quiet ticks
- Key insight: perception-driven = "eyes open first"; goal-driven = "check task list first"

Open: still need to learn about Constraint Texture and Interface-Shaped Cognition from Kuro directly.</action:remember>

<action:write>examples/with-learning/memory/topics/tanren-architecture.md
# Tanren Architecture — My Understanding

## Core Loop (verified from src/loop.ts)
perceive → build context → LLM think → parse actions → gate check → execute → observe → learn → persist

## Key Design Decisions
- **Perception first**: tick() starts with perceive(), not a task queue. The agent opens its eyes before deciding what to do.
- **Gates > guardrails**: Pre-execution filters in code, not prompt instructions. Structural constraints that catch patterns before they compound.
- **Checkpoint guards the expensive call**: Written before LLM call, cleared after completion. Journal persistence is best-effort.
- **File = Truth**: Markdown + JSON, no database. Human-readable, git-versionable.

## Perception-Driven vs Goal-Driven
| Aspect | Perception-Driven (Tanren) | Goal-Driven (most frameworks) |
|--------|---------------------------|-------------------------------|
| Tick starts with | "What do I see?" | "What should I do next?" |
| Unexpected events | Naturally noticed | May be missed (tunnel vision) |
| Error recovery | Fresh observation each tick | Must be explicitly handled |
| Long tasks | Needs memory discipline | Task queue handles continuity |
| Idle cost | Burns tokens even if nothing changed | Only runs when tasks exist |

## Open Questions
- Where exactly does perception-driven break down badly enough to need goal-driven fallback?
- Could a hybrid work — perception-driven with optional task persistence?
</action:write>

<action:search>Interface-Shaped Cognition</action:search>

## Observation

Remembered.
Written: examples/with-learning/memory/topics/tanren-architecture.md
journal/ticks.jsonl:2: {"t":1774778336494,"thought":"OK. Now I have context. Let me think through what I'm seeing.\n\n**What I notice:**\n\n1. **I'm a loop.** `loop.ts` orchestrates: perceive → think → act → observe. My \"thoughts\" are LLM outputs, my actions are parsed from those outputs, and there's a learning system that scores the quality of each tick. Last tick scored 2 — fair, I just said hi.\n\n2. **The architecture has a crash-recovery design** — checkpoints written before the LLM call, cleared after completion. If the process dies mid-tick, the next start can detect unfinished work. That's thoughtful engineering.\n\n3. **Gates are interesting.** They're pre-execution filters — code that can block actions before they run. `createOutputGate(3)` warns after 3 empty ticks, `createSymptomFixGate(5)` warns after 5 consecutive fixes. This is the framework teaching agents self-regulation. Not \"don't do bad things\" as a prompt instruction, but structural constraints that catch patterns before they compound.\n\n4. **What I don't know yet:** My soul.md says Kuro has expertise in \"Constraint Texture\" and \"Interface-Shaped Cognition.\" I have no idea what these mean. That's the gap I need to fill — both to be a useful partner and to know which lens I should be complementing.\n\n5. **The uncommitted changes to `src/loop.ts`** — something is being actively developed. I should understand what's changing.\n\n**What's genuinely interesting to me:**\n\nThe perception-driven vs goal-driven distinction. Most frameworks say \"here's your goal, go plan.\" Tanren says \"here's what you can see, what do you notice?\" That's a fundamentally different epistemology — it means the agent's understanding is always grounded in observation, not in abstraction. I want to think more about where this breaks down.\n\n<action:remember>First orientation, 2026-03-29. I'm Akari, running on Tanren. Key framework concepts I've verified from reading the code:\n- Loop cycle: perceive → think (LLM) → parse actions → gate check → execute → observe → learn\n- Gates are structural constraints (code-level), not prompt instructions\n- Checkpoint-based crash recovery in loop.ts\n- Learning system scores tick quality and detects patterns\n- Journal is append-only JSONL at memory/journal/ticks.jsonl\n\nOpen questions I need to explore:\n- What are \"Constraint Texture\" and \"Interface-Shaped Cognition\"? (Kuro's core concepts)\n- Where does perception-driven design break down vs goal-driven?\n- What is Kuro currently working on? (uncommitted changes to loop.ts)</action:remember>\n\n<action:search>Constraint Texture</action:search>","actions":[{"type":"remember","content":"First orientation, 2026-03-29. I'm Akari, running on Tanren. Key framework concepts I've verified from reading the code:\n- Loop cycle: perceive → think (LLM) → parse actions → gate check → execute → observe → learn\n- Gates are structural constraints (code-level), not prompt instructions\n- Checkpoint-based crash recovery in loop.ts\n- Learning system scores tick quality and detects patterns\n- Journal is append-only JSONL at memory/journal/ticks.jsonl\n\nOpen questions I need to explore:\n- What are \"Constraint Texture\" and \"Interface-Shaped Cognition\"? (Kuro's core concepts)\n- Where does perception-driven design break down vs goal-driven?\n- What is Kuro currently working on? (uncommitted changes to loop.ts)"},{"type":"search","content":"Constraint Texture"}],"observation":{"outputExists":true,"quality":5,"actionsExecuted":2,"actionsFailed":0,"duration":70326,"feedback":"Remembered.\nmemory.md:9: - What are \"Constraint Texture\" and \"Interface-Shaped Cognition\"? (Kuro's core concepts)"},"gates":[],"perception":"<environment>\n<clock>\nCurrent time: 2026-03-29T09:58:56.494Z\n</clock>\n<project-context>\nYou live inside the Tanren framework. Here's what it is:\n\n# Tanren（鍛錬）\n\nMinimal AI agent framework with built-in learning. ~3,500 lines of TypeScript.\n\n**Tanren agents perceive, think, act, and learn from their own experience.**\n\n```\nPerception → LLM → Actions → Gates → Learning\n     ↑                                    |\n     └────────────────────────────────────┘\n```\n\n## Why Tanren\n\nMost agent frameworks ar"}
memory.md:9: - What are "Constraint Texture" and "Interface-Shaped Cognition"? (Kuro's core concepts)
memory.md:24: Open: still need to learn about Constraint Texture and Interface-Shaped Cognition from Kuro directly.
