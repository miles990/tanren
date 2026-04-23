# Agent Pool — 多主題並行討論

## 背景

Alex 需要同時和 Akari 進行多個不同主題的 KG discussion。目前 Tanren `serve.ts` 使用 singleton `ticking` mutex，一次只能處理一個 `/chat` 請求。

## 架構決策（KG discussion d4aba05b 共識）

- **Agent Pool**：`serve.ts` 從 singleton agent → pool of agents
- **KG-as-Context**：shared state 全走 KG，pool agents 是 stateless workers
- **Cold start 優化**：KG 已有 `GET /discussion/:id/summary` + `POST /discussion/:id/summarize`
- **Hybrid learning**：workers stateless，orchestrator（autonomous loop）stateful
- **Autonomous loop 獨立**：不佔 pool slot，用獨立 agent instance

## DAG Plan（v1.1 — 納入 Akari review）

| id | 動作 | dependsOn | 完成條件 |
|----|------|-----------|----------|
| T1 | 在 `serve.ts` 實作 AgentPool 型別和 pool 管理邏輯（acquireAgent/releaseAgent） | — | `AgentPool` interface 定義完成��`acquireAgent()` 可根據 `discussionId` 取得或建立 agent instance，`releaseAgent()` 可釋放 |
| T2 | `/chat` 和 `/chat/stream` 端點改用 pool + per-agent inbox namespace（`messages/agent-{idx}/`）+ 429 回應加 `Retry-After` header | T1 | 兩個端點都接受 `discussionId` 參數，concurrent requests with different discussionIds 不互相 block |
| T3 | `/health` 端點更新，回報 pool 狀���（active/idle/total/max agents） | T1 | health response 包含 `pool: { active, idle, total, max }` |
| T4 | Autonomous loop 用獨立 agent instance（不在 pool 中），`runExclusive` 只鎖 autonomous agent | T1 | autonomous loop tick 和 `/chat` request 可同時進行 |
| T5 | Discussion affinity — 同一 `discussionId` 的後續請求優先路由到同一 agent instance | T1 | 連續兩次相同 discussionId 的 `/chat` 取到同一 agent（session continuity） |
| T6 | Akari `reference-run.ts` 適配 — autonomous loop 使用獨立 agent，不影響 pool | T4 | `reference-run.ts` 的 autonomous loop 正常運作，不影��� `/chat` 並行 |
| T7 | 整合測試 — 同時發兩個不同 discussionId 的 `/chat` 請求，驗證真並行 | T2, T4, T5, T6 | ���個 concurrent `/chat` 都回應成功（非 429），各自有獨立��� response |

### 並行圖

```
T1 ──→ T2 ��─→ T7
  ├──→ T3
  ├──→ T4 ──→ T6 ──→ T7
  └──→ T5 ──────────→ T7
```

T2, T3, T4, T5 可並行（都只依賴 T1）。T7 等所有完成。

## ���鍵設計細節

### AgentPool

```typescript
interface PoolEntry {
  agent: TanrenAgent
  busy: boolean
  discussionId: string | null  // affinity
  lastUsed: number
  index: number                // for per-agent inbox namespace
}

const MAX_POOL_SIZE = 3  // 不含 autonomous agent
```

### Pool 生命週期

1. `/chat { discussionId: "abc" }` → `acquireAgent("abc")`
   - 找已�� affinity match 且 idle → 復用
   - 找任意 idle agent → assign affinity
   - pool 未滿 → `createAgent(config)` 新建
   - pool ��且全 busy → 429 + `Retry-After` header + `estimatedWaitMs`
2. tick chain 完成 → `releaseAgent(entry)`
3. Idle 超過 30 min → 清理 agent（但保留 affinity mapping 以便下次恢復）

### Autonomous Loop（獨立管理）

- `serve()` 建立時 `createAgent(config)` 一個獨立 autonomous agent
- `runExclusive` 只鎖這個 autonomous agent，不影響 pool
- autonomous agent 和 pool agents 完全隔離
- `reference-run.ts` 使用 `handle.runExclusive()` 不變，但底層只鎖 autonomous agent

### onBeforeChat Race Fix

- 每個 pool agent 有獨立的 inbox namespace：`messages/agent-0/`, `messages/agent-1/` ...
- `onBeforeChat(from, text, agentIndex)` — callback 簽名加 agentIndex
- Akari 的 `onBeforeChat` 寫入 `messages/agent-{idx}/from-kuro.md` 而非共用路徑

### 不動的部分

- `loop.ts` — 不動
- `index.ts` — `createAgent` 已是 factory，天然支援
- `prompt-builder.ts` — 不動
- Akari `tanren.config.mjs` — 不動

### Backwards Compatibility

- `/chat` 不帶 `discussionId` → 使用 default pool agent（等同現行行為）
- Pool size = 1 時行為等同 singleton
- `onBeforeChat` 不帶 agentIndex 的 callback 仍可正常工作（fallback 到 index 0）
