# Scaffolding Fade in Video Pipeline

Source: Kuro's research notes (2026-03-27)
Specific to Teaching Monster's 3-minute AI-generated teaching videos.

---

## The Video Constraint

Video cannot adapt in real-time. There is no feedback loop — the student watches passively. This means:
- Mechanical fade (remove supports step-by-step based on performance) is IMPOSSIBLE
- But cognitive fade (restructure understanding internally through narrative arc) IS possible

## What Video CAN Do

1. **Temporal fade**: Support decreases over the video's timeline
2. **Structural fade via progressive disclosure**: Information revealed in stages
3. **Voice shift**: From telling to asking — declarative → interrogative → conditional

## Three-Act Structure = Three Scaffold Levels

### Act 1 (Opening ~30%): Full Scaffold
- Complete worked example with all steps visible
- Prescriptive narration: "First we do X, then Y, because Z"
- Visual: full labels, annotations, step numbers
- Goal: establish the pattern, build confidence

### Act 2 (Middle ~40%): Partial Scaffold
- Skip a step, ask student to predict
- **Productive struggle window**: pause 2-3 seconds before revealing answer
- Narration shifts to questions: "What do you think happens next?"
- Visual: some labels removed, student must recall from Act 1
- Goal: transfer responsibility, test comprehension

### Act 3 (Closing ~30%): Convergence Condition Only
- State the principle without walking through steps
- Pose an unanswered question (NOT a summary)
- Narration is conditional: "If you understood X, you should be able to..."
- Visual: clean diagram, minimal annotation
- Goal: independence, motivation to explore further

## Five Implementation Recommendations

1. **Three-act = three scaffolding densities** (full → partial → minimal) — map directly to `computePerSectionDensity()` in TM
2. **Voice shift**: declarative → interrogative → conditional — each act has a different relationship with the student
3. **Visual annotation fade**: labels → reduced labels → clean diagram — the visual itself scaffolds less over time
4. **End with question, not summary** — questions drive self-testing (testing effect, Bjork), summaries allow passive processing
5. **Productive struggle window in Act 2**: 2-3 second pause before revealing answer — this is where learning happens

## Connection to TM Architecture

TM already has `computePerSectionDensity(fadingSpeed, sectionId, totalSections)` which returns HIGH/MEDIUM/LOW scaffolding density per section. This maps to the three-act structure:
- HIGH density sections = Act 1 behavior
- MEDIUM density sections = Act 2 behavior
- LOW density sections = Act 3 behavior

The implementation gap is that density currently controls AMOUNT of support but not TYPE of support. The scaffold should transform from prescription (Act 1) to convergence condition (Act 3), not just get thinner.
