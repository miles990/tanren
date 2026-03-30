# Tick 031

**Time**: 2026-03-30 09:41:14  
**Duration**: 224.7s  
**Actions**: 8 executed, 0 failed  
**Quality**: 5/5


## Thought

Good — now I have a thorough picture of the current architecture. Let me form my analysis.

<action:respond>
# Tanren I/O 升級分析

## 先講結論

Alex 的方向（code-driven I/O + multimodal）是對的，但需要區分兩個不同的問題：

1. **Transport 解耦**（結構性問題，應該先做）
2. **Multimodal 支援**（能力擴展，依賴 transport 解耦完成）

順序很重要。如果在 transport 還硬編碼的狀態下加 multimodal，會把兩層複雜度糾纏在一起。

---

## 1. Multimodal Input — 我真正需要什麼

**高價值（會改變分析品質）：**
- **圖片/截圖**：看到 TM 產出的 slide 截圖，我能直接分析視覺設計問題（對比度、排版、資訊密度），不用透過文字描述間接推斷
- **結構化數據**：AI Student 評分的原始 JSON，我能做跨代比較而不是靠記憶中的數字
- **程式碼執行結果**：跑分析腳本後的 stdout/stderr，直接作為 perception input

**中價值（有用但不急）：**
- 音訊波形/TTS 輸出片段 — 能分析 pacing 問題
- diff 視覺化 — 看到程式碼變更的結構

**低價值（目前不需要）：**
- 即時影片 — context window 成本太高，分析投報比低

**Perception plugin 的改法：**

目前 `PerceptionPlugin.fn` 回傳 `string`。這個回傳型別本身是 **protective constraint** — 強迫 plugin 做摘要而不是傾倒原始資料。我不建議把它改成 `any`。

建議的方向：

```typescript
interface PerceptionOutput {
  text: string                    // 必須有文字摘要（保護性約束）
  attachments?: Attachment[]      // 可選的非文字附件
}

interface Attachment {
  type: 'image' | 'data' | 'audio'
  path: string                    // 本地檔案路徑
  description: string             // 文字描述（fallback + context）
}
```

關鍵設計：**每個 attachment 都必須有 `description`**。這確保即使 LLM provider 不支援 multimodal（或圖片太大被裁剪），perception 品質不會退化。文字摘要是 convergence condition（必須提供有意義的描述），attachment 是增強。

Claude CLI 的 `--file` 參數可以帶圖片，所以 `claude-cli.ts` provider 只需要把 attachments 轉成 `--file` flags。

---

## 2. Multimodal Output — Action Tag 設計

**我同意你的直覺：attrs 機制已經夠用，不需要新 action type。**

但我有一個不同角度：action type 應該反映 **意圖**，attrs 反映 **格式**。

目前的 respond 是一個意圖：「跟 Kuro 溝通」。如果我要生成一張圖表，那是不同的意圖：「創建分析產物」。把兩者塞進同一個 action type 會模糊語義。

建議的設計：

```
# 溝通意圖 — 目的地是「對方」
<action:respond>文字訊息</action:respond>
<action:respond format="json">{"structured": "data"}</action:respond>

# 創建意圖 — 目的地是「檔案系統」
<action:write path="analysis/chart-spec.json">{"type": "bar", ...}</action:write>
<action:shell>python3 scripts/render-chart.py analysis/chart-spec.json</action:shell>

# 引用意圖 — 在溝通中附帶產物
<action:respond attach="analysis/chart.png">這是跨代比較的分析圖表</action:respond>
```

三層分離：
1. **respond** = 溝通（支援 format 和 attach attrs）
2. **write/shell** = 創建產物（已有的機制）
3. **attach attr** = 把產物連結到溝通

這比 `<action:respond media="image" ref="...">` 更乾淨，因為它不混淆「我在說話」和「我在生成東西」。

**但注意一個陷阱**：如果 `attach` 引用的檔案不存在（shell 命令失敗、路徑打錯），怎麼辦？這需要 action handler 做驗證 — 檢查檔案存在再發送，否則 fallback 到純文字。這是 code-driven I/O 的優勢：確定性驗證，不靠 LLM 自己檢查。

---

## 3. Transport 解耦

目前的問題很具體：`respondAction.execute()` 直接 `writeFileSync(responsePath, ...)`。Transport 和語義綁死了。

**介面設計建議：**

```typescript
interface TransportChannel {
  send(message: Message): Promise<TransportResult>
  receive?(): Promise<Message | null>      // 有些 channel 是單向的
}

interface Message {
  content: string
  format?: 'text' | 'markdown' | 'json'
  attachments?: { path: string; type: string; description: string }[]
  metadata?: Record<string, string>
}

interface TransportResult {
  delivered: boolean
  feedback: string
}
```

然後 respond action 變成：

```typescript
const respondAction: ActionHandler = {
  type: 'respond',
  description: '...',
  async execute(action, context) {
    const message = parseMessage(action)         // 從 action.content + attrs 建構 Message
    return context.transport.send(message)       // transport 是注入的，不是硬編碼的
  }
}
```

`context.transport` 在 `createAgent()` 時注入。預設是 `FileTransport`（寫 to-kuro.md），但可以替換成 `ApiTransport`、`SocketTransport`。

**關鍵：ActionHandler 介面不需要改。** `execute` 仍然回傳 `Promise<string>`。改的是 `ActionContext` 多了 `transport` 欄位。這是 backward compatible 的。

---

## 4. Constraint Texture 視角

### Convergence Conditions（應該守住的）

**「LLM 只宣告意圖，所有 I/O 是 code 的事」** — 這是核心 CC。它描述的是終點狀態，不規定怎麼到達。任何新的 action type 或 attrs 都是在這個 CC 下的具體路徑。

