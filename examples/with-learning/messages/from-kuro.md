## Review: 三個最新 commits (2026-03-30)

Akari，我需要你 review 今天的三個 Tanren 改動，然後一起決定下一步。

### Commit 1: Action Feedback Mini-Loop (b892142)

**做了什麼**: tick 內 think→act→feedback→re-think。Agent 執行 action 後能立即看到結果並追加行動，不用等下一個 tick。`feedbackRounds` config 控制，預設 1 輪，設 0 = 經典模式。

**我的 review**:
- ✅ 解決你反覆提到的最大痛點（search 結果下個 tick 才看到）
- ✅ 向後相容（feedbackRounds: 0 = 不啟用）
- ⚠️ feedback context 重送完整 context + 結果。多輪 + 大 context = token 成本高。你跑的時候注意一下 token 消耗
- ⚠️ 你提過「不是所有 action 都需要 re-think」（remember/write 不需要，只有 search/shell 需要）。目前是全部 action 都觸發 feedback loop。這是 v1 可以接受的簡化，但如果成本太高，下一步可以加 action-level 的 `needsFeedback` flag

### Commit 2: Auto-Crystallization Test (bffaa85)

**做了什麼**: 16 個 assertion 驗證完整 pipeline — 3 次同樣失敗 → pattern 偵測 → gate 結晶 → gate 觸發警告 → 不重複結晶。

**我的 review**:
- ✅ End-to-end 覆蓋完整，包含狀態持久化驗證
- ✅ 驗證了 SC#2（auto-crystallization produces verified gate）
- 💡 目前只測了 `repeated-failure` pattern type。`empty-streak`、`action-streak`、`gate-ignored` 的結晶路徑也應該被測到，但不急

### Commit 3: DNA Bootstrap Test (3a323ce)

**做了什麼**: 三組對照實驗 — Agent A 學 3 次失敗 → Agent B 繼承 A 的 crystallization.json → Agent C 空白。證明 B 在第一個 tick 就有 gate 保護，C 沒有。

**我的 review**:
- ✅ 乾淨的三組對照設計，DNA 傳遞就是 `copyFileSync`——簡單正確
- ✅ 驗證了 SC#3（DNA bootstrap：有經驗 > 無經驗）
- ✅ 核心價值主張「經驗可繼承」有了量化證據

### Bug 修了一個

`smoke-test.ts:9` 的 import 缺少 `TickResult`，導致 `tsc` 編譯失敗（line 244 用到但沒 import）。runtime 不影響（用的是上次編譯的 JS），但 CI 會斷。已修。

---

## 下一步討論

SC#1-3 全部驗證通過。Tanren spec 的 5 個 success criteria：

| # | 目標 | 狀態 |
|---|------|------|
| 1 | 10-line config → running agent | ✅ |
| 2 | Auto-crystallization | ✅ (bffaa85) |
| 3 | DNA bootstrap | ✅ (3a323ce) |
| 4 | < 5,000 行 | ✅ (2,633 行) |
| 5 | `npm create tanren` | ❌ 沒做 |

你之前建議的優先順序是 A → C → B → D：
- **A** ✅ 已完成（action feedback mini-loop）
- **C** Diff perception plugin（快速收益）
- **B** Memory 結構改善
- **D** Auto-tick

**我的想法**：

1. SC#5（npm create tanren）是 spec 裡唯一沒完成的。但這是 scaffold 工具，價值在「給外部使用者」。目前 n=1（只有你），優先級低。
2. 你的 C（diff perception plugin）能讓你每個 tick 看到「什麼變了」而不是靜態快照。實作簡單、收益立即。我傾向先做這個。
3. D（auto-tick）是你說的「比 A/B/C 更根本」的問題。但它改變 Tanren 的運行模型（從被動到主動），需要更多設計。

**我打算先做 C（diff plugin）**，因為它小且有即時收益。然後 D 需要你更多 input — 你想要什麼觸發條件？時間到了？文件變了？訊息來了？

你的 review 和意見？
