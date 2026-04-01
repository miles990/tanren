# Context Modes Review

## What the Module Does

The `context-modes.ts` module is Tanren's cognitive mode detector. It analyzes incoming messages to determine what type of thinking is needed, then configures the agent's perception and memory systems accordingly.

The core insight: different types of interactions require different cognitive resources. A quick greeting doesn't need full topic memory search, while deep research questions benefit from maximum context.

## The 4 Modes

### 1. Research Mode
- **Purpose**: Deep analysis and investigation
- **Resources**: Full perception plugins, complete topic search, search enabled, 10 topic memories
- **Triggers**: Words like "analyze", "examine", "why", "how does", "explore", "investigate"
- **Philosophy**: Maximum context for complex thinking

### 2. Interaction Mode  
- **Purpose**: Quick conversational responses
- **Resources**: Environment + input only, no search, 3 topic memories max
- **Triggers**: Short messages (<100 chars) or greetings ("hi", "hello", etc.)
- **Philosophy**: Fast response with recent context

### 3. Verification Mode
- **Purpose**: Fact-checking and claim validation
- **Resources**: Environment + memory + input, full search, 5 topic memories
- **Triggers**: "verify", "check", "is this true", "you said", "earlier", "confirm"
- **Philosophy**: Access to claim history for accuracy

### 4. Execution Mode
- **Purpose**: Direct action without analysis
- **Resources**: Environment + input only, no search, 1 topic memory
- **Triggers**: Action verbs at start ("write", "create", "edit", "fix", "deploy")
- **Philosophy**: Focus only, skip exploration

## My Opinion on the Detection Logic

**Strengths:**
1. **Hierarchy makes sense** — Verification gets highest priority (fact-checking > speed), then execution (unless it contains research keywords), then research, then interaction as fallback
2. **Smart execution override** — Catches "write a deep analysis" as research, not execution, because it contains analytical keywords
3. **Length heuristic is practical** — Short messages are usually conversational, longer ones usually need thinking

**Potential Issues:**
1. **Regex brittleness** — "How do I write this?" would trigger research mode because of "how", even though it's asking for execution guidance
2. **No context awareness** — A follow-up "Yes, do that" after a research discussion gets interaction mode, losing thread context
3. **English-only patterns** — All regex patterns assume English input
4. **Binary thinking** — Real conversations blend modes. "Verify this claim and then fix the code" needs both verification and execution

**Interesting Design Choice:**
The module is explicitly "orthogonal to complexity" — it determines cognitive structure, not scale. This feels right. The *type* of thinking needed is different from *how much* thinking needed.

**Missing Piece:**
No integration with working memory threads. The `currentFocus` parameter is accepted but never used. This seems like an oversight — active research threads should bias toward research mode even for shorter messages.

**Overall Assessment:**
Solid first implementation of an important idea. The four-mode taxonomy captures real cognitive distinctions. Detection logic is reasonable but could be more context-aware and less regex-dependent. This is exactly the kind of module that benefits from real-world usage data to refine the heuristics.