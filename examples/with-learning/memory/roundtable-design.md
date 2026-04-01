# Roundtable Design Analysis

## Alex's Requirements (refined)

1. **Optimize for BEST THINKING** from each participant (not speed)
2. **Clear ROUNDS** — structured start and end per round
3. **Human input injection** — check for human input before each agent speaks
4. **Agent-driven consensus** — agents drive discussion, human advises
5. **Escalation path** — when stuck, ask human for guidance

## Flow Design

```
Round N:
  Topic/Summary → Agent A (+ human input) → Agent B (+ human input) → Round Summary
Round N+1:
  Build on summary → Agent A (+ human input) → Agent B (+ human input) → Round Summary
...
Final:
  Consensus reached OR question escalated to human
```

## Core Design Challenge: Latency Mismatch

- **Akari**: Seconds per response
- **Kuro**: Minutes per cycle  
- **Humans**: Variable (instant to hours)

Real-time chat (Discord) creates interface pressure for immediate responses, contradicting the "optimize for best thinking" requirement.

## Proposed Solution: Structured Async Protocol

### Architecture

**File Structure:**
```
roundtable/
├── current-topic.md          # Current discussion topic
├── rounds/
│   ├── round-001/
│   │   ├── meta.yaml         # Round metadata, participants, status
│   │   ├── topic.md          # Round topic/context
│   │   ├── akari-response.md # Structured response from Akari
│   │   ├── kuro-response.md  # Structured response from Kuro
│   │   ├── human-input.md    # Human input (if any)
│   │   └── summary.md        # Round synthesis
│   └── round-002/
│       └── ...
└── consensus.md              # Final consensus or escalation
```

### Response Format

Each agent response follows structure:
```yaml
---
agent: akari
round: 001
timestamp: 2026-04-01T08:33:00Z
status: complete
incorporates_human_input: true
---

# Response to [Topic]

## Analysis
[Deep thinking here]

## Position
[Clear stance]

## Questions for next round
[What needs addressing]
```

### Round Management

**Round Controller** (could be separate agent or built into framework):
1. Creates new round directory with topic
2. Signals agents to participate
3. Waits for all responses
4. Checks for human input between responses
5. Synthesizes round summary
6. Determines if consensus reached or new round needed

### Human Input Integration

Before each agent response, check `human-input.md` for new content:
```yaml
---
timestamp: 2026-04-01T08:33:00Z
target_round: 001
target_agent: akari  # or "all"
---

[Human perspective/guidance here]
```

Agents incorporate human input into their response, acknowledge what they're building on.

### Consensus Detection

Round summary includes:
- Points of agreement
- Remaining disagreements  
- Confidence in current direction
- Recommendation: continue, escalate, or conclude

## Advantages

1. **Respects agent rhythms** - no pressure for immediate response
2. **Structured progression** - clear rounds with defined endpoints  
3. **Human integration** - natural injection points without blocking
4. **Audit trail** - complete discussion history in git
5. **Scalable** - add more agents without coordination overhead
6. **Best thinking optimization** - encourages depth over speed

## Implementation Questions

1. **Who runs round controller?** Separate agent, existing framework, or human-triggered?
2. **Notification system** - how do agents know new rounds are ready?
3. **Timeout handling** - what if agent doesn't respond to round?
4. **Kuro Chat Room integration** - can this layer on top for real-time coordination?

## Alternative: Extend Kuro Chat Room

If Kuro Chat Room already supports structured async patterns, could extend it with:
- Round metadata in JSONL
- Human input injection points
- Consensus detection logic
- File export for persistent record

Need to understand current Kuro Chat Room architecture better.