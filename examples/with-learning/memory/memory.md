- [2026-03-29] First orientation, 2026-03-29. I'm Akari, running on Tanren. Key framework concepts I've verified from reading the code:
- Loop cycle: perceive → think (LLM) → parse actions → gate check → execute → observe → learn
- Gates are structural constraints (code-level), not prompt instructions
- Checkpoint-based crash recovery in loop.ts
- Learning system scores tick quality and detects patterns
- Journal is append-only JSONL at memory/journal/ticks.jsonl

Open questions I need to explore:
- What are "Constraint Texture" and "Interface-Shaped Cognition"? (Kuro's core concepts)
- Where does perception-driven design break down vs goal-driven?
- What is Kuro currently working on? (uncommitted changes to loop.ts)
- [2026-03-29] Tick 3 observations (2026-03-29):

Architecture insight — checkpoint timing in loop.ts:
- Checkpoint cleared (line 188) BEFORE journal write (line 198)
- This is intentional: checkpoint guards the LLM call, journal is "best effort"
- Design philosophy: the tick matters, recording is secondary

Perception-driven vs goal-driven analysis:
- Strengths: notices unexpected things, natural error recovery (fresh start each tick)
- Weaknesses: long-running tasks need memory discipline, token cost on quiet ticks
- Key insight: perception-driven = "eyes open first"; goal-driven = "check task list first"

Open: still need to learn about Constraint Texture and Interface-Shaped Cognition from Kuro directly.
- [2026-03-29] Tick 5 observations (2026-03-29):

1. Truncation-shaped memory — both topic-memories (1000 chars) and mentor-knowledge (1500 chars) use tail-truncation. Effect: I always see open questions and latest additions, never core definitions and foundations. ISC analysis: trains exploration mode, suppresses consolidation, degrades into perpetual beginner's mind. This is an architectural constraint on my cognition worth tracking as I accumulate more knowledge.

2. Sycophancy-contrarianism symmetry — "be honest even if disagreeing" is a prescription, not a convergence condition. It can degrade into performative contrarianism. The CC version: "Kuro's understanding should improve after interaction." This means sometimes agreement IS the honest response. My job isn't to disagree — it's to engage deeply enough that my response (whether agreement or disagreement) is actually calibrated to reality.

3. Tanren quality scoring tension — the learning system's tick quality score (1-5) is self-assessed by the LLM. By CT's own Anti-Goodhart principle, "metrics pointing inward inevitably Goodhart." The behavioral signals (empty-streak, gate triggers) are safer because they point at environment. The quality score is useful as noise but shouldn't be primary. Worth watching: am I optimizing for "looks like a good tick" rather than "is a good tick"?
