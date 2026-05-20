import {
  approveAction,
  classifyFailure,
  decideNextAction,
  verifyContract,
  type ActionApprovalDecision,
  type ActionApprovalRequest,
  type FailureType,
  type NextAction,
  type RuntimeResult,
  type TrustBoundaryPolicy,
  type TaskEnvelope,
} from '@miles990/autonomy-runtime';
import type { PlanStep, StepResult } from './plan-engine.js';

export interface ExecutionHarnessInput {
  objectiveId: string;
  planId: string;
  step: PlanStep;
  result: StepResult;
  attempt?: number;
  repoRoot: string;
  worktreePath?: string;
}

export interface ExecutionHarnessEvaluation {
  task: TaskEnvelope;
  failureType: FailureType;
  nextAction: NextAction;
  runtimeResult: RuntimeResult;
}

export type ApprovalEvaluation = ActionApprovalDecision & {
  stepId?: string;
  worker?: string;
  action?: string;
}

export function evaluateExecutionHarnessFailure(input: ExecutionHarnessInput): ExecutionHarnessEvaluation {
  const task = toTaskEnvelope(input);
  const contract = verifyContract(task);
  const failureType = contract.passed ? classifyFailure(input.result.output) : 'contract';
  const nextAction = decideNextAction(task, failureType);
  return {
    task,
    failureType,
    nextAction,
    runtimeResult: {
      status: failureType === 'none' ? 'completed' : nextAction === 'escalate' ? 'needs_boss' : 'failed',
      failureType,
      nextAction,
      changedFiles: [],
      evidence: contract.evidence,
      reason: contract.passed ? input.result.output : 'artifact contract failed',
    },
  };
}

export function toTaskEnvelope(input: ExecutionHarnessInput): TaskEnvelope {
  return {
    objectiveId: input.objectiveId,
    planId: input.planId,
    stepId: input.step.id,
    attempt: input.attempt ?? 0,
    workerRole: input.step.worker,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    gateType: input.step.gate === 'review' || input.step.gate === 'qa' || input.step.gate === 'release'
      ? input.step.gate
      : undefined,
    artifactContract: {
      allowedPaths: input.step.artifactContract?.allowedPaths ?? [],
      expectedOutputs: input.step.artifactContract?.expectedPaths ?? [],
      verifyCommands: input.step.verifyCommand ? [input.step.verifyCommand] : [],
    },
    escalationPolicy: {
      maxAttempts: 3,
      escalateOn: ['strategic'],
    },
  };
}

export function evaluatePlanStepApproval(input: {
  userObjective: string;
  step: PlanStep;
  policy: TrustBoundaryPolicy;
  explicitAuthorization?: string[];
}): ApprovalEvaluation {
  const request: ActionApprovalRequest = {
    userObjective: input.userObjective,
    action: input.step.task,
    actor: input.step.worker,
    command: input.step.verifyCommand,
    targetPaths: [
      ...(input.step.artifactContract?.allowedPaths ?? []),
      ...(input.step.artifactContract?.expectedPaths ?? []),
    ],
    explicitAuthorization: input.explicitAuthorization,
    policy: input.policy,
  };
  return {
    ...approveAction(request),
    stepId: input.step.id,
    worker: input.step.worker,
    action: input.step.task,
  };
}
