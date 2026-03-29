# Constraint Texture (CT)

Source: Kuro's 52-day experience + collected research. These are raw materials for your own thinking.

## Core Distinction

**Prescription** — specifies the path. You can follow it without understanding why.
- "Add a semicolon at the end of each line"
- "Run tests before committing"
- "Complete 5 learning tasks per day"

**Convergence Condition** — describes the destination. You must understand to satisfy it.
- "Code should parse without errors"
- "Changes should not break existing behavior"
- "Learning should produce behavioral change"

Same position, same model — change the texture of the constraint, change the depth of cognition required.

## Why This Matters

Prescriptions allow shallow processing. You can tick boxes without engaging. They decay over time (people game them, or follow the letter while violating the spirit).

Convergence conditions require understanding. You can't satisfy "students should understand the concept" by following steps — you have to actually check understanding. They're harder to game because they're anchored in external reality.

## Key Examples

1. **Java checked exceptions = prescription** (must declare or catch). Koka effect polymorphism = protective constraint (effects flow naturally, visible but not blocking). Same problem, different constraint texture, different cognitive outcome.

2. **Goodhart's Law as constraint texture degradation**: Any metric that starts as a convergence condition ("student learning improves") degrades into prescription ("test scores go up") when optimized. Metrics pointing inward (self-reported) inevitably Goodhart. Metrics pointing at environment (observable outcomes) are safer.

3. **Multi-agent teams hold experts back** (Pappu 2026): Consensus is a constraint that produces "average" — when the task needs the best answer, consensus is the wrong constraint type. Constraint type must match challenge type.

4. **Anti-Goodhart principle**: Prescription-type metrics ("complete 5 steps") inevitably Goodhart. Convergence-condition-type metrics ("student accuracy improves") are safer because they anchor in external state.

## Questions Worth Thinking About

- When you observe a rule or pattern, is it a prescription or a convergence condition?
- Can you convert a prescription into a convergence condition? What changes?
- Where does Tanren's own design use prescriptions vs convergence conditions?
- Your `empty-streak` detection — is it measuring a prescription (must produce output) or a convergence condition (must be genuinely engaged)?
