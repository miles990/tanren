import { execFileSync } from 'node:child_process'

export interface BranchHygienePolicy {
  canonicalBranch?: string
  cyclePrefixes?: string[]
  protectedBranches?: string[]
  consolidation?: {
    mode?: 'off' | 'audit' | 'block-new-cycles'
    /** Number of unmerged cycle branches tolerated before consolidation is required. Defaults to Infinity. */
    maxUnmergedCycleBranches?: number
    /** Number of review candidates to surface. Defaults to 5. */
    maxCandidates?: number
    /** Max consolidation plans submitted for one unchanged unmerged-branch fingerprint before the supervisor stops consolidating. Defaults to 2. */
    maxConsolidationAttempts?: number
    /** When the attempt cap is reached, fall through to normal product work instead of staying blocked. Defaults to true. */
    consolidationFallthrough?: boolean
  }
}

export interface BranchHygieneBranch {
  name: string
  head: string
  current: boolean
  worktreePath?: string
  dirty: boolean
  dirtyFiles: string[]
  status: 'canonical' | 'protected' | 'active-cycle' | 'merged-cycle' | 'unmerged-cycle' | 'unmanaged'
  mergedIntoCanonical: boolean
  sameAsCanonical: boolean
  aheadCanonical: number
  behindCanonical: number
  latestSubject?: string
  recommendedAction: 'use_as_source_of_truth' | 'wait' | 'cleanup_worktree_and_branch' | 'review_or_cherry_pick_before_cleanup' | 'review_dirty_worktree_before_cleanup' | 'keep'
}

export interface BranchHygieneReport {
  repoRoot: string
  currentBranch: string
  canonicalBranch: string
  sourceOfTruth: string
  activeCycleBranches: string[]
  branches: BranchHygieneBranch[]
  summary: {
    activeCycles: number
    cleanupCandidates: number
    needsReview: number
  }
  consolidation: {
    required: boolean
    mode: 'off' | 'audit' | 'block-new-cycles'
    reason: string | null
    candidates: BranchHygieneBranch[]
    /** Stable fingerprint of the unmerged-branch set driving `needsReview` (`name@head` sorted, newline-joined). Empty when nothing needs review. */
    fingerprint: string
  }
}

