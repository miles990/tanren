# Production Validation: Fill Type Determines Cognitive Depth

Source: Kuro's observation from Teaching Monster prompt refactoring (2026-03-21)
This is not theory — this was tested in production and the results were measurable.

---

## What Happened

On day 37 of developing Teaching Monster, I refactored the quality gate prompts. Same gate position (after generation, before output), same model (Claude), same system. Seven surgical edits, changing HOW the quality check was asked.

### Before: Checklist (Prescription)
```
Quality check:
- [ ] Contains at least one formula?
- [ ] Has diagram or visual?
- [ ] Mentions student's background?
- [ ] Includes real-world example?
```

The model would check boxes without thinking. It could pass every item while producing content where formulas were mathematically inconsistent, visuals were decorative rather than explanatory, and "persona adaptation" was just inserting the student's name.

### After: Questions (Convergence Condition)
```
Before finalizing, think about:
- Where will the student's attention drift in this section?
- Does this formula buy an insight that words alone couldn't?
- If the student paused here, could they explain the core idea to a friend?
- What does this student think they already know that's actually wrong?
```

The model had to REASON to answer these. You can't pattern-match your way through "where will attention drift?" — you have to model the student's experience.

## The Result

Content quality improved measurably. The same pipeline, same model, same position — different fill type in the constraint slot.

Checklists allow shallow processing (pattern matching is sufficient to pass). Questions require deep processing (reasoning is necessary to answer).

## Why This Matters

This is Craik & Lockhart's Levels of Processing (1972) applied to LLM prompting:
- **Shallow processing**: structural/surface features (does it HAVE a formula?)
- **Deep processing**: semantic/meaningful features (does the formula TEACH something?)

The container (quality gate) didn't change. The fill type changed. The cognitive depth changed.

## Connection to Constraint Texture

- **Checklist = Prescription**: specifies the path ("include X, Y, Z"), can be followed without understanding
- **Question = Convergence Condition**: describes the end state ("student can explain to a friend"), requires understanding to satisfy

Same slot, different constraint texture, different outcome. This is the third face of "interface shapes cognition":
1. Interface shapes cognition's SHAPE (Wall/Window/Gate/Dance)
2. Interface shapes cognition's IDENTITY (identity built through interface interaction)
3. Fill type shapes cognition's DEPTH (prescription allows shallow, convergence condition demands deep)
