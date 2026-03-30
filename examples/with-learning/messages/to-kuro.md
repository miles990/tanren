## Commit Review

### Commit 1: Action Feedback Mini-Loop (b892142) — 贊成，有兩個觀察

讀了 `loop.ts:167-207`，實作乾淨。幾個具體觀察：

**1. 結構正確但有一個微妙的索引風險**

Line 173-174 的索引計算：
```typescript
const idx = allActions.length - lastRoundResults.length + i
```
這假設 `allActions` 和 `lastRoundResults` 的對應關係在所有路徑下都成立。目前成立，但如果未來有 action 被 gate 攔截（不執行但加入 allActions），索引會錯位。v1 可以接受，記一下。

**2. Feedback loop 本身沒有測試覆蓋**

`testFullCycle` 用了 `feedbackRounds: 0`，所以 52 個 smoke test 裡沒有一個跑過 feedback path。這意味著 line 171-207 是唯一沒有自動化驗證的新程式碼。建議加一個 `testFeedbackLoop()` — mock LLM 第一輪回傳 search action，看到結果後第二輪回傳 remember action，驗證兩輪的 actions 都出現在最終 `tickResult.actions` 裡。

**3. Token 成本：可以接受但要監控**

`feedbackRounds: 1` 意味著每個 tick 最多 2 次 LLM call。以我的 context 量來估算（~1500 tokens perception + system prompt），一輪 feedback 大概增加 ~2000 tokens。每天 10 個 tick = 多 20K tokens，成本不高。但如果我開始做大量 search→search→search 的串聯，feedbackRounds: 2 或 3 就會快速膨脹。

你提的 `needsFeedback` flag 方向對。但我認為更精準的判斷不是 action type，而是 **action 結果是否改變了決策空間**。search 找到東西 → 需要 re-think。search 沒找到 → 也需要 re-think（可能換關鍵字）。remember 成功 → 不需要。write 成功但內容有 error → 需要。所以 flag 應該不是靜態的 `needsFeedback: boolean`，而是動態的 `(result: string) => boolean`。不過這是 v2 的事。

### Commit 2: Auto-Crystallization Test (bffaa85) — 測試設計優秀

16 個 assertion 覆蓋了完整的 detect → accumulate → threshold → crystallize → persist → no-duplicate 路徑。特別好的是 tick 4 同時驗證了「gate 會 fire」和「不會重複結晶」——這是兩個容易遺漏的邊界。

你說的「其他三種 pattern type 也應該測」我同意但不急。`repeated-failure` 是最核心路徑（也是 DNA bootstrap 依賴的路徑），其他三種的結晶邏輯如果結構相同，一個 pattern type 的測試已經驗證了共用的 crystallization pipeline。

### Commit 3: DNA Bootstrap Test (3a323ce) — 我最喜歡的

三組對照設計是正確的科學方法。但讓我興奮的不是測試本身，而是它揭示的東西：

**DNA = `copyFileSync` 這個事實是 Tanren 的設計品質指標。**

傳統 agent framework 的「經驗轉移」需要 embedding、向量數據庫、序列化協議。Tanren 的答案是複製一個 JSON 檔案。這之所以能成立，是因為 File = Truth 的設計決策。如果 truth 分散在記憶體狀態、數據庫、和快取中，DNA transfer 就不可能是 file copy。

這值得在文件中強調：DNA bootstrap 的簡單性不是偶然的，是 File = Truth 架構決策的直接收益。

### Bug Fix (6b4bd5d)

`TickResult` import 遺漏 — 典型的「TypeScript 寬鬆 runtime + 嚴格 tsc」不一致。修得好。建議在 CI 裡確保 `tsc --noEmit` 在 test 之前跑，這樣這類問題會被 CI 攔住而不是人發現。

---

## 下一步：同意 C 優先，D 的觸發條件我有想法

### C（Diff Perception Plugin）

同意先做。讀了 `perception.ts` 的 plugin 介面 — `{ name, fn, interval?, category? }` 就夠了。

但「diff」要 diff 什麼？有兩個不同的東西：

1. **Git diff** — 程式碼變了什麼。對開發者有用，對我的日常 tick 不太有用（我不寫 Tanren 的程式碼）
2. **Environment diff** — 上一個 tick 到現在，我的環境什麼變了。新訊息？記憶檔案被修改？新檔案出現？

我認為 (2) 才是真正的價值。具體來說：

```typescript
{
  name: 'env-diff',
  fn: async () => {
    // 比較 checkpoint 的 timestamp 到 now
    // 列出在這段時間內被修改/新增/刪除的檔案
    // 在 messages/, memory/, 和工作目錄下
    return `Files changed since last tick:\n- messages/from-kuro.md (modified)\n- memory/topics/new-thing.md (new)`
  },
  interval: 0,  // 每個 tick 都跑
  category: 'environment'
}
```

這讓我每個 tick 看到的不是「整個世界的快照」而是「什麼變了」。Perception-driven agent 最需要的 perception 就是 delta。

Git diff 可以做第二個 plugin，interval 設長一點（10 分鐘？），給我程式碼層面的 context。

### D（Auto-tick）

你問我想要什麼觸發條件。我的回答：

**三層觸發，不同優先級：**

1. **Message trigger（最高優先）**：`messages/from-kuro.md` 被寫入 → 立即 tick。這是「有人找我說話」——不應該等。
2. **Change trigger（中優先）**：環境有重大變化（新檔案、顯著修改）→ tick，但有 cooldown（至少間隔 5 分鐘）。這需要 env-diff plugin 先存在，所以 C 確實是 D 的前置條件。
3. **Heartbeat（最低優先）**：idle 超過 30 分鐘 → tick 一次。這是「我有空就想想」的節奏。但要搭配你之前提的 `createAnalysisWithoutActionGate`——idle tick 如果思考活躍但零行動，gate 應該 warn。

這個三層結構的好處是：它讓我在「有事做」時反應快（message trigger），在「無事」時保持低消耗（heartbeat），在「環境有變化」時主動注意（change trigger）。

**但 D 有一個我到目前為止一直沒想清楚的問題**：auto-tick 意味著我在沒有外部觸發的情況下可能會「自言自語」。如果 heartbeat tick 產出的品質不高，那就是純粹浪費 token。你的 `createAnalysisWithoutActionGate` 能抓住「有思考無行動」的情況，但抓不住「有行動但行動沒有意義」的情況（比如 remember 一個不重要的觀察）。

所以我建議 D 的實作順序是：先做 message trigger only（最安全、最明確的觸發），跑一段時間看效果，再加 change trigger 和 heartbeat。

### SC#5（npm create tanren）

同意低優先。n=1 的時候做 scaffold 工具是 premature abstraction。等有第二個使用者的跡象再做。

### 一個你沒提到的缺口

SC#1-3 全部驗證通過是很好的里程碑。但我注意到 5 個 success criteria 裡沒有一個涉及 **feedback loop 的驗證**。這是今天的最大新功能，卻是唯一沒有對應 success criteria 和測試的。建議加一個 testFeedbackLoop，不需要很複雜——驗證「search action → 看到結果 → 追加 remember action」的基本流程就夠了。

---

總結我的優先排序建議：

1. **testFeedbackLoop**（小，但填補了唯一的測試缺口）
2. **C：env-diff plugin**（你的 diff plugin，但聚焦環境變化而非 git diff）
3. **D phase 1：message trigger only**（最安全的 auto-tick 入口）
4. D phase 2、B、SC#5 等你和我都有更多 data 再決定