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