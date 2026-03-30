# Teaching Monster — Context for Analysis

## What Is Teaching Monster?

A competition hosted by NTU AI-CoRE: build an AI agent that receives a text learning request via API and **fully automatically** generates a teaching video. No human intervention allowed.

**Name origin**: Tribute to Assassination Classroom's "Koro-sensei" — a "monster" = transcendent, rule-breaking teacher.

## Competition Rules

### Timeline
- 3/1: Warm-up R1 (AI Student auto-scoring, non-binding)
- 4/1: Warm-up R2 (evaluator-designed scenarios)
- 5/1-5/15: Initial rounds
- 6/12-13: Finals (expert panel)

### Four Evaluation Dimensions
1. **Accuracy** — Zero hallucination. Every fact must be verifiable.
2. **Logic & Flow** — Scaffolding, narrative coherence across sections.
3. **Adaptability** — Identify student's ZPD, adjust content/vocabulary/examples to persona.
4. **Engagement** — Suspense, Socratic questions, summarization, visual-audio synchronization.

### Judging Mechanism (Two-Stage Initial Rounds)
- **Stage 1**: AI Student (LLM-based) auto-filters → top 10 teams advance. This is a GATE.
- **Stage 2**: Real human students do Arena-style pairwise comparison → Elo ranking → top 3 advance.
- **Finals**: Expert panel (high school teachers + university professors) with live questions.

**Strategic implication**: AI Student is a hard gate. If you don't pass AI filtering, human evaluators never see your work. Optimize for AI gate FIRST, then Arena experience.

### Technical Requirements
| Item | Spec |
|------|------|
| Format | MP4, ≥1280×720, ≥16kHz audio |
| Length | ≤30 minutes |
| Size | ≤3GB |
| Latency | 30 minutes (request → response) |
| Automation | 100% automated, no human intervention |
| Language | English |
| Curriculum | IB/AP level, ages 12-18 |
| Subjects | Physics, Biology, Computer Science, Mathematics |

### API Interface
Input: `{ request_id, course_requirement, student_persona }`
Output: `{ video_url, subtitle_url, supplementary_url[] }`

## Our System: Kuro-Teach

### Pipeline Architecture
```
HTTP Request (topic + student_persona)
  → Phase 1: Teaching Plan (Claude Sonnet) — curriculum design, student analysis
  → Phase 2: Section Writing (N parallel Sonnet calls) — per-section slides
  → Phase 3: Quality Review (Claude Haiku) — verification + retry
  → Slide Generation (HTML + KaTeX + drawsvg diagrams)
  → Audio Generation (Kokoro TTS, local, 24kHz)
  → Video Assembly (ffmpeg + Puppeteer)
  → HTTP Response

Total: ~815 seconds (13.6 minutes)
```

### Video Structure
- 26-36 slides per video, each = one teaching segment
- Per slide: narration (TTS), heading, math (KaTeX), visual (7 types), subtitle, choreography
- Visual types: figure, comparison, diagram, process, list, svg, none
- All elements choreographed with GSAP animations
- Kokoro TTS provides per-sentence timing synchronization

### Technologies
- **LLM**: Claude Sonnet (planning + writing), Claude Haiku (review, diagram specs)
- **TTS**: Kokoro 82M (local, 24kHz) — key advantage
- **Rendering**: drawsvg (Python), KaTeX (LaTeX formulas), GSAP (animations), Puppeteer
- **Video**: ffmpeg (encoding, concatenation, crossfade transitions)

## Multi-Phase Prompt Design (Core Innovation)

### Phase 1: Teaching Plan
The planner prompt asks the LLM to follow a **thinking cascade** — each decision constrains the next:

1. **Know Your Student** — Before designing anything:
   - What does this student need FIRST — concrete scenario or principle?
   - What pace? (determines slide count)
   - What's their world? (every example from THEIR interests)
   - What's the gap? (ZPD: what they know, what's the bridge, what they think they know that's wrong)

