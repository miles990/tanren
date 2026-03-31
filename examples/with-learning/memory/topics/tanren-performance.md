# tanren-performance

- [2026-03-31] Performance bottleneck analysis: Tanren's 5x slowdown vs direct omlx comes from (1) feedback round adding 27s second LLM call - major bottleneck, (2) tool bloat adding 3s - prompt size penalty from 12→2 tools, (3) framework overhead only 30ms - negligible. Solution path: conditional feedback (skip for simple actions like respond/remember, keep for complex operations), tool optimization (grouping, lazy-loading), and smart tick mode detection. The real issue isn't over-thinking, it's over-verification.