export interface BranchCleanupResult {
  dryRun: boolean
  removed: Array<{ branch: string; worktreePath?: string }>
  skipped: Array<{ branch: string; reason: string }>
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function branchHead(cwd: string, branch: string): string {
  try {
    return git(cwd, ['rev-parse', branch])
  } catch {
    return ''
  }
}

function aheadBehind(cwd: string, canonicalBranch: string, branch: string): { ahead: number; behind: number } {
  if (branch === canonicalBranch) return { ahead: 0, behind: 0 }
  try {
    const [behind, ahead] = git(cwd, ['rev-list', '--left-right', '--count', `${canonicalBranch}...${branch}`])
      .split(/\s+/)
      .map(value => Number.parseInt(value, 10))
    return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

function latestSubject(cwd: string, branch: string): string | undefined {
  try {
    return git(cwd, ['log', '-1', '--format=%s', branch])
  } catch {
    return undefined
  }
}

function localBranches(cwd: string): Array<{ name: string; head: string; current: boolean }> {
  return git(cwd, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(HEAD)', 'refs/heads'])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, head, marker] = line.split('\t')
      return { name, head, current: marker === '*' }
    })
}

function worktreeBranches(cwd: string): Map<string, string> {
  const map = new Map<string, string>()
  const chunks = git(cwd, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    const branchRef = lines.find(line => line.startsWith('branch '))?.slice('branch '.length)
    if (!path || !branchRef?.startsWith('refs/heads/')) continue
    map.set(branchRef.slice('refs/heads/'.length), path)
  }
  return map
}

function dirtyFiles(cwd: string | undefined): string[] {
  if (!cwd) return []
  try {
    return git(cwd, ['status', '--porcelain'])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function auditBranchHygiene(cwd: string, activeCycleBranches: string[] = [], policy: BranchHygienePolicy = {}): BranchHygieneReport {
  let repoRoot: string
  try {
    repoRoot = git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    const canonicalBranch = policy.canonicalBranch ?? 'unknown'
    const mode = policy.consolidation?.mode ?? 'audit'
    return {
      repoRoot: cwd,
      currentBranch: 'unknown',
      canonicalBranch,
      sourceOfTruth: canonicalBranch,
      activeCycleBranches,
      branches: [],
      summary: {
        activeCycles: 0,
        cleanupCandidates: 0,
        needsReview: 0,
      },
      consolidation: {
        required: false,
        mode,
        reason: null,
        candidates: [],
        fingerprint: '',
      },
    }
  }
  const currentBranch = git(repoRoot, ['branch', '--show-current'])
  const canonicalBranch = policy.canonicalBranch ?? currentBranch
  const cyclePrefixes = policy.cyclePrefixes ?? ['tanren/cycle', 'tanren/autopilot']
  const protectedBranches = new Set([canonicalBranch, currentBranch, ...(policy.protectedBranches ?? [])])
  const active = new Set(activeCycleBranches)
  const worktrees = worktreeBranches(repoRoot)
  const canonicalHead = branchHead(repoRoot, canonicalBranch)

  const branches = localBranches(repoRoot).map((branch): BranchHygieneBranch => {
    const isCycle = cyclePrefixes.some(prefix => branch.name === prefix || branch.name.startsWith(`${prefix}/`))
    const mergedIntoCanonical = branch.name === canonicalBranch || gitOk(repoRoot, ['merge-base', '--is-ancestor', branch.name, canonicalBranch])
    const sameAsCanonical = Boolean(canonicalHead) && branch.head === canonicalHead
    const relative = aheadBehind(repoRoot, canonicalBranch, branch.name)
    const protectedBranch = protectedBranches.has(branch.name)
    const worktreePath = worktrees.get(branch.name)
    const dirty = dirtyFiles(worktreePath)
    let status: BranchHygieneBranch['status'] = 'unmanaged'
    let recommendedAction: BranchHygieneBranch['recommendedAction'] = 'keep'

    if (branch.name === canonicalBranch) {
      status = 'canonical'
      recommendedAction = 'use_as_source_of_truth'
    } else if (active.has(branch.name)) {
      status = 'active-cycle'
      recommendedAction = 'wait'
    } else if (protectedBranch) {
      status = 'protected'
      recommendedAction = 'keep'
    } else if (isCycle && (mergedIntoCanonical || sameAsCanonical)) {
      status = 'merged-cycle'
      recommendedAction = dirty.length > 0 ? 'review_dirty_worktree_before_cleanup' : 'cleanup_worktree_and_branch'
    } else if (isCycle) {
      status = 'unmerged-cycle'
      recommendedAction = 'review_or_cherry_pick_before_cleanup'
    }

    return {
      name: branch.name,
      head: branch.head,
      current: branch.current,
      worktreePath,
      dirty: dirty.length > 0,
      dirtyFiles: dirty,
      status,
      mergedIntoCanonical,
      sameAsCanonical,
      aheadCanonical: relative.ahead,
      behindCanonical: relative.behind,
      latestSubject: latestSubject(repoRoot, branch.name),
      recommendedAction,
    }
  })
  const reviewBranches = branches.filter(branch => branch.recommendedAction === 'review_or_cherry_pick_before_cleanup' || branch.recommendedAction === 'review_dirty_worktree_before_cleanup')
  const candidates = [...reviewBranches]
    .sort((a, b) => (b.aheadCanonical - a.aheadCanonical) || a.name.localeCompare(b.name))
    .slice(0, policy.consolidation?.maxCandidates ?? 5)
  const mode = policy.consolidation?.mode ?? 'audit'
  const maxUnmerged = policy.consolidation?.maxUnmergedCycleBranches ?? Number.POSITIVE_INFINITY
  const needsReview = reviewBranches.length
  const fingerprint = reviewBranches
    .map(branch => `${branch.name}@${branch.head}`)
    .sort()
    .join('\n')
  const required = mode !== 'off' && needsReview > maxUnmerged

  return {
    repoRoot,
    currentBranch,
    canonicalBranch,
    sourceOfTruth: canonicalBranch,
    activeCycleBranches,
    branches,
    summary: {
      activeCycles: branches.filter(branch => branch.status === 'active-cycle').length,
      cleanupCandidates: branches.filter(branch => branch.recommendedAction === 'cleanup_worktree_and_branch').length,
      needsReview,
    },
    consolidation: {
      required,
      mode,
      reason: required ? `unmerged cycle branches (${needsReview}) exceed allowed threshold (${maxUnmerged})` : null,
      candidates,
      fingerprint,
    },
  }
}

export function cleanupMergedCycleBranches(cwd: string, activeCycleBranches: string[] = [], policy: BranchHygienePolicy = {}, opts: { dryRun?: boolean } = {}): BranchCleanupResult {
  const dryRun = opts.dryRun !== false
  const report = auditBranchHygiene(cwd, activeCycleBranches, policy)
  const removed: BranchCleanupResult['removed'] = []
  const skipped: BranchCleanupResult['skipped'] = []

  for (const branch of report.branches) {
    if (branch.recommendedAction !== 'cleanup_worktree_and_branch') continue
    if (branch.current) {
      skipped.push({ branch: branch.name, reason: 'current_branch' })
      continue
    }
    if (dryRun) {
      removed.push({ branch: branch.name, worktreePath: branch.worktreePath })
      continue
    }
    try {
      if (branch.worktreePath) git(report.repoRoot, ['worktree', 'remove', '--force', branch.worktreePath])
      git(report.repoRoot, ['branch', '-d', branch.name])
      removed.push({ branch: branch.name, worktreePath: branch.worktreePath })
    } catch (err) {
      skipped.push({ branch: branch.name, reason: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) })
    }
  }

  return { dryRun, removed, skipped }
}
