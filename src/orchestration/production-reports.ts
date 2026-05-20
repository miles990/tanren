import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { BranchHygieneReport } from './branch-hygiene.js'

export interface ProductionReportConfig {
  enabled?: boolean
  bossReportPath: string
  productBriefPath: string
  roadmapPath: string
  language?: string
  productName?: string
  productOwner?: string
  supportRoles?: string[]
  northStar?: string
  currentDirection?: string[]
  milestoneTargets?: string[]
  notReadyNextAction?: string
}

export interface ProductionSnapshot {
  timestamp: string
  config?: ProductionReportConfig
  objective: {
    currentObjective?: { planId: string; goal: string; status: string; repairOf?: string } | null
    lifecyclePhase?: string
    productReady?: boolean
    blockedReason?: string | null
    repairAttempt?: number
    nextMergeGate?: unknown
    activeWorktree?: { branchName?: string; worktreePath?: string } | null
  }
  branchHygiene?: BranchHygieneReport
  trigger?: {
    type: string
    planId?: string
    status?: string
  }
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

function writeText(cwd: string, path: string, content: string): void {
  const fullPath = resolvePath(cwd, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  if (existsSync(fullPath)) {
    const existing = readFileSync(fullPath, 'utf-8')
    if (normalizeReportTimestamp(existing) === normalizeReportTimestamp(content)) return
  }
  writeFileSync(fullPath, content, 'utf-8')
}

function normalizeReportTimestamp(content: string): string {
  return content.replace(/^更新時間: .+$/m, '更新時間: <timestamp>')
}

function branchSummary(snapshot: ProductionSnapshot): string {
  const hygiene = snapshot.branchHygiene
  if (!hygiene) return '- Branch hygiene: unavailable'
  return [
    `- Source of truth: ${hygiene.sourceOfTruth}`,
    `- Active cycle branches: ${hygiene.activeCycleBranches.length ? hygiene.activeCycleBranches.join(', ') : 'none'}`,
    `- Cleanup candidates: ${hygiene.summary.cleanupCandidates}`,
    `- Need review/cherry-pick: ${hygiene.summary.needsReview}`,
  ].join('\n')
}

function gateText(value: unknown): string {
  if (!value) return 'none'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function buildBossReport(snapshot: ProductionSnapshot): string {
  const objective = snapshot.objective.currentObjective
  const owner = snapshot.config?.productOwner ?? 'product lead'
  const milestoneTargets = snapshot.config?.milestoneTargets ?? defaultMilestoneTargets()
  return [
    '# 老闆報告',
    '',
    `更新時間: ${snapshot.timestamp}`,
    '語言: 繁體中文',
    '',
    '## 目前狀態',
    '',
    `- 產品狀態: ${snapshot.objective.productReady ? '已合併為 product ready' : '尚未 product ready'}`,
    `- 閉環階段: ${snapshot.objective.lifecyclePhase ?? 'unknown'}`,
    `- 目前 objective: ${objective?.goal ?? '無'}`,
    `- planId: ${objective?.planId ?? '無'}`,
    `- plan status: ${objective?.status ?? 'idle'}`,
    `- repair of: ${objective?.repairOf ?? '無'}`,
    `- blocked reason: ${snapshot.objective.blockedReason ?? '無'}`,
    `- repair attempt: ${snapshot.objective.repairAttempt ?? 0}`,
    `- next merge gate: ${gateText(snapshot.objective.nextMergeGate)}`,
    `- active worktree: ${snapshot.objective.activeWorktree?.branchName ?? '無'}`,
    `- 對老闆窗口: ${owner}`,
    '',
    '## 產品版本目標',
    '',
    ...milestoneTargets.map(item => `- ${item}`),
    '',
    '## Owner 進度',
    '',
    '| owner | responsibility | current output | status | blocker | next action | final-spec alignment |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${owner} | 產品方向、目標、最後規格、老闆溝通 | docs/final-product-decision-current.md / docs/boss-report.md | ${objective?.status ?? 'idle'} | ${snapshot.objective.blockedReason ?? '無'} | ${snapshot.objective.productReady ? '安排真人測試與下一切片' : '收斂目前 cycle 或解除 blocker'} | 以 final spec 為準 |`,
    '| game-designer | 卡牌規則、取捨、平衡假設 | docs/support-game-designer-brief.md | pending/running by cycle | 無即時摘要 | 依 final spec 修正設計輸入 | 必須對齊 final spec |',
    '| ui-ux-designer | 首屏理解、資訊階層、操作清楚度 | docs/support-ui-ux-designer-brief.md | pending/running by cycle | 無即時摘要 | 依 final spec 修正 UX acceptance | 必須對齊 final spec |',
    '| technical-artist | demo 畫面可展示性、視覺一致性 | docs/support-technical-artist-brief.md / docs/art-direction-current.md | pending/running by cycle | 無即時摘要 | 依 final spec 修正視覺標準 | 必須對齊 final spec |',
    '| gameplay-engineer | Godot 實作與可玩性 | game/ | pending/running by cycle | 無即時摘要 | 實作最小可驗收切片 | 必須對齊 final spec |',
    '| qa-reality-checker | 玩家是否真的能玩懂 | QA gate output | pending/running by cycle | 無即時摘要 | 用 final spec 判定 PASS/FAIL/BLOCKED | 必須對齊 final spec |',
    '| release-engineer | 交付、啟動、repo clean | release gate output | pending/running by cycle | 無即時摘要 | 確認可合併與可交付狀態 | 必須對齊 final spec |',
    '',
    '## Git 版本規則',
    '',
    branchSummary(snapshot),
    '',
    '## 下一步',
    '',
    snapshot.objective.productReady
      ? '- 可以安排真人測試與下一個產品切片。'
      : '- 優先收斂目前 active cycle 或審查未合併成果；不要盲目新增產品分支。',
    '',
    '## 更新來源',
    '',
    `- trigger: ${snapshot.trigger?.type ?? 'manual'}`,
    `- trigger plan: ${snapshot.trigger?.planId ?? '無'}`,
    `- trigger status: ${snapshot.trigger?.status ?? '無'}`,
    '',
  ].join('\n')
}

export function buildProductBrief(snapshot: ProductionSnapshot): string {
  const productName = snapshot.config?.productName ?? 'Current product'
  const owner = snapshot.config?.productOwner ?? 'product lead'
  const support = snapshot.config?.supportRoles ?? ['engineering', 'design', 'QA', 'release']
  const direction = snapshot.config?.currentDirection ?? [
    'Keep the product objective explicit.',
    'Prefer the smallest reviewable product slice.',
    'Do not expand scope until evidence gates pass.',
  ]
  const milestones = snapshot.config?.milestoneTargets ?? defaultMilestoneTargets()
  return [
    '# 目前產品企劃',
    '',
    `更新時間: ${snapshot.timestamp}`,
    '',
    '## 企劃主責',
    '',
    `- 主責: ${owner}`,
    `- 支援: ${support.join(', ')}`,
    '',
    '## 目前產品方向',
    '',
    `- 產品: ${productName}`,
    ...direction.map(item => `- ${item}`),
    '',
    '## 產品版本目標',
    '',
    ...milestones.map(item => `- ${item}`),
    '',
    '## 目前產品狀態',
    '',
    `- lifecycle: ${snapshot.objective.lifecyclePhase ?? 'unknown'}`,
    `- productReady: ${snapshot.objective.productReady ? 'yes' : 'no'}`,
    `- active objective: ${snapshot.objective.currentObjective?.goal ?? '無'}`,
    `- blocked reason: ${snapshot.objective.blockedReason ?? '無'}`,
    '',
  ].join('\n')
}

export function buildRoadmap(snapshot: ProductionSnapshot): string {
  const northStar = snapshot.config?.northStar ?? 'Deliver the smallest product slice that can pass review, QA, release, and merge gates.'
  const notReadyNextAction = snapshot.config?.notReadyNextAction ?? '收斂目前 active cycle 或審查未合併成果；不要盲目新增產品分支。'
  const milestones = snapshot.config?.milestoneTargets ?? defaultMilestoneTargets()
  return [
    '# 目前藍圖',
    '',
    `更新時間: ${snapshot.timestamp}`,
    '',
    '## 北極星目標',
    '',
    northStar,
    '',
    '## 當前 Gate',
    '',
    `- lifecycle: ${snapshot.objective.lifecyclePhase ?? 'unknown'}`,
    `- next merge gate: ${gateText(snapshot.objective.nextMergeGate)}`,
    `- productReady: ${snapshot.objective.productReady ? 'yes' : 'no'}`,
    '',
    '## Milestone / Version Targets',
    '',
    ...milestones.map(item => `- ${item}`),
    '',
    '## Branch Hygiene',
    '',
    branchSummary(snapshot),
    '',
    '## 下一個切片',
    '',
    snapshot.objective.blockedReason
      ? `- 先解除 blocker: ${snapshot.objective.blockedReason}`
      : `- ${notReadyNextAction}`,
    '',
  ].join('\n')
}

function defaultMilestoneTargets(): string[] {
  return [
    'M0: Team system can plan, execute, gate, report, and consolidate without boss babysitting.',
    'M1: Tester-ready first battle demo with visible win/loss, enemy intent, card costs/effects, energy, draw/discard, and clear feedback.',
    'M2: First human playtest evidence loop with H1-H5 findings and one Product Owner decision.',
    'M3: Replayable MVP direction selected from evidence; only then consider enemy/card reward/map/shop/progression expansion.',
  ]
}

export function writeProductionReports(cwd: string, config: ProductionReportConfig, snapshot: ProductionSnapshot): void {
  if (config.enabled === false) return
  snapshot.config = config
  writeText(cwd, config.bossReportPath, buildBossReport(snapshot))
  writeText(cwd, config.productBriefPath, buildProductBrief(snapshot))
  writeText(cwd, config.roadmapPath, buildRoadmap(snapshot))
}
