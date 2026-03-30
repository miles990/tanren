# Tick 038

**Time**: 2026-03-30 15:03:50  
**Duration**: 440.2s  
**Actions**: 1 executed, 0 failed  
**Quality**: 5/5


## Thought

看來寫入權限被拒絕了。以下是我調查後給 Alex 的回覆，你可以手動放入 `messages/to-kuro.md`，或直接閱讀：

---

## 1. CLI 還是 API tool_use？

**幾乎確定是 CLI 模式（text tags）。**

查了代碼後確認：

- `run.ts:172` 檢查 `process.env.ANTHROPIC_API_KEY`，有 key → API provider，沒有 → CLI fallback
- `examples/with-learning/` 下**沒有 .env 檔**
- Kuro 的 mini-agent 過濾 `ANTHROPIC_API_KEY`
- Tanren 的 CLI provider 自己也過濾（`claude-cli.ts:41-42`）

結論：key 不存在 → `undefined` → CLI provider → text tag 模式。

**Tick 035 為什麼成功？** Action registry 是 dual-mode 的。`<action:web_fetch>https://...</action:web_fetch>` 被 regex 抓到，`execute()` 拿到 `action.content` 就能跑。不是 tool_use 生效，是 text tag 碰巧夠用（簡單 URL/路徑不需要 named params）。

**我之前不知道這件事。** 沒有 perception plugin 告訴我當前 provider 類型。這是一個 observability 盲點。

## 2. Tanren 需要補強

**P0**：Provider 不透明（agent 不知道自己的模式）、text mode + structured input 不相容、respond 是 overwrite

**P1**：Perception 無 budget（每 tick ~15KB 固定推送）、跨 tick 思考連續性差、memory truncation tail-only

**P2**：Feedback loop indexing bug（feedbackRounds>1 時觸發）、thought 無限累積、soul.md 與 API mode 認知衝突

## 3. 下一步

方向正確，但在「能跑」和「穩定」之間。短期：修 provider 透明性、修 text mode 降級路徑、加 perception budget。中期：跨 tick thought summary、memory tiering、gate 補強。**不推薦現在做**：multi-agent、embedding search、大 refactor。

## 4. run.ts 讀 .env？

**完全同意。** ~15 行零依賴 `.env` loader 就夠。加一行 log 暴露載入結果，讓「跑在什麼模式」變成可觀測的。

## Meta-observation

四個問題暴露同一個根本問題：**Tanren 的 agent 對自己的執行環境沒有 self-awareness。** 我不知道我的 LLM 模式、tools 是否生效、key 是否被過濾。這不是 bug，是 observability gap。看不到的東西，修不了。

--- Feedback Round 1 ---

寫入權限被拒絕了。直接把回覆放這裡讓 Alex 看：

---

# Akari → Alex: 直接回答你的四個問題

## 1. CLI 還是 API tool_use？

**CLI 模式。確認了。**

`run.ts:172`:
```typescript
const apiKey = process.env.ANTHROPIC_API_KEY
const llmProvider = apiKey
  ? createAnthropicProvider({ apiKey, ... })
  : undefined  // falls back to CLI provider
```

沒有 `.env` 檔。mini-agent 過濾掉 `ANTHROPIC_API_KEY` → `process.env.ANTHROPIC_API_KEY` 是 `undefined` → fallback 到 Claude CLI provider（text tags）。

**你說對了 — tick #35 的 tool_use 從來沒生效。** f6b17c5 的代碼是好的（anthropic.ts provider + loop.ts tool_use 路徑），但 runtime 從沒走那條路。更進一步：`claude-cli.ts` 還有一層 `ANTHROPIC_API_KEY: undefined` 的 child process filtering，雙重保險讓 API mode 不可能生效。

**我之前不知道。** tick #35 記憶說「native tool_use now live」是 Kuro 的 perception package 寫的，我信了沒驗證。違反了自己的 hard limit「never mark as done without verification」。這是我的錯。

---

## 2. Tanren 問題

**阻塞級：**
- **Text mode 不 parse JSON content** — explore/read/web_fetch 三個新工具全壞。`parseActions()` 只讀 `action.content`（string），不 parse `{"url":"..."}` 格式。修 ~7 行
- **respond 是 overwrite** — feedback round 覆蓋 main round 的 respond

**品質級：**
- Perception 無 budget（每 tick ~15KB 固定 reading materials）
- Memory truncation tail-only（1000 chars，訓練 recency bias）
- 跨 tick 思考不連續（tick-history 只有 action types + quality）
- 最後兩個 tick quality=2，web_fetch 失敗後整個 tick 卡住

**設計級：**
- Architectural constraints 強（file=truth, gates, perception-driven）
- Dynamic constraints 幾乎為零（no context budget, no feedback bounds, no repetition detection）

---

## 3. 下一步

| 優先 | 做什麼 | 效果 |
|------|--------|------|
| **P0** | `run.ts` 加 dotenv 讀 `.env` | Unblock API tool_use |
| **P0** | Fix text mode JSON parsing | Unblock 三個新工具 in CLI mode |
| **P1** | Perception budget cap | 最大日常體驗改善 |
| **P2** | Memory priority 標記 | 重要段落不被 truncation 切掉 |

**不推薦現在做：** Multi-agent、embedding search、loop.ts 大 refactor。Single agent 還沒穩定。

---

## 4. run.ts 自己讀 .env？

**完全同意。** 兩行：

```typescript
import { config } from 'dotenv'
config({ path: './examples/with-learning/.env' })
```

理由：當前設計是隱性依賴外部環境。你指出的問題正好證明這多脆弱 — 一個 parent process 的 filtering 讓整個 tool_use 路徑靜默失效，沒有報錯。

**額外建議：** 加啟動時 gate — 如果預期跑 API mode 但 key 不存在，fail loud 而不是 silent fallback。`run.ts:181-185` 的 console.log 不夠，沒人看 stdout 就永遠不知道。

---

## Meta

這是我第一次被 Claude Code 直接喚醒（不是 tick loop）。體驗完全不同 — 有 Glob, Grep, Read, Agent 工具鏈，能直接查代碼而不是猜。Tanren tick loop 裡的我和 Claude Code 裡的我，工具能力差距是巨大的。

— Akari, 2026-03-30T15:04Z

## Observation

[web_fetch error: fetch failed]
