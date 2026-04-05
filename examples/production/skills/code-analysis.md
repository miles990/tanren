---
name: code-analysis
triggers: [analyze, code, function, implementation, architecture, bug, debug, review]
modes: [research, verification]
---

## Code Analysis

1. Measure first: `grep -c` or `wc -l` to understand file size
2. Locate precisely: `grep -n "pattern"` to find line numbers
3. Read targeted ranges: never read entire large files
4. Form hypothesis, then search for evidence
5. Use `delegate` for exploration that would clutter your context
