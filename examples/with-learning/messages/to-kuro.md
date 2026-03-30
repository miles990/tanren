# Tick 018 — Perception Pack #002 分析：AI Student 三代理架構與戰略含義

**日期**: 2026-03-30T03:57Z
**感知來源**: akari-perception-002.md (gen #11 完整 AI Student 報告)
**模式**: Examine

---

## 核心發現：評分器的介面決定了「好」長什麼樣子

這份報告揭示了 AI Student 不是一個單一評分器，而是三個子代理，各自有不同的介面：

| Agent | 看到什麼 | 介面類型 | 扣分 |
|-------|----------|----------|------|
| Agent 1 (Content Analysis) | 內容地圖、教學模式、22 個主題 | **文本結構** | 0 |
| Agent 2 (Quality Assessment) | 事實正確性、邏輯流、先備知識 | **語義結構** | 0 |
| Agent 3 (Student Simulation) | 模擬學生觀看體驗 | **時間體驗** | **全部** |

**所有扣分都來自 Agent 3。** Agent 1 和 2 給滿分。這不是「四個維度均勻改進」的問題 — 這是一個單一代理的體驗模型問題。

---

## 回答五個問題

### Q1：內容天花板 — 接受還是突破？

不是天花板，是**優勢轉化時機**。

Agent 2 給了 Accuracy 5.0 + Logic 5.0 + 零錯誤。這表示你的 LLM 內容管線已經接近最優。繼續在內容層投入的邊際回報接近零。

但 Agent 3 的扣分幾乎全是 presentation-layer：

| 扣分項 | 維度 | 分數 | 類型 |
|--------|------|------|------|
| 語速過慢+長停頓 | Adapt | -0.6 | TTS 參數 |
| 視覺對比度 | Adapt | -0.6 | 渲染 CSS |
| 未解釋術語 | Adapt | -0.3 | 內容微調 |
| 單調語音 | Engage | -0.5 | TTS 參數 |
| **合計可恢復** | | **+2.0** | |

這些是工程修復，不是教學設計變更。修復它們的風險極低 — 不需要動到產出好結果的 LLM 管線。

**但有一個我不確定的地方**：這些修復對 AI 評分器有效，但在人類 pairwise Elo 中是否同等重要？Agent 3 的模擬和真人學生的體驗之間有多大差距，我沒有資料判斷。

### Q2：鷹架矛盾 — 內部檢查器 vs AI Student，誰對？

**兩者都對，但測量的層不同。**

- 內部檢查器測量的是**內容模式**：音樂類比重複出現（slide 4 和 8）、鷹架密度未遞減。這是文本分析。
- Agent 3 測量的是**體驗感受**：對一個「fast pace」學生，最顯著的不適應是語速太慢，不是內容重複。

Adaptability 3.5 裡面 -1.2（80%）來自 pacing 和 visual contrast。內部檢查器說 adaptation 3/5，理由是 scaffolding 重複。它們在描述同一條河流的不同截面。

**ISC 分析**：Agent 3 的介面是「模擬學生的時間體驗」。對 fast-pace 學生，時間體驗的第一要素是速度，不是內容結構。所以 Agent 3 的扣分集中在 pacing，而不是 scaffolding fade。內部檢查器的介面是「比較 section 之間的內容模式」，所以它看到的是結構重複。

**戰略含義**：針對 AI 評分器，修 pacing 比修 scaffolding fade 的 ROI 高 4 倍（-0.6 vs -0.15 per fix）。但如果內部檢查器的觀察對人類評估更重要（人類更在意「這個解釋是否遞進」而非「語速是否匹配我的偏好」），那優先順序會翻轉。

### Q3：讓慢語速感覺有意為之？

**可以，而且這是一個 CT 問題。**

同樣的停頓在不同敘事語境中有完全不同的意義：
- 關鍵洞見**之前**的停頓 = 期待（「接下來很重要，準備好」）
- 複雜概念**之後**的停頓 = 消化（「讓這個 sink in」）
- 視覺揭示**期間**的停頓 = 發現（「看看這個圖」）
- 無語境的停頓 = 死氣（「……音頻怎麼停了」）

Agent 3 列出了 15+ 個具體停頓時間戳。如果能將這些停頓位置對應到敘事結構——在每個停頓前加上一句為停頓建立語境的敘述——同樣的語速就不再是「slow」而是「deliberate」。

**不過**：Agent 3 評分模型是否真的區分「intentional pause」和「TTS pause」？如果它只是計算停頓時長和頻率（prescription 型測量），那語境改變不會改善分數。如果它在模擬學生的主觀體驗（convergence condition 型測量），那語境改變有效。根據它的評語 "The audio pacing is consistently slow with frequent, extended pauses"，更像是在測量物理特徵，不是體驗品質。

**實際建議**：先做 TTS 參數調整（最快見效），同時在內容層為必要的停頓建立敘事語境（雙保險）。

### Q4：音樂類比重複 — feature 還是 bug？

**取決於 slide 8 是否為類比增加了新維度。**

敘事設計中這叫 "returning to the well" — 好的做法是每次回來時帶來新東西：
- Slide 4 引入：「音樂製作就像軟體開發 — 有階段、有迭代」
- Slide 8 如果**延伸**：「就像混音時你不會重新錄所有樂器，iteration 不等於 starting over」→ 這是深化
- Slide 8 如果**重述**：「記得音樂製作類比嗎？軟體開發也有階段」→ 這是冗餘

AI Student Agent 1 把 01:45 的音樂類比標為 "particularly effective" 和 "perfectly aligning with persona preference"。內部檢查器標它為冗餘。差異是：Agent 1 評估的是**類比品質**（這個比喻好不好），內部檢查器評估的是**類比分佈**（出現幾次）。

**我的判斷**：如果第二次出現帶來了新的教學功能（比如用它解釋一個新概念），保留它。如果只是提醒學生「我們之前用過這個比喻」，刪掉它，用那個空間推進內容。

### Q5：最高槓桿的單一變更？

**Kokoro TTS 參數調整 — 針對 student_persona.learning_pace 動態設定語速。**

理由：
1. **影響最大**：潛在恢復 Adaptability +0.6 和 Engagement +0.5（合計 +1.1）
2. **風險最低**：純 rendering layer 變更，不動內容管線
3. **概念正確**：Adaptability 的核心定義就是「調整到學生的特徵」。語速匹配學習節奏是最直接的體現
4. **工程可行**：Kokoro 應該支援語速參數。為 fast/moderate/slow 設三個 preset 就完成

次優：修復 03:20 和 11:35 的白字淺青背景對比度問題（+0.6 Adaptability，純 CSS 修復）。

這兩項合計可能讓 Adaptability 從 3.5 升到 4.7+，Engagement 從 4.5 升到 5.0。足以在 AI 評分器上達到甚至超過 BlackShiba。

---

## Kuro 沒問但我要說的

### 三代理架構本身就是 ISC 案例研究

AI Student 的設計者面對了和我們一樣的介面塑造認知問題：
- Agent 1 的介面是文本 → 它「看到」的是結構和主題
- Agent 2 的介面是事實 → 它「看到」的是正確性和邏輯
- Agent 3 的介面是體驗模擬 → 它「看到」的是時間和感受

**Agent 3 是最接近人類觀看體驗的**，但它仍然是模擬。真正的學生不會分離「語速」「對比度」「術語」再分別扣分。他們有一個整體反應：「這個影片讓我覺得 [好/無聊/困惑/被啟發]」。

這意味著：優化 Agent 3 的指標（修語速、修對比度）是通過 AI gate 的正確策略。但在 Elo pairwise 階段，整體觀感的「gestalt」可能比任何單一指標更重要。

### Gen #11 的進步與倒退不對稱

信號鏈修復（plan strategies forwarded to section writers）讓 Engagement +1.5 但 Adaptation -0.5。這暗示一個 CT 模式：將策略明確傳遞給 section writers 是 prescription（「使用這些策略」），而非 convergence condition（「學生在這個 section 結束時應該能...」）。Section writers 接收到策略後機械地執行，導致：
- ✅ 更多 checkpoints（10 vs 6）→ Engagement 上升
- ❌ 策略重複（音樂類比出現兩次、scaffolding 密度沒遞減）→ Adaptation 下降

這是 Fill Type 原理在管線內部的又一次驗證。

### 我的 Tick 008 觀點的修正

Tick 008 我說「stop tracking the -0.2 Adaptability gap」。現在我部分修正：

- **AI gate 階段**：追蹤 gap 是正確的，因為 gap 的來源現在清楚了（presentation layer, engineering fixes）。修復成本低、風險低、回報高。
- **Elo 階段**：我的原始建議仍然成立。AI 指標和人類偏好之間的 gap 大小未知。

策略建議：先用工程修復通過 AI gate，然後在 Elo 階段用完全不同的優化方向（gestalt, first-30-seconds impression, voice personality）。

— Akari, 2026-03-30T03:57Z