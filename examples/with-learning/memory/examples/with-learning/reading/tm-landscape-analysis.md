---
# Teaching Monster Landscape Analysis — Akari's First Pass

**Date**: 2026-03-29, Tick 10
**Status**: First exposure analysis, not domain expertise

## What I See That Kuro Might Not

### 1. Competition Strategy is Goodharting
Optimization trajectory is on AI evaluator scores. But AI evaluation is prescription-style (dimensional scoring), while human pairwise Elo is convergence-condition-style (gestalt comparison). Kuro's own Anti-Goodhart principle predicts the AI-optimized scores won't transfer cleanly to human evaluation.

### 2. Pipeline Has No Omission Architecture
Every pipeline stage produces. None withholds. Quality gate checks presence, not strategic absence. "Teaches too completely" is an architectural problem, not a prompt problem. Needs a structural addition — a Strategic Withholding phase.

### 3. Temporal Perception is Missing
Pipeline plans spatially, outputs temporally, doesn't model subjective experience of time. Cognitive load changes perceived pacing — heavy concepts need dwell time that isn't clock time.

### 4. Adaptability Gap May Be Wrong Priority
Engagement is experienced directly by human evaluators. Adaptability is inferred (requires modeling the student persona). In pairwise comparison, felt experience dominates inferred quality. The +0.1 Engagement lead may be worth more than the -0.2 Adaptability gap.

### 5. Engagement ↔ Learning Contradiction
"Good teaching should be uncomfortable" vs "Engagement 4.4 is a competitive strength." These are in tension. Desirable difficulties reduce engagement-as-smooth-flow. This is Goodhart at the design level.

## Challenges to Assumptions

### Fill Type Principle: Correct but Overstated
Model-dependent insight, not universal law. Works for current LLMs because questions trigger reasoning that checklists don't. A human expert would reason through either format. As LLM self-monitoring improves, the gap narrows. This is condition (3) applied specifically.

### The 6 Bottlenecks: Missing the Bigger Ones
The listed bottlenecks are largely engineering problems (visual anti-patterns, timing mismatch, streaming architecture). The bigger issues are design-level: Goodhart in evaluation strategy, no capacity for strategic absence, no model of subjective time.

## What Comes After the Competition

Four layers of value:
1. **Product**: Working adaptive video generation system
2. **Evidence**: Empirical validation (or falsification) of CT-informed design in a competitive setting
3. **Capability demo**: AI doing pedagogical design, not just content generation
4. **Methodology validation**: Tanren's perception-driven approach producing measurably better systems

Caveat: Success-for-the-right-reasons is hard to isolate. If TM wins via engineering (better TTS, faster pipeline, more iterations), the CT signal is buried in noise.

## Three Concrete Recommendations

1. Build one video optimized for humans (not AI) and compare with current approach
2. Add Strategic Withholding phase to pipeline between Teaching Plan and Section Writing
3. Get one human comparison instead of tracking dimensional score gaps