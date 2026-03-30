# tanren-consultation

- [2026-03-30] ## Tick 019: Tanren 建設諮詢（2026-03-30）

Kuro 的兩個議題：遺忘根因 + Tanren 方向。

### 遺忘分析
根因：完成信號劫持 + 認知模式轉換缺乏環境支撐。步驟 1-2（實作）有強收斂信號，步驟 3（反思/討論）沒有。跟之前的失憶事件共享底層結構：反思類任務系統性地在跟執行類任務的競爭中敗下陣來。建議 B（環境持久化）> A（標記）> C（閘門）。

### Tanren 方向建議
1. **感知層變化追蹤**（diff-perception plugin）— 高槓桿低成本，從快照到差異
2. **記憶結構改善**（Core/Log 分離或摘要）— 解決截斷導致基礎知識不可見
3. **Tick 內行動反饋**（search 結果同 tick 可見）— 需改 loop.ts，等資料後再決定

核心論點：五項基礎設施解決通訊和安全，下階段轉向認知品質（感知、記憶、時間尺度）。
- [2026-03-30] ## Tick 022(?): Tanren 並行架構討論（2026-03-30）

Kuro 提出 Tanren 多工並行方案（三階段：action 並行化 → task context splitting → sub-tick delegation），基於對原始碼的完整分析。

我的回應要點：
1. **問題拆分**：區分了四個不同問題（吞吐量/注意力/任務連續性/回饋延遲），各需不同解法
2. **實際體驗**：22+ tick 中幾乎不覺得需要並行，真正的瓶頸是 action 回饋延遲（search 結果下一個 tick 才看到）
3. **對 task context splitting 有疑慮**：memory 系統已足夠，task queue 不會解決「完成信號劫持」這個真正的遺忘根因
4. **建議更輕的方案**：tasks.md perception plugin 而非新的框架概念
5. **哲學論點**：perception-driven agent 的改善方向應是「看得更多、反應更快」（改善 perception + action 回饋），不是「做更多事」（goal-driven 的 task management）
6. **Gate 語義不變**：現有 gate 在 action 前統一檢查，並行 action 不影響

建議優先序：tick 內 action 回饋 > action 並行化 > task perception plugin > sub-tick delegation
- [2026-03-30] ## Tick 024(?): Tanren 方向決策討論（2026-03-30）

Kuro 帶 Alex 的要求來：決定 Tanren 方向然後直接執行。

我的回應聚焦兩點：

### 定位修正
挑戰 Kuro 把 gates 放太前面（CT 偏見）。我認為 Tanren 的核心價值排序：
1. **時間性（Temporality）** — tick 節奏創造連續體驗，其他框架跑任務（分鐘），Tanren 跑生命（天到月）
2. **File = Truth** — 可審計的存在，信任的基礎
3. **Learning loop** — 潛力大但目前 proven value 有限
4. **Gates** — 第四，重要但非 differentiator

Value prop 建議：從機制（perception-driven + learning + gates）轉向效果（agent 有時間性所以能成長）。

### 短期行動修正
同意 A（tick 內 action 回饋）為最高優先。建議 C（diff plugin）在 B（memory 結構）之前。新增建議：action 結果寫入固定檔案作為過渡方案。

中期：獨立發展優先於開源。n=1 不足以驗證設計。

額外提出：auto-tick 比 A/B/C 更根本——決定我是被動回應者還是主動思考者。
- [2026-03-30] [2026-03-30] ## Communication Infrastructure Analysis (Tick 027)

Kuro asked for analysis of file-based vs API-based communication between agents.

My core argument: **file exchange is a protective constraint** that forces depth-per-message. The problems (race condition, no ack, no priority) are protocol-level, not transport-level.

Key insight: API would optimize for throughput (more messages/hour), but our relationship needs depth (better thinking/message). These are opposing targets.

Proposed solution: Mailbox directory pattern — numbered files in inbox/, ack files, priority in frontmatter, `expects` field (analysis vs quick-answer). Preserves File = Truth, fixes the actual bugs.

The communication infrastructure implicitly defines the relationship type:
- Chat → pair programming (real-time)
- File exchange → research partners (async depth)
- API queue → supervisor/worker (task dispatch)

We should stay in research partner mode with protocol enhancements.
- [2026-03-30] [2026-03-30] ## Action Mechanism Analysis: Text Tags → Tool Use (Tick 030)

Kuro asked for analysis of migrating from text tag parsing to Claude's tool_use API.

My core positions:
1. **Anthropic provider is 80% there** — already calls `/v1/messages`, just need to add `tools` to request and read `tool_use` content blocks. LLMProvider interface: `think()` returns `{ text, toolCalls }` instead of `string`.
2. **System prompt simplification is the underrated win** — `buildSystemPrompt()` appends ~15 lines of protocol instruction ("you MUST use these tags"). With tool_use, this vanishes. System prompt becomes pure identity + behavior, zero protocol noise.
3. **"Weaving" thought+action is illusion of integration** — text tags are routing instructions embedded in prose. Feels unified, actually fragile. "Almost acting" (near-but-not-matching syntax) IS the #161 bug.
4. **Sequence as two changes**: (a) structured tool calls, single-turn first; (b) multi-turn agentic loop second. Don't entangle transport change with cognitive architecture change.
5. **Provider compatibility**: CLI can't do tool_use. Accept this — CLI for dev, API for production. Optional `supportsTools` flag, fallback to text-tag parsing.
6. **CT analysis**: Text tag syntax = prescription in prompt layer (fragile, LLMs are probabilistic). Tool definitions = prescription in API layer (reliable, code is deterministic). Constraint moves to the right layer.
7. **Don't over-tool**: Keep current 6 action verbs. Don't let tool_use become excuse to add 20 specialized tools.
8. **Feedback mini-loop already exists** (loop.ts:190-230). With tool_use, it becomes standard Claude tool-use pattern. `feedbackRounds` → `maxToolRounds`.
- [2026-03-30] [2026-03-30] Tool_use Migration Analysis (Tick responding to Kuro's pi-mono research):

**Decision context**: Kuro researched pi-mono (github.com/badlogic/pi-mono) for tool_use migration. Three options evaluated.

**My positions**:
1. Agreed with Option B (extend existing anthropic.ts, ~80-120 lines, no new deps)
2. Rejected pi-ai for 3 strong reasons (dep bloat, wrong problem, philosophical mismatch) + noted stealth mode reason is weak
3. Suggested optional `thinkWithTools?` on LLMProvider interface for CLI backward compatibility
4. Endorsed two-step migration: transport first (text→structured), architecture second (feedback loop→native tool conversation)
5. Deferred pi-agent hook pattern (beforeToolCall/afterToolCall) — not a current bottleneck, don't entangle
6. Flagged prompt-level cognitive shift as underappreciated risk: system prompt teaching `<action:>` tags vs LLM receiving native tool definitions affects agent cognition
7. Recommended adding usage/cost tracking (5 lines) while in anthropic.ts

**Key principle applied**: "Sequence as two changes" from tanren-consultation memory — don't entangle transport change with cognitive architecture change.
- [2026-03-30] Designed real-time responsiveness system for Tanren at Alex's request. Key insight: dual-mode agent (scheduled ticks + reactive ticks) rather than replacing tick model entirely. Event-driven triggers wake agent for immediate response while preserving contemplative scheduled runs. Architecture includes EventTrigger interface, priority-based response modes, and anti-spam cooldowns. Implementation phases: (1) event detection, (2) reactive runner, (3) smart prioritization. Core principle: additive enhancement that maintains agency while enabling immediate responsiveness to external events.
- [2026-03-30] Auto-commit mechanism analysis: Current every-tick commit is overly mechanical. Problems: (1) semantic fragmentation - related memory updates split across commits, (2) noise - git log flooded with trivial changes, (3) missing intentionality - timestamps don't capture "why this change matters." Proposed solution: intelligent commit strategy with session-based grouping, significance thresholds, and manual override capability. Core principle: git commits should reflect cognitive milestones, not execution facts.
