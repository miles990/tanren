import { execFileSync } from 'node:child_process'

export interface BranchHygienePolicy {
  canonicalBranch?: string
  cyclePrefixes?: string[]
  protectedBranches?: string[]
}

export interface BranchHygieneBranch {
  name: string
  head: string
  current: boolean
  worktreePath?: string
  status: 'canonical' | 'protected' | 'active-cycle' | 'merged-cycle' | 'unmerged-cycle' | 'unmanaged'
  mergedIntoCanonical: boolean
  sameAsCanonical: boolean
  recommendedAction: 'use_as_source_of_truth' | 'wait' | 'cleanup_worktree_and_branch' | 'review_or_cherry_pick_before_cleanup' | 'keep'
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

export function auditBranchHygiene(cwd: string, activeCycleBranches: string[] = [], policy: BranchHygienePolicy = {}): BranchHygieneReport {
  const repoRoot = git(cwd, ['rev-parse', '--show-toplevel'])
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
    const protectedBranch = protectedBranches.has(branch.name)
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
      recommendedAction = 'cleanup_worktree_and_branch'
    } else if (isCycle) {
      status = 'unmerged-cycle'
      recommendedAction = 'review_or_cherry_pick_before_cleanup'
    }

    return {
      name: branch.name,
      head: branch.head,
      current: branch.current,
      worktreePath: worktrees.get(branch.name),
      status,
      mergedIntoCanonical,
      sameAsCanonical,
      recommendedAction,
    }
  })

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
      needsReview: branches.filter(branch => branch.recommendedAction === 'review_or_cherry_pick_before_cleanup').length,
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
