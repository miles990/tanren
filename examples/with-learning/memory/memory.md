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
