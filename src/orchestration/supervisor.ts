import type { ActionPlan } from './plan-engine.js';
import type { ActionApprovalDecision, TrustBoundaryPolicy } from '@miles990/autonomy-runtime';

export type SupervisorAction =
  | 'wait'
  | 'start_smallest_product_slice'
  | 'retry_same_step'
  | 'decompose_failed_step'
  | 'repair_workspace'
  | 'resume_downstream'
  | 'run_merge_gate'
  | 'escalate_boss';

export type SupervisorFailureType =
  | 'none'
  | 'transient'
  | 'provider_hold'
  | 'max_turns'
  | 'cancelled'
  | 'workspace'
  | 'contract'
  | 'verification'
  | 'strategic'
  | 'unknown';

export interface SupervisorStepSnapshot {
  id: string;
  worker: string;
  label?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'skipped' | 'cancelled' | string;
  mode?: 'read' | 'write' | 'verify' | 'report';
  gate?: 'review' | 'qa' | 'merge' | 'release' | 'boss-report';
  output?: string;
}

export interface SupervisorPlanSnapshot {
  planId: string;
  goal: string;
  status: 'executing' | 'completed' | 'failed' | 'abandoned' | string;
  repairOf?: string;
  repairAttempt?: number;
  steps: SupervisorStepSnapshot[];
}

export interface SupervisorObjectiveSnapshot {
  currentObjective: {
    planId: string;
    goal: string;
    status: string;
    repairOf?: string;
  } | null;
  activePlans: Array<{ planId: string; status: string }>;
  blockedReason: string | null;
  repairAttempt: number;
  mergeReady: boolean;
  nextMergeGate?: { gate: string; status: string; verdict: string } | null;
}

export interface SupervisorInput {
  objective: SupervisorObjectiveSnapshot;
  plans: SupervisorPlanSnapshot[];
  maxInternalRepairAttempts?: number;
}

export interface SupervisorDecision {
  action: SupervisorAction;
  failureType: SupervisorFailureType;
  reason: string;
  targetPlanId?: string;
  targetStepId?: string;
  requiresBoss: boolean;
}

export interface SmallestProductSliceInput {
  goal: string;
  implementationTask: string;
  allowedPaths: string[];
  expectedPaths: string[];
  verifyCommand: string;
  acceptance?: string;
  implementationWorker?: string;
  reviewWorker?: string;
  qaWorker?: string;
  releaseWorker?: string;
  supportWorkers?: string[];
}

export interface SupervisorTickInput {
  dryRun?: boolean;
  smallestProductSlice?: SmallestProductSliceInput;
  approval?: {
    enforce?: boolean;
    explicitAuthorization?: string[];
    policy?: TrustBoundaryPolicy;
  };
}

export interface SupervisorTickResult {
  action: SupervisorAction;
  decision: SupervisorDecision;
  plan?: ActionPlan;
  submittedPlanId?: string;
  status?: string;
  error?: string;
  errors?: string[];
  approvals?: Array<ActionApprovalDecision & { stepId?: string; worker?: string }>;
  selectedWorkers?: ReturnType<typeof selectSmallestProductSliceWorkers>;
}

export function classifySupervisorFailure(text: string): SupervisorFailureType {
  const value = text.toLowerCase();
  if (!value.trim()) return 'none';
  if (/socket connection was closed|econnreset|network|fetch failed|temporar/.test(value)) return 'transient';
  if (/quota|rate.?limit|usage limit|hit your limit|out of extra usage|provider resource/.test(value)) return 'provider_hold';
  if (/maximum number of turns|max turns|reached maximum/.test(value)) return 'max_turns';
  if (/aborted by user|cancelled|canceled|sigint/.test(value)) return 'cancelled';
  if (/worktree|workspace|wrote outside|wrong.directory|repo root|cwd/.test(value)) return 'workspace';
  if (/artifact contract|allowed paths|expected paths|contract/.test(value)) return 'contract';
  if (/verify failed|verification failed|repair-verify|test -e|command failed|assert/.test(value)) return 'verification';
  if (/boss decision|product direction|external input|credential|permission|scope direction/.test(value)) return 'strategic';
  return 'unknown';
}

export function evaluateSupervisor(input: SupervisorInput): SupervisorDecision {
  const maxRepairs = input.maxInternalRepairAttempts ?? 3;
  const objective = input.objective;
  const latest = latestPlan(input.plans);
  const failed = latest?.steps.find(step => step.status === 'failed' || step.status === 'timeout');
  const failedText = [objective.blockedReason, failed?.output, failed?.label, failed?.id].filter(Boolean).join('\n');
  const failureType = classifySupervisorFailure(failedText);

  if (!objective.currentObjective) {
    return decision('start_smallest_product_slice', 'none', 'no current objective exists; create the smallest product slice', false);
  }

  if (objective.mergeReady) {
    return decision('run_merge_gate', 'none', 'all required gates passed; run merge gate', false, objective.currentObjective.planId);
  }

  if (objective.activePlans.length > 0) {
    return decision('wait', 'none', 'an active plan is already executing', false, objective.activePlans[0]?.planId);
  }

  if (objective.nextMergeGate && objective.nextMergeGate.status === 'pending') {
    return decision('wait', 'none', `waiting for ${objective.nextMergeGate.gate} gate`, false, objective.currentObjective.planId);
  }

  if (objective.currentObjective.status !== 'failed') {
    return decision('wait', 'none', `objective status is ${objective.currentObjective.status}`, false, objective.currentObjective.planId);
  }

  if (failureType === 'strategic') {
    return decision('escalate_boss', failureType, 'blocked reason requires external strategic decision', true, objective.currentObjective.planId, failed?.id);
  }

  if (failureType === 'workspace') {
    return decision('repair_workspace', failureType, 'workspace/worktree failure should be repaired before product escalation', false, objective.currentObjective.planId, failed?.id);
  }

  if (failureType === 'transient' || failureType === 'cancelled') {
    return objective.repairAttempt >= maxRepairs
      ? decision('start_smallest_product_slice', failureType, 'transient/cancelled failures exhausted repair budget; bypass broad repair and dispatch smallest product slice', false, objective.currentObjective.planId, failed?.id)
      : decision('retry_same_step', failureType, 'transient/cancelled failure should retry the same step', false, objective.currentObjective.planId, failed?.id);
  }

  if (failureType === 'max_turns') {
    return decision('decompose_failed_step', failureType, 'max-turns means the step is too broad; split it before retrying', false, objective.currentObjective.planId, failed?.id);
  }

  if (failureType === 'verification' || failureType === 'contract') {
    if (objective.repairAttempt >= maxRepairs || productProgressCount(input.plans) === 0) {
      return decision('start_smallest_product_slice', failureType, 'repair did not produce product progress; dispatch the smallest known product slice', false, objective.currentObjective.planId, failed?.id);
    }
    return decision('retry_same_step', failureType, 'verification/contract failure should be retried with the same step contract', false, objective.currentObjective.planId, failed?.id);
  }

  if (objective.repairAttempt >= maxRepairs && productProgressCount(input.plans) === 0) {
    return decision('start_smallest_product_slice', failureType, 'internal repair attempts produced no product progress; switch to smallest product slice', false, objective.currentObjective.planId, failed?.id);
  }

  return decision('decompose_failed_step', failureType, 'unknown execution failure should be decomposed before boss escalation', false, objective.currentObjective.planId, failed?.id);
}

export function buildSmallestProductSlicePlan(
  input: SmallestProductSliceInput,
  availableWorkers?: Set<string>,
): ActionPlan {
  const errors = validateSmallestProductSliceInput(input);
  if (errors.length > 0) {
    throw new Error(`smallestProductSlice contract invalid: ${errors.join('; ')}`);
  }

  const selected = selectSmallestProductSliceWorkers(input, availableWorkers);
  const implementationWorker = selected.implementationWorker;
  const reviewWorker = selected.reviewWorker;
  const qaWorker = selected.qaWorker;
  const releaseWorker = selected.releaseWorker;

  return {
    goal: input.goal,
    acceptance: input.acceptance ?? [
      'Deliver the smallest playable, reviewable product slice.',
      'Keep scope narrow, verify the exact expected outputs, and do not expand product direction.',
      'All gates must return PASS, FAIL, or BLOCKED on the first line.',
    ].join('\n'),
    steps: [
      {
        id: 'implement-slice',
        worker: implementationWorker,
        mode: 'write',
        label: 'Implement smallest product slice',
        dependsOn: [],
        verifyCommand: input.verifyCommand,
        artifactContract: {
          allowedPaths: input.allowedPaths,
          expectedPaths: input.expectedPaths,
        },
        task: [
          input.implementationTask,
          '',
          'Scope rules:',
          '- Implement only the smallest product slice needed to create visible product progress.',
          '- Stay inside allowed paths.',
          '- Produce every expected output path.',
          '- Run or satisfy the verification command before reporting done.',
        ].join('\n'),
      },
      {
        id: 'review-slice',
        worker: reviewWorker,
        mode: 'verify',
        gate: 'review',
        label: 'Review product slice',
        dependsOn: ['implement-slice'],
        task: [
          'Review the implemented product slice for correctness, scope control, maintainability, and contract compliance.',
          'First line must be one of: PASS, FAIL, BLOCKED.',
          'If not PASS, list the smallest focused fix needed.',
        ].join('\n'),
      },
      {
        id: 'qa-slice',
        worker: qaWorker,
        mode: 'verify',
        gate: 'qa',
        label: 'QA product slice',
        dependsOn: ['review-slice'],
        task: [
          'QA the product slice against acceptance criteria and user-test readiness.',
          'First line must be one of: PASS, FAIL, BLOCKED.',
          'Verify visible behavior, regressions, and tester-facing clarity.',
        ].join('\n'),
      },
      {
        id: 'release-slice',
        worker: releaseWorker,
        mode: 'verify',
        gate: 'release',
        label: 'Release gate',
        dependsOn: ['qa-slice'],
        task: [
          'Check whether this slice is ready to merge back to the product branch.',
          'First line must be one of: PASS, FAIL, BLOCKED.',
          'Confirm review and QA passed, expected outputs exist, and no unresolved blockers remain.',
        ].join('\n'),
      },
    ],
  };
}

export function selectSmallestProductSliceWorkers(
  input: Partial<SmallestProductSliceInput> = {},
  availableWorkers?: Set<string>,
) {
  return {
    implementationWorker: input.implementationWorker ?? pickWorker(availableWorkers, ['gameplay-engineer', 'coder']),
    reviewWorker: input.reviewWorker ?? pickWorker(availableWorkers, ['codex-reviewer', 'reviewer']),
    qaWorker: input.qaWorker ?? pickWorker(availableWorkers, ['qa-reality-checker', 'reviewer']),
    releaseWorker: input.releaseWorker ?? pickWorker(availableWorkers, ['release-engineer', 'reviewer']),
    supportWorkers: (input.supportWorkers ?? ['game-designer', 'ui-ux-designer', 'technical-artist', 'playtest-analyst'])
      .filter(worker => !availableWorkers || availableWorkers.has(worker)),
  };
}

function decision(
  action: SupervisorAction,
  failureType: SupervisorFailureType,
  reason: string,
  requiresBoss: boolean,
  targetPlanId?: string,
  targetStepId?: string,
): SupervisorDecision {
  return { action, failureType, reason, requiresBoss, targetPlanId, targetStepId };
}

function latestPlan(plans: SupervisorPlanSnapshot[]): SupervisorPlanSnapshot | undefined {
  return plans.at(-1);
}

function productProgressCount(plans: SupervisorPlanSnapshot[]): number {
  return plans.flatMap(plan => plan.steps).filter(step =>
    step.status === 'completed'
    && (step.mode === 'write' || step.gate === 'review' || step.gate === 'qa' || step.gate === 'release')
    && !/^classify-|^fix-|^repair-/.test(step.id),
  ).length;
}

function validateSmallestProductSliceInput(input: SmallestProductSliceInput): string[] {
  const errors: string[] = [];
  if (!input.goal?.trim()) errors.push('goal is required');
  if (!input.implementationTask?.trim()) errors.push('implementationTask is required');
  if (!input.allowedPaths?.length) errors.push('allowedPaths is required');
  if (!input.expectedPaths?.length) errors.push('expectedPaths is required');
  if (!input.verifyCommand?.trim()) errors.push('verifyCommand is required');
  return errors;
}

function pickWorker(availableWorkers: Set<string> | undefined, candidates: string[]): string {
  if (!availableWorkers) return candidates[candidates.length - 1];
  return candidates.find(candidate => availableWorkers.has(candidate)) ?? candidates[candidates.length - 1];
}
