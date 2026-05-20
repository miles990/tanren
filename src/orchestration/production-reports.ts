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

export function writeProductionReports(cwd: string, config: ProductionReportConfig, snapshot: ProductionSnapshot): void {
  if (config.enabled === false) return
  snapshot.config = config
  writeText(cwd, config.bossReportPath, buildBossReport(snapshot))
  writeText(cwd, config.productBriefPath, buildProductBrief(snapshot))
  writeText(cwd, config.roadmapPath, buildRoadmap(snapshot))
}