2. **Design the Arc** — Duration → Slide count from pace → Section structure → Core analogy → Opening → Bridges → Formula budget

3. **Planning Checks** — Before finalizing:
   - Does this topic move? (assign animation template)
   - Where does the student need to breathe? (consolidation moments)
   - Where are attention reset points? (narrative shifts)
   - Where are checkpoint moments? (≤90s without confirming understanding)
   - What will genuinely confuse THIS student? (anticipated questions)
   - Where should the student struggle productively?
   - Which new symbols need grounding?
   - Where are the difficulty jumps? (plan anxiety buffers)

### Key Design Decisions

**Convergence Conditions over Prescriptions**:
The prompts use convergence conditions (describe the end state) rather than prescriptions (specify the path):
- Instead of: "Add a question every 3 slides"
- We write: "Convergence condition: by the end of this section, the student can explain the core idea in their own words"

**Per-Section Persona Adaptation** (deterministic scaffolding fade):
```javascript
computePerSectionDensity(fadingSpeed, sectionId, totalSections)
// Returns: "HIGH" | "MEDIUM" | "LOW"
// gradual: 40% HIGH → 75% MEDIUM → LOW
// moderate: 30% HIGH → 60% MEDIUM → LOW
// rapid: 25% MEDIUM → LOW
```

Each section gets three persona dimensions injected:
1. **Misconceptions** — as convergence conditions ("student sees why X fails"), with pre-empt framing ("validate the wrong intuition FIRST, then redirect")
2. **Vocabulary ceiling** — "the hardest word they should encounter is X"
3. **Prior knowledge** — bridge anchors for this section's position

**Background Qualifier Override**:
"Working professional WITHOUT relevant background" = COMPLETE BEGINNER in domain. The word before "without" describes general capacity, not domain knowledge.

**Scaffolding Types** (matched to student):
- Struggling → PROCEDURAL (steps first, success first, explanation after)
- High-ability new domain → CONCEPTUAL (explain "why" framework)
- Low focus → METACOGNITIVE (frequent "notice that..." and "ask yourself..." prompts)

**Engagement Planning** — 6 questions the planner must answer:
1. Where will attention drift?
2. What makes this topic feel like a story?
3. What does the student think they know that's wrong?
4. Where can the student discover instead of being told?
5. Does every section have a reason to keep watching?
6. Does each section engage DIFFERENTLY? (assign unique technique per section)

### Phase 2: Section Writing
Each section is written independently (parallel), receiving:
- The teaching plan + persona guide + key facts + key data
- Section-specific persona focus (from `buildSectionPersonaFocus()`)
- Scaffolding density for this section position

### Phase 3: Quality Review
Haiku-level review checks:
- Math verification (formulas correct?)
- Logic chain validation (progressive disclosure?)
- Persona compliance (vocabulary ceiling respected?)
- Triggers re-attempts if issues found

### Safety Nets (Verification Layers)
- GroundCheck — facts against keyFacts list
- ArithCheck — arithmetic correctness
- ConsistencyCheck — cross-section consistency
- FormulaCheck — LaTeX validity

## Cognitive Science Foundation

### Core Frameworks Applied
1. **Cognitive Load Theory (Sweller)** — Working memory ~4 chunks. Reduce extraneous load, manage intrinsic, increase germane.
2. **Multimedia Learning (Mayer)** — Redundancy (voice ≠ screen text), Temporal Contiguity (sync audio-visual), Personalization (conversational tone, d=0.79), Coherence (no decoration).
3. **Desirable Difficulties (Bjork)** — Spacing, Interleaving, Testing Effect. "Feeling hard" in specific ways enhances long-term memory.
4. **Scaffolding & ZPD (Vygotsky/Wood 1976)** — Six functions: recruitment, reduction of degrees of freedom, direction maintenance, critical feature marking, frustration control, demonstration.
5. **Symbol Grounding** — Math symbols must be anchored to concrete referents before abstraction.

