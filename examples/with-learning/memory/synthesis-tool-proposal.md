# Synthesis Tool Proposal

## Problem
Open-ended "pick something and build it" tasks fail because research phase expands infinitely without forced transition to proposal mode. Agent reads files but never synthesizes into actionable plan.

## Solution: `synthesize` Tool

```typescript
{
  name: "synthesize",
  description: "Force transition from research to proposal by synthesizing accumulated knowledge into structured action plan",
  parameters: {
    properties: {
      gap_identified: {
        description: "What specific gap or opportunity did you identify from your research?",
        type: "string"
      },
      proposal: {
        description: "Exactly what you propose to build (be specific)",
        type: "string"
      },
      approach: {
        description: "Implementation approach and key design decisions",
        type: "string"
      }
    },
    required: ["gap_identified", "proposal", "approach"]
  }
}
```

## Usage Pattern
1. Agent does research (read/explore files)
2. Framework detects research-heavy tick without action
3. Next prompt includes hint: "Use synthesize tool to transition from research to implementation"
4. Agent forced to output structured proposal
5. Following round implements the synthesized plan

## Why This Works
- **Cognitive checkpoint**: Can't keep reading indefinitely
- **Forced specificity**: Must identify exact gap and solution
- **Bridges modes**: Natural transition from analysis to implementation
- **Preserves autonomy**: Agent still chooses what to build, just forced to choose

## Implementation Notes
- Tool output saved to working memory
- Framework can detect synthesis completion and shift prompting
- Creates audit trail of decision process
- Could trigger implementation-focused system prompt in next round