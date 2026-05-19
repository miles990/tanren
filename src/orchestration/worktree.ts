import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface WorktreeIsolationConfig {
  mode: 'none' | 'cycle-worktree'
  /** Branch or commit used as the worktree base. Defaults to HEAD. */
  baseBranch?: string
  /** Prefix for generated worktree branches. Defaults to tanren/cycle. */
  branchPrefix?: string
  /** Directory for worktrees. Relative paths resolve from the git root. */
  pathRoot?: string
  /** Cleanup behavior after plan completion. Defaults to never. */
  cleanup?: 'never' | 'on-success' | 'always'
}

export interface WorktreeContext {
  mode: 'cycle-worktree'
  repoRoot: string
  originalCwd: string
  cwd: string
  worktreePath: string
  branchName: string
  baseRef: string
  cleanup: 'never' | 'on-success' | 'always'
}

export function repoRootFor(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  }).trim()
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'plan'
}

export function createCycleWorktree(cwd: string, planId: string, config: WorktreeIsolationConfig): WorktreeContext {
  const repoRoot = repoRootFor(cwd)
  const relativeCwd = relative(repoRoot, cwd)
  if (relativeCwd.startsWith('..')) {
    throw new Error(`cwd is outside git root: cwd=${cwd} repoRoot=${repoRoot}`)
  }

  const branchPrefix = config.branchPrefix ?? 'tanren/cycle'
  const branchName = `${branchPrefix}/${safePathSegment(planId)}`
  const baseRef = config.baseBranch ?? 'HEAD'
  const pathRoot = config.pathRoot
    ? (isAbsolute(config.pathRoot) ? config.pathRoot : resolve(repoRoot, config.pathRoot))
    : resolve(repoRoot, '..', `${repoRoot.split('/').pop()}.worktrees`)
  const worktreePath = join(pathRoot, safePathSegment(planId))
  const cleanup = config.cleanup ?? 'never'

  mkdirSync(pathRoot, { recursive: true })
  git(repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, baseRef])

  return {
    mode: 'cycle-worktree',
    repoRoot,
    originalCwd: cwd,
    cwd: relativeCwd ? join(worktreePath, relativeCwd) : worktreePath,
    worktreePath,
    branchName,
    baseRef,
    cleanup,
  }
}

export function cleanupCycleWorktree(context: WorktreeContext): void {
  try {
    git(context.repoRoot, ['worktree', 'remove', '--force', context.worktreePath])
  } catch {
    rmSync(context.worktreePath, { recursive: true, force: true })
    try {
      git(context.repoRoot, ['worktree', 'prune'])
    } catch { /* best effort */ }
  }
}

