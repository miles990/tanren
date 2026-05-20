import type { SupervisorTickInput, SupervisorTickResult } from './supervisor.js';

export interface SupervisorLoopOptions {
  tick: () => Promise<SupervisorTickResult>;
  pollMs?: number;
  idleMs?: number;
  maxTicks?: number;
  stopOnSubmitted?: boolean;
  signal?: AbortSignal;
  logger?: (message: string) => void;
}

export interface SupervisorHttpLoopOptions extends Omit<SupervisorLoopOptions, 'tick'> {
  apiUrl: string;
  tickInput?: SupervisorTickInput;
  fetchImpl?: typeof fetch;
}

export interface SupervisorLoopSummary {
  ticks: number;
  submittedPlans: string[];
  lastResult?: SupervisorTickResult;
  stoppedReason: 'max_ticks' | 'submitted' | 'aborted';
}

export async function runSupervisorLoop(options: SupervisorLoopOptions): Promise<SupervisorLoopSummary> {
  const pollMs = Math.max(0, options.pollMs ?? 10_000);
  const idleMs = Math.max(0, options.idleMs ?? pollMs);
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  const submittedPlans: string[] = [];
  let lastResult: SupervisorTickResult | undefined;

  for (let ticks = 0; ticks < maxTicks; ticks += 1) {
    if (options.signal?.aborted) {
      return { ticks, submittedPlans, lastResult, stoppedReason: 'aborted' };
    }

    lastResult = await options.tick();
    if (lastResult.submittedPlanId) submittedPlans.push(lastResult.submittedPlanId);
    options.logger?.(formatSupervisorLoopResult(ticks + 1, lastResult));

    if (lastResult.submittedPlanId && options.stopOnSubmitted) {
      return { ticks: ticks + 1, submittedPlans, lastResult, stoppedReason: 'submitted' };
    }

    if (ticks + 1 >= maxTicks) {
      return { ticks: ticks + 1, submittedPlans, lastResult, stoppedReason: 'max_ticks' };
    }

    await sleep(lastResult.status === 'executing' ? idleMs : pollMs, options.signal);
  }

  return { ticks: maxTicks, submittedPlans, lastResult, stoppedReason: 'max_ticks' };
}

export function runSupervisorHttpLoop(options: SupervisorHttpLoopOptions): Promise<SupervisorLoopSummary> {
  const fetcher = options.fetchImpl ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/$/, '');
  return runSupervisorLoop({
    ...options,
    tick: async () => {
      try {
        const response = await fetcher(`${apiUrl}/supervisor/tick`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options.tickInput ?? {}),
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) as SupervisorTickResult : {} as SupervisorTickResult;
        if (!response.ok && body.error !== 'scheduler_locked') {
          return transientSupervisorFailure(`supervisor tick failed: ${response.status} ${text}`);
        }
        return body;
      } catch (err) {
        return transientSupervisorFailure(err instanceof Error ? err.message : String(err));
      }
    },
  });
}

function transientSupervisorFailure(message: string): SupervisorTickResult {
  return {
    action: 'wait',
    decision: {
      action: 'wait',
      failureType: 'transient',
      reason: `supervisor tick unavailable: ${message}`,
      requiresBoss: false,
    },
    status: 'blocked',
    error: 'supervisor_tick_unavailable',
    errors: [message],
  };
}

export function formatSupervisorLoopResult(tick: number, result: SupervisorTickResult): string {
  const submitted = result.submittedPlanId ? ` submitted=${result.submittedPlanId}` : '';
  const error = result.error ? ` error=${result.error}` : '';
  return `[supervisor] tick=${tick} action=${result.action} status=${result.status ?? 'unknown'}${submitted}${error}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