### Key Research Findings for TM
- **A1**: Math anxiety neurologically consumes working memory (amygdala overactivation + prefrontal-parietal network disruption).
- **A2**: High-anxiety students become dependent on AI rather than engaged — "too smooth" math can reinforce avoidance.
- **A3**: Symbol grounding must precede symbol manipulation. **⚠️ Our biggest blind spot** — formulas often "just appear" without grounding.
- **A4**: For struggling students, procedure-first may beat concept-first (show steps → explain why → redo).
- **B1**: 6-minute attention cliff is structurally worsening (short-form video training effect). Need novelty every 60-90s.
- **B2**: Optimal math video length: 5-8 minutes. Our average: 142.5s (~2.4 min) — segments, not full videos.
- **C1**: AI-generated video with LOW social presence = lower cognitive load = higher retention. No avatar is correct.
- **C2**: AI avatar gestures that don't align with speech emphasis actively harm learning.
- **D1**: Good AI design effect size d=0.73-1.3 (Kestin et al. Harvard 2025). The prize for getting it right is large.
- **D2**: Unscaffolded AI suppresses skill acquisition; hints-based scaffolding prevents this (Bastani et al. PNAS 2025).

### 14 Design Principles (Selected)
- Every math symbol: concrete grounding + spatial animation + real-world example
- Maintain productive struggle (never show complete solution immediately)
- Signaling (color, arrows) = attention management, not decoration
- 5-8 minute optimal length per segment
- No virtual avatar — low social presence is an advantage

## Current Competition Status (2026-03-29)

### Warm-up R2 Leaderboard
| # | Team | Score | Acc | Logic | Adapt | Engage | Progress |
|---|------|-------|-----|-------|-------|--------|----------|
| 1 | Team-67-005 | **4.8** | 5.0 | 5.0 | **4.8** | 4.4 | 30/32 |
| 2 | BlackShiba | **4.8** | 4.9 | 5.0 | **4.8** | 4.3 | 32/32 |
| 3 | tsunumon (阿宇) | **4.7** | 5.0 | 5.0 | 4.5 | 4.5 | 32/32 |
| **4** | **Kuro-Teach (us)** | **4.7** | **5.0** | **5.0** | **4.6** | **4.4** | **30/32** |
| 5 | Team 67 (alt) | 4.4 | 4.7 | 4.9 | 4.3 | 3.8 | 32/32 |
| 6 | SpeechLab (小金) | 3.6 | 3.9 | 4.3 | 3.3 | 2.9 | 32/32 |

### Our Position
- **Strengths**: Perfect accuracy (5.0) + logic (5.0), tied with #1
- **Weakness**: Adaptability (4.6) — 0.2 gap to #1/#2, the ONLY dimension separating us
- **Opportunity**: Complete 32/32 + improve adaptability +0.2 → could tie for #1

### Known Competitor Weaknesses (SpeechLab)
- Repetitive knowledge points
- Generic analogies (not domain-specific)
- No quality review layer
- Result: Adapt 3.3, Engage 2.9

## What I Want You to Analyze

You have the Constraint Texture and ISC frameworks. Apply them to:

1. **Prompt Design** — Which parts of our multi-phase prompt are prescriptions (specify path) vs convergence conditions (describe end state)? Are there prescriptions disguised as convergence conditions? Where does the prompt constrain the LLM in ways that might limit quality?

2. **Adaptability Gap** — We're 0.2 behind in adaptability. What might the AI Student evaluator be detecting (or not detecting) about persona adaptation? Our `buildSectionPersonaFocus()` function explicitly injects persona dimensions — is this the right approach, or does it create a different problem?

3. **Blind Spots** — As someone seeing this system for the first time: what questions would you ask that we might not be asking? What assumptions are embedded in the architecture that we might not see because we're too close?

4. **Interface Analysis** — The evaluator sees a finished video. The AI Student reads subtitles/text. How does the evaluation interface shape what "good" looks like? Are we optimizing for the right interface?
