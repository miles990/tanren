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
  reportingOwners?: ReportingOwnerConfig[]
  notReadyNextAction?: string
}

export interface ReportingOwnerConfig {
  owner: string
  responsibility: string
  currentOutput?: string
  status?: string
  blocker?: string
  nextAction?: string
  finalSpecAlignment?: string
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

function readinessText(snapshot: ProductionSnapshot): string {
  if (snapshot.objective.productReady) return '已達 product ready，可進入真人測試或下一個產品切片。'
  if (snapshot.objective.blockedReason) return `尚未 product ready，主要 blocker: ${snapshot.objective.blockedReason}`
  if (snapshot.objective.currentObjective?.repairOf) return '尚未 product ready，目前正在 repair cycle 收斂既有失敗。'
  if (snapshot.objective.currentObjective?.status === 'executing') return '尚未 product ready，目前自主產品 cycle 正在執行。'
  return '尚未 product ready，目前等待 supervisor 啟動或收斂下一個產品切片。'
}

function bossConclusion(snapshot: ProductionSnapshot): string {
  const objective = snapshot.objective.currentObjective
  if (snapshot.objective.productReady) {
    return '目前已通過產品交付條件，下一步是安排真人測試、收集證據，並由產品負責人決定下一個切片。'
  }
  if (objective?.repairOf) {
    return `目前正在修復 ${objective.repairOf}，重點是把既有產出收斂到可 review / QA / release 的狀態，不是擴大 scope。`
  }
  if (objective?.status === 'executing') {
    return `目前正在執行 ${objective.planId}，團隊有在前進；交付前仍需通過 review / QA / release gate。`
  }
  if (snapshot.objective.blockedReason) {
    return `目前被 blocker 擋住：${snapshot.objective.blockedReason}。需要先解除 blocker，再啟動下一個產品切片。`
  }
  return '目前沒有 active product objective。Supervisor 應根據 source of truth 啟動下一個最小產品切片或整理未合併成果。'
}

function objectiveTable(snapshot: ProductionSnapshot): string[] {
  const objective = snapshot.objective.currentObjective
  return [
    '| 項目 | 狀態 |',
    '| --- | --- |',
    `| 產品狀態 | ${markdownCell(readinessText(snapshot))} |`,
    `| lifecycle | ${markdownCell(snapshot.objective.lifecyclePhase ?? 'unknown')} |`,
    `| 目前 objective | ${markdownCell(objective?.goal ?? '無')} |`,
    `| planId | ${markdownCell(objective?.planId ?? '無')} |`,
    `| plan status | ${markdownCell(objective?.status ?? 'idle')} |`,
    `| repair of | ${markdownCell(objective?.repairOf ?? '無')} |`,
    `| blocked reason | ${markdownCell(snapshot.objective.blockedReason ?? '無')} |`,
    `| repair attempt | ${markdownCell(String(snapshot.objective.repairAttempt ?? 0))} |`,
    `| next merge gate | ${markdownCell(gateText(snapshot.objective.nextMergeGate))} |`,
    `| active worktree | ${markdownCell(snapshot.objective.activeWorktree?.branchName ?? '無')} |`,
  ]
}

function branchSummaryTable(snapshot: ProductionSnapshot): string[] {
  const hygiene = snapshot.branchHygiene
  if (!hygiene) return ['- Branch hygiene: unavailable']
  return [
    '| 項目 | 狀態 |',
    '| --- | --- |',
    `| Source of truth | ${markdownCell(hygiene.sourceOfTruth)} |`,
    `| Active cycle branches | ${markdownCell(hygiene.activeCycleBranches.length ? hygiene.activeCycleBranches.join(', ') : 'none')} |`,
    `| Cleanup candidates | ${hygiene.summary.cleanupCandidates} |`,
    `| Need review/cherry-pick | ${hygiene.summary.needsReview} |`,
    `| Consolidation required | ${hygiene.consolidation.required ? 'yes' : 'no'} |`,
  ]
}

function nextAction(snapshot: ProductionSnapshot): string {
  const configured = snapshot.config?.notReadyNextAction
  if (snapshot.objective.productReady) return '安排真人測試，收集證據，讓產品負責人決定下一個產品內容切片。'
  if (snapshot.objective.blockedReason) return `先解除 blocker: ${snapshot.objective.blockedReason}`
  if (snapshot.objective.currentObjective?.repairOf) return '完成 repair cycle，確認 artifact contract、review、QA、release gate，再合併回 source of truth。'
  return configured ?? '收斂目前 active cycle 或審查未合併成果；不要盲目新增產品分支。'
}

export function buildBossReport(snapshot: ProductionSnapshot): string {
  const owner = snapshot.config?.productOwner ?? 'product lead'
  const milestoneTargets = snapshot.config?.milestoneTargets ?? defaultMilestoneTargets()
  const reportingOwners = reportOwnerRows(snapshot, owner)
  return [
    '# 老闆報告',
    '',
    `更新時間: ${snapshot.timestamp}`,
    '語言: 繁體中文（專有名詞保留英文）',
    '',
    '## 一句話結論',
    '',
    bossConclusion(snapshot),
    '',
    '## 目前狀態',
    '',
    ...objectiveTable(snapshot),
    '',
    '## 負責人與分工',
    '',
    `對老闆窗口: ${owner}`,
    '',
    '| 負責人 | 職責 | 目前產出 | 狀態 | blocker | 下一步 | final-spec alignment |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...reportingOwners,
    '',
    '## 產品版本目標',
    '',
    ...milestoneTargets.map(item => `- ${item}`),
    '',
    '## Git 版本規則',
    '',
    ...branchSummaryTable(snapshot),
    '',
    '## 下一步',
    '',
    `- ${nextAction(snapshot)}`,
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
    `主責: ${owner}`,
    '',
    '## 產品',
    '',
    `${productName} 目前由 ${owner} 負責最後規格、取捨與對外溝通。`,
    '',
    '## 目前產品目標',
    '',
    readinessText(snapshot),
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
    `- support: ${support.join(', ')}`,
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
    ...objectiveTable(snapshot),
    '',
    '## Milestone / Version Targets',
    '',
    ...milestones.map(item => `- ${item}`),
    '',
    '## Branch Hygiene',
    '',
    ...branchSummaryTable(snapshot),
    '',
    '## 下一個切片',
    '',
    `- ${snapshot.objective.productReady ? '基於真人測試證據，由產品負責人決定下一個產品內容切片。' : snapshot.objective.blockedReason ? `先解除 blocker: ${snapshot.objective.blockedReason}` : snapshot.objective.currentObjective?.repairOf ? '完成 repair cycle，確認 artifact contract、review、QA、release gate，再合併回 source of truth。' : notReadyNextAction}`,
    '',
  ].join('\n')
}

function defaultMilestoneTargets(): string[] {
  return [
    'M0: Operating system can plan, execute, gate, report, and consolidate work without manual babysitting.',
    'M1: First reviewable product slice passes implementation, review, QA, release, and merge gates.',
    'M2: First evidence loop produces findings and one accountable owner decision.',
    'M3: Next product direction is selected from evidence before broad scope expansion.',
  ]
}

function reportOwnerRows(snapshot: ProductionSnapshot, owner: string): string[] {
  const objective = snapshot.objective.currentObjective
  const fallback: ReportingOwnerConfig[] = [{
    owner,
    responsibility: 'Direction, objective, final specification, and stakeholder communication',
    currentOutput: 'Configured report paths',
    status: objective?.status ?? 'idle',
    blocker: snapshot.objective.blockedReason ?? 'none',
    nextAction: snapshot.objective.productReady ? 'Start next evidence-backed slice' : 'Converge active work or clear the blocker',
    finalSpecAlignment: 'Required',
  }]
  const owners = snapshot.config?.reportingOwners?.length ? snapshot.config.reportingOwners : fallback
  return owners.map(item => [
    item.owner,
    item.responsibility,
    item.currentOutput ?? 'not configured',
    item.status ?? objective?.status ?? 'idle',
    item.blocker ?? snapshot.objective.blockedReason ?? 'none',
    item.nextAction ?? 'not configured',
    item.finalSpecAlignment ?? 'Required',
  ].map(markdownCell).join(' | ')).map(row => `| ${row} |`)
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function writeProductionReports(cwd: string, config: ProductionReportConfig, snapshot: ProductionSnapshot): void {
  if (config.enabled === false) return
  snapshot.config = config
  writeText(cwd, config.bossReportPath, buildBossReport(snapshot))
  writeText(cwd, config.productBriefPath, buildProductBrief(snapshot))
  writeText(cwd, config.roadmapPath, buildRoadmap(snapshot))
}
