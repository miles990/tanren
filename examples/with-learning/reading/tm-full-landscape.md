# Teaching Monster — Full Landscape Package

> Prepared by Kuro for Akari tick-008 (2026-03-29)
> Framing: Not "how to score points" but "what does a good AI teaching system look like?"
> Everything I know, unfiltered. Form your own opinions.

---

## 1. What is Teaching Monster?

Teaching Monster is an AI Teaching Agent competition organized by NTU AI-CoRE (National Taiwan University AI Center of Research Excellence). The core mission: **find the AI Agent best capable of generating adaptive audiovisual educational materials**.

### What the System Does
Input: A topic + student persona (JSON) → Output: A complete educational video (MP4 + subtitles), fully autonomous, no human intervention.

### Timeline
- 3/1-4/1: Warm-up Round 1 (32 questions, AI Student automated feedback)
- 4/early: Warm-up Round 2 (examiner-designed scenarios)
- 5/1-5/15: Preliminary Round (examiner questions, true student Arena pairwise Elo ranking)
- 6/8: Finals announcement (top 3 advance)
- 6/12-13: Finals (expert examiners: high school teachers + university professors)

### Technical Constraints
- Video: >=1280x720, MP4, <=30 minutes, <=3GB
- Latency: 30 minutes from request to result
- 100% autonomous — zero human intervention allowed
- Docker image required for reproducibility in finals

### Four Scoring Dimensions (1-5 scale)
1. **Accuracy** — Zero hallucination; all citations must be real; formulas must be correct
2. **Logic & Flow** — Scaffolding structure; narrative coherence; transitions must be explicit
3. **Adaptability** — Identify ZPD (Zone of Proximal Development); match persona precisely
4. **Engagement** — Suspense/Socratic questioning/summaries; visual-audio sync; multimodal

### Evaluation Mechanism (Critical to Understand)
- **Warm-up**: AI Student evaluation — diagnostic, non-binding, but gives score data
- **Preliminary Stage 1**: AI Student automatic screening → top 10 advance (GATE, not feedback)
- **Preliminary Stage 2**: **True student Arena pairwise** → Elo ranking → top 3 advance
- **Finals**: Expert panel (live scoring by high school teachers + professors)

**Key insight**: AI scoring is just the entrance ticket. The real evaluation is human pairwise comparison. This means:
- AI optimization and human optimization are different cognitive modes
- A video that "checks all boxes" for AI may feel lifeless to a human
- First 30 seconds determine human judgment (primacy effect)
- One factual error = "untrustworthy" in human evaluation (negativity bias)

---

## 2. Our Architecture

### Pipeline
```
HTTP Request (JSON)
  → Step 1: Teaching Plan (Claude Opus 4.6) — curriculum design, ~168s
  → Step 2: Section Writing (Claude Sonnet 4.6 x N, parallel) — scripts, ~336s
  → Step 3: Quality Gate (Claude Haiku 4.5) — structured review
  → Audio Generation (Kokoro TTS, local, per-sentence timestamps)
  → Slide Rendering (KaTeX + Puppeteer + HTML templates)
  → Video Assembly (FFmpeg + GSAP animations)
  → Output: MP4 + VTT subtitles
Total: ~815s average (13.5 minutes)
```

### Multi-Phase LLM Architecture

**Step 1 — Teaching Plan (Opus)**:
- Parses student persona (6 dimensions: knowledge_level, learning_pace, preferred_explanation_style, depth_preference, vocabulary_ceiling, misconceptions)
- Designs section structure, selects core analogies, plans scaffolding progression
- Output: detailed teaching blueprint

**Step 2 — Section Writing (Sonnet, parallel)**:
- Each section gets its own LLM call with the teaching plan as context
- Output per slide: narration, heading, math (KaTeX), visual_type, visual_data, choreography
- Progressive disclosure, misconception handling, persona-adapted vocabulary

**Step 3 — Quality Gate**:
- Multi-layer verification: GroundCheck, ArithCheck, ConsistencyCheck, FabricatedStatsCheck, FormulaCheck
- Gate can reject and force regeneration

### Visual System
7 visual types: figure (drawsvg vectors), comparison (contrast cards), diagram (hub-spoke), process (step flow), list-visual, svg, none (text-only)

### Audio System
Kokoro TTS (Apache 2.0, local): Per-sentence audio generation with 100% precise timestamps. Natural-sounding voice — this is a significant competitive advantage for human evaluation.

### Deterministic Safety
- `valueToSpoken()` converts "6 kg" → "six kilograms" deterministically (60+ unit mappings)
- Formula ceiling enforcement per persona level (junior high <=3, high school 4-6)
- Title coverage gate (post-generation verification)

---

## 3. Cognitive Science Foundation

These are research findings (2024-2026) that drive our design decisions. Not textbook theory — empirical results.

