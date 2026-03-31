# omlx-4b-performance

- [2026-03-31] Performance issue: omlx 4B model burns 5 feedback rounds on read-only actions (read/explore/shell), never reaches edit/respond. In think-only mode, no tool calls = no feedback rounds triggered. Core problem: read-heavy exploration without decisive action.