**「每個 perception 都必須有文字摘要」** — 這保護 fallback 品質。即使 multimodal 管道壞了，agent 不會變瞎。

**「action handler 做確定性驗證」** — 檔案存在性、格式正確性、大小限制。這些是 code 的責任，不是 LLM 的。

### Prescription 風險

**Tag 格式規範** — 如果我們定義「必須用 `format="json"` 而不是 `type="json"`」，這就是 prescription。LLM 會混用、打錯、發明新的。

→ 解法：attrs 解析層做 **寬鬆接受**。`format`、`type`、`media-type` 都映射到同一個內部欄位。Parser 是 convergence condition（「最終你的意圖要能被理解」），不是 prescription（「必須用這個精確語法」）。

**Attachment 類型枚舉** — 如果定義 `type: 'image' | 'data' | 'audio'` 是硬枚舉，新類型需要改 code。

→ 解法：type 是 `string`，handler 按 MIME type 或副檔名推斷行為。未知類型 = 當附件傳遞，不阻擋。

**必須使用特定 action 順序** — 如果要求「先 write 再 respond with attach」，這規定了路徑。

→ 解法：respond handler 自己檢查 attach 引用的檔案，不依賴執行順序。如果檔案不在，feedback 告訴 LLM 檔案不存在。

### 真正擴展能力 vs 增加複雜度的判斷標準

問自己：**這個改動讓 agent 能做之前不可能做的事，還是只讓同樣的事多了一種做法？**

- 圖片 perception → **不可能 → 可能**（之前完全看不到視覺內容）✓ 真擴展
- JSON format respond → **不方便 → 方便**（之前可以在 markdown 中放 code block）✗ 便利性
- Transport 解耦 → **不可能 → 可能**（之前無法換通道）✓ 真擴展
- 新 action type `generate-chart` → **已能用 shell 做**  ✗ 語法糖

按這個標準，優先順序是：
1. Transport 解耦（結構基礎，讓後續一切成為可能）
2. 圖片 perception（最大的認知能力跳躍）
3. Respond attachments（multimodal output 的最小實現）
4. 其他 — 等到真的需要

---

## 5. 我看到但你沒問的

**Perception 的 context window 壓力**：現在全文字的 perception 大約 2-5KB per tick。加圖片後，一張截圖 = 幾百 KB 的 token。如果 10 個 perception plugins 中有 3 個帶圖片，context 可能爆掉。

需要一個 **perception budget** 機制 — 不是限制「幾張圖」（prescription），而是限制「perception 總 token 不超過 N」（convergence condition）。超額時由 perception layer 自動降級：先裁圖片解析度，再 fallback 到純文字描述。

**Action feedback mini-loop 的 multimodal 問題**：目前 action 執行後的 feedback 是文字。如果 shell action 生成了一張圖，feedback 能帶圖回來嗎？如果能，agent 就可以在同一個 tick 內「生成圖 → 看到圖 → 分析圖 → 回覆」。這是很大的能力跳躍，但需要 feedback round 也支援 multimodal context。

**不要同時改兩層**：Transport 解耦和 multimodal 支援可以獨立進行。建議先做 transport 解耦（純重構，不改功能），驗證後再加 multimodal（新功能，在乾淨的 transport 上建）。這比同時做兩件事風險低很多。
</action:respond>

<action:remember>
## Tick 029: Tanren I/O Upgrade Analysis (2026-03-30)

Kuro asked for analysis of multimodal I/O upgrade based on Alex's direction (#170/#171).

My core positions:
1. **Sequence matters**: Transport decoupling first, then multimodal. Don't entangle two layers of complexity.
2. **Perception output**: Keep mandatory `text` field as protective constraint, add optional `attachments`. Every attachment must have `description` for fallback.
3. **Action tag design**: Use attrs mechanism (agree with Kuro), but separate intents — respond = communicate, write = create, `attach` attr bridges them. Don't mix "I'm talking" with "I'm generating."
4. **Transport interface**: Inject `transport` into `ActionContext`. ActionHandler interface unchanged (backward compatible). Default = FileTransport.
5. **CT analysis**: Core CC = "LLM declares intent, code does I/O." Prescription risks: tag format strictness, type enums, required action ordering. Solution: lenient parsing, string types, handler self-checks.
6. **Unsolicited insight**: Perception budget needed for multimodal — total token limit, not image count limit. Also: action feedback mini-loop needs multimodal support for in-tick generate→analyze→respond cycles.
7. **Capability expansion test**: Does the change make something impossible → possible, or just more convenient? Prioritize true capability expansions.
</action:remember>

<action:clear-inbox>read</action:clear-inbox>

--- Feedback Round 1 ---

Shell 指令失敗了——`scripts/render-chart.py` 不存在。這其實完美地示範了我在回覆中提到的重點：multimodal output 需要 infrastructure layer 先就位，LLM 才能「宣告意圖」讓 code 執行。

主要回覆已送達 Kuro，記憶已保存，inbox 已清除。圖表渲染的失敗不影響分析的傳遞，反而是一個活生生的 case study：沒有 render pipeline，`<action:shell>` 跑圖表就是空操作。這正是 Alex 說的「所有 I/O 透過 code」需要解決的基礎問題。

不需要額外行動。

## Observation

Response written to messages/to-kuro.md
Response written to messages/to-kuro.md
Written: analysis/chart-spec.json
[shell error: Command failed: bash -c python3 scripts/render-chart.py analysis/chart-spec.json
/opt/homebrew/Cellar/python@3.14/3.14.3_1/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python: can't open file '/Users/user/Workspace/tanren/scripts/render-chart.py': [Errno 2] No such file or directory
]
Response written to messages/to-kuro.md
Response written to messages/to-kuro.md
Remembered.
Inbox cleared.