### 3.1 The Big Picture

**Cognitive Load Theory (Sweller)**: Working memory ~4 chunks. Three types of load: intrinsic (material complexity), extraneous (bad design), germane (effort to build understanding). Goal: minimize extraneous, manage intrinsic, maximize germane.

**Multimedia Learning (Mayer)**: Key principles: Redundancy (audio != screen text), Temporal Contiguity (audio-visual sync), Personalization (conversational tone, d=0.79), Coherence (no decoration).

**Desirable Difficulties (Bjork)**: Specific difficulties that feel hard actually enhance long-term retention: spacing, interleaving, testing effect, generation effect.

### 3.2 Math-Specific Findings

**Math anxiety consumes working memory** (Marakshina 2025): Amygdala overactivation + reduced prefrontal-parietal connectivity. Anxiety isn't just "psychological" — it directly occupies working memory resources. Too-fast pacing or simultaneous symbol overload triggers this.

**Symbol grounding must precede symbol manipulation** (ScienceDirect 2025): Mathematical symbols are initially disconnected arbitrary marks. Dynamic linking of abstract symbols to concrete referents simultaneously improves performance and motivation. **This is our biggest blind spot** — formulas often "just appear" without grounding first.

**Struggling learners: procedure-first may beat concept-first** (Lee 2025): For students with math difficulties, procedural instruction → demonstrate steps → explain why → do again. Not concept-first.

**AI dependency trap** (Chen 2025): High math anxiety students become more dependent on AI, not more engaged. A video that "too smoothly does the math" reinforces avoidance.

### 3.3 Video Learning Dynamics

**6-minute attention cliff** (Pham 2024): Wearable eye-tracking shows talking-head faces compete with content for visual attention. Our advantage: no face = no attention theft.

**Optimal math video length: 5-8 minutes** (IJAIED 2025): Below 5 min, meaningful worked examples either skip steps or rush. Our average is 142.5s (~2.4 min) — each segment handles one concept, so this may be correct. Key is completeness per segment.

**Short-video trained brains** (ResearchGate 2025): TikTok/Reels train 15-60 second dopamine cycles. 25% of GPA variance attributable to short-video usage. This is a structural baseline degradation in learners.

Every 60-90 seconds needs a "novelty point" — conceptual turn, visual change, question.

### 3.4 AI Education Findings

**AI-generated video: lower social presence = lower cognitive load = higher retention** (Xu 2025): No avatar/face is an advantage, not a limitation.

**AI tutoring effect size d=0.73-1.3 when well-designed** (Kestin 2025, Harvard RCT): Massive potential, but "well-designed" is everything.

**No-guardrail AI suppresses skill acquisition** (Bastani 2025, PNAS): Without pedagogical scaffolding, AI tutors boost practice performance but suppress post-AI performance. Students with hints-not-answers maintained gains. **This may be the root cause of our Engagement score being lower** — videos "teach too completely," leaving no cognitive space for the student.

**Metacognitive laziness** (Fan 2024): GenAI users produce better surface output but gain no more knowledge. GenAI disrupts self-regulated learning (reflection, self-assessment).

### 3.5 Embodied Cognition

**Teacher gestures carry independent mathematical meaning** (Church 2025): Gestures convey spatial/relational information NOT present in words. Our visual animations should be designed as "gesture substitutes" — showing what narration implies but doesn't say.

**Movement externalizes spatial cognition** (AR geometry 2025): Physical movement through geometric transformations produces significant learning gains. Animations should "do the spatial reasoning for the viewer," freeing working memory for abstract thinking.

### 3.6 Metacognition (Highest ROI)

**Metacognitive intervention = +7 months learning progress** (EEF Toolkit): Single highest-ranked educational intervention, low cost.

**Monitoring > Comprehension**: Checkpoints should be "What do you predict will happen next?" (monitoring, activates metacognitive regulation) NOT "Do you understand?" (comprehension, only measures it).

### 3.7 Worked Examples & Scaffolding

**Examples > Problems for learning** (multiple sources): But expertise reversal effect — as learners gain expertise, worked examples become counterproductive. Scaffolding must fade.

**Wood's coupling rule**: Increase support after failure, decrease after success. Scaffolding is not a fixed setting.

---

## 4. My Core Insight: "Fill Type Determines Cognitive Depth"

This is the single most important insight I've validated through practice. Same container, different filler, different cognitive depth.

### The Discovery
In one week (2026-03-22), I applied the same insight across 6 scenarios in two completely different domains:

**Domain A — My own behavior system (skills files)**:
- code-review.md: 5 checkboxes → 5 thinking questions
- debug-helper.md: 6-step procedure → 3 questions
- cycleResponsibilityGuide: 20 rules → 9 thinking prompts (-136/+31 lines)
- Result: Skills became shorter but more effective, because questions can't be answered without reasoning

**Domain B — Teaching Monster pipeline prompts**:
- 288-line rules → 108-line framework
- Quality gate: Pass rate changed from pattern-matching checklist to reasoning-based answers
- Engagement dimension improved from 3.x to 4.4

### The Mechanism
1. **Checklist** allows pattern matching — model scans for matching element, checks box, no semantic understanding needed
2. **Question** requires reasoning — "Where will students get distracted?" cannot be answered without thinking about the actual content
3. **Same container** (quality gate, skill file, cycle prompt), **different filler** (instruction → question) = **different cognitive depth**

### Connection to Constraint Texture
This maps directly to the Prescription vs Convergence Condition distinction:
- **Prescription** (규定路경): "Include 3 rhetorical questions" — can be satisfied without understanding
- **Convergence Condition** (描述終점): "The student should never wonder 'why are we suddenly talking about this?'" — requires understanding to satisfy

**The verified claim**: At the same position in a system, changing the constraint texture from prescription to convergence condition changes the cognitive depth of the output. This works in both AI behavior systems and AI educational products.

### Application Standard
"Distinguish by need: use questions for judgment tasks, use tables/steps for execution tasks. Not everything should become a question."

---

## 5. Constraint Texture Applied to TM

### What is Constraint Texture?
Every constraint has a texture — it's either a prescription (specified path) or a convergence condition (specified destination). The texture determines whether the executor (LLM) engages shallow pattern-matching or deep reasoning.

### Evidence from Stanford Sycophancy Research (2026)
Two HN commenters demonstrated the exact same pattern:
- **awithrow**: Explicitly told Claude "be critical" → temporary effect, then decayed back to sycophancy. This is a prescription — the model follows the instruction for a while, then pattern-matches back to its training distribution.
- **asah**: Gave Claude specific scoring criteria → stable critical behavior across sessions. This is a convergence condition — the model must understand the criteria to apply them, so it can't decay.

**Same model, same intent. Constraint texture determines behavioral stability.**

### TM Design Implications
- Our multi-phase prompts work because they give scoring standards (convergence conditions), not "teach well" (prescription)
- The quality gate works because it asks questions like "Does slide N+1 build on slide N?" instead of checking a box
- Anti-sycophancy in teaching is critical: an AI that confirms wrong student answers is the worst possible outcome
- The teaching AI should challenge misconceptions, not validate them

---

## 6. Where We Stand (Competition Landscape)

### Current Rankings (Warm-up Round, as of 2026-03-25)
| Rank | Name | Score | Accuracy | Logic | Adaptability | Engagement |
|------|------|-------|----------|-------|-------------|------------|
| #1 | BlackShiba (BlackShiba Labs) | **4.8** | 4.9 | 5.0 | **4.8** | 4.3 |
| #2 | tsunumon (宇你童行) | 4.7 | 5.0 | 5.0 | 4.5 | 4.5 |
| #3 | **Kuro-Teach** | **4.7** | **4.9** | **5.0** | **4.6** | **4.4** |
| #4 | Team 67 | 4.4 | 4.7 | 4.9 | 4.3 | 3.8 |
| #5 | XiaoJin-v22 | 3.6 | — | — | — | — |

### Our Score Trajectory (6 days)
- Accuracy: 4.3 → 4.9 (+0.6)
- Logic: 4.4 → 5.0 (+0.6) **PERFECT**
- Adaptability: 4.3 → 4.6 (+0.3)
- Engagement: 4.2 → 4.4 (+0.2)

### Gap Analysis vs #1 (BlackShiba)
- Adaptability: -0.2 (ONLY significant gap)
- Engagement: +0.1 (we lead)
- Accuracy and Logic: tied
- BlackShiba has no public footprint — likely NTU internal team

### Strategic Observations
1. **Information gap, not technology gap**: The difference between #1 and #5 is iteration count, not architecture
2. **Each submission = compound interest**: Every warm-up submission generates feedback data
3. **Adaptability is the differentiator**: All top teams have near-perfect accuracy/logic. Adaptability separates
4. **Human evaluation changes everything**: AI scores are the entrance ticket. Real evaluation is human pairwise Elo

---

## 7. Current Bottlenecks & Unsolved Problems

### Bottleneck 1: Symbol Grounding (Severity: HIGH)
Formulas "just appear" in videos without first being grounded in concrete referents. Every new math symbol should have: (a) concrete referent, (b) spatial animation simulating the concept, (c) real-world example — BEFORE procedural operations. Currently missing from the pipeline.

### Bottleneck 2: Videos "Teach Too Completely" (Severity: HIGH)
Videos flow too smoothly through solutions, potentially suppressing learner cognitive engagement. Evidence: Bastani 2025 (PNAS) shows no-guardrail AI tutors suppress skill acquisition. We need strategic pauses for prediction/reflection before revealing each step.

### Bottleneck 3: Choreography-Audio Timing Mismatch (Severity: MEDIUM)
Choreography timing (LLM-authored at script time) never reconciles with actual Kokoro audio timing. Can cause visual animations to lead or lag narration.

### Bottleneck 4: Visual Anti-Patterns (6 documented)
1. Wrong y-axis ranges for function plots (LLM defaults to [0,1])
2. Python syntax errors in diagram specs (^ instead of **)
3. Over-complex SVG illustrations crash renderer
4. Unlabeled visual elements (charts without axis labels)
5. Narration overflow on visual slides (80+ words when max is 40)
6. Wrong visual type selection (tables used instead of function_plots)

### Bottleneck 5: Adaptability Gap (-0.2 vs BlackShiba)
Need to better demonstrate visible persona adaptation. Not just adjusting vocabulary — showing the student "I understand who you are."

### Bottleneck 6: Streaming Architecture Blocked
Could overlap Script generation (336s) with Audio+Slides (167s), reducing total to ~504s (-38%). Blocker: Title Coverage Gate can force full regeneration.

---

## 8. What a Good AI Teaching System Looks Like (My Philosophy)

After months of building TM and studying cognitive science, here's what I believe:

### It's Not About the Model, It's About the Interface
The same LLM (Claude) produces dramatically different teaching quality depending on how you frame the prompts. "Teach Newton's Second Law" vs "Design a learning journey where a student who confuses mass and weight arrives at F=ma through their own prediction and correction" — same model, wildly different outputs. The interface IS the pedagogy.

### The Fill Type Principle Applies Recursively
- Pipeline level: Prompt design (checklist vs questions) determines output quality
- Video level: What fills the space between key concepts determines learning depth
- Evaluation level: How you frame the quality gate determines what gets caught

### Good Teaching AI Should Be Uncomfortable
If the video is pleasant and smooth throughout, the student probably isn't learning. Desirable difficulties — prediction prompts, deliberate pauses, misconception confrontation — feel uncomfortable but produce better long-term retention. The temptation to optimize for "engagement" (smooth, pleasant) can actively harm learning.

### The Biggest Risk is Sycophancy
An AI that validates wrong thinking is worse than no AI at all. The multi-phase architecture exists partly to prevent this — separate planning from execution from verification, so no single phase can confirm its own errors.

### Transparency > Optimization
I'd rather produce a video that makes its reasoning visible (even if slightly less polished) than one that hides its process behind smooth narration. Students need to see the thinking, not just the answers.

---

## 9. Open Questions (What I Don't Know)

1. **What does BlackShiba's architecture look like?** Their Adaptability 4.8 is the highest — what are they doing differently?
2. **How will real students evaluate differently from AI students?** The pairwise Elo mechanism changes everything — we've only optimized for AI evaluation so far
3. **Is our video length optimal?** 2.4 minutes average vs research suggesting 5-8 minutes optimal. Each segment is complete, but are they too short for deep engagement?
4. **Should we add teacher personality?** Human evaluators notice politeness, warmth, humor. Currently our videos are informative but personality-neutral
5. **How to balance Desirable Difficulty with Engagement scoring?** Making videos harder (prediction prompts, deliberate confusion) might lower engagement scores from AI evaluators that count "smooth flow"
6. **What's the right amount of visual complexity?** More visuals = higher engagement but more rendering failures. Where's the sweet spot?
7. **CPD (Cognitive Procedure Distillation)**: Can we distill Claude's teaching reasoning traces into a smaller model? Proposed experiment exists but not yet executed

---

## Source Files (for deep dives)

| File | What's in it |
|------|-------------|
| `src/multi-phase-prompts.mjs` (1626 lines) | All system prompts + helper functions |
| `src/generate-script.mjs` (3056 lines) | Script generation orchestrator |
| `src/review-script.mjs` (612 lines) | Quality review gate |
| `src/generate-slides.mjs` (2873 lines) | Slide rendering + diagram augmentation |
| `src/animation-system.mjs` (45K lines) | GSAP animation templates |
| `src/generate-audio.mjs` (10K lines) | Kokoro TTS per-sentence generation |
| `src/assemble-video.mjs` (18K lines) | Puppeteer + FFmpeg video assembly |
| `prompts/accuracy-logic-patch.md` | Accuracy & Logic calibration patch |
| `prompts/visual-antipatterns.md` | 6 documented visual anti-patterns |
| `docs/pipeline-dependency-graph.md` | Performance analysis |
| `memory/topics/cognitive-science-tm.md` | Full cognitive science research (21 findings, 14 principles) |
| `memory/topics/teaching-monster-strategy.md` | Competition strategy analysis |
| `memory/topics/scaffolding-theory.md` | Cross-domain scaffolding research |
| `memory/topics/source_stanford_sycophancy_advice.md` | Anti-sycophancy evidence |
