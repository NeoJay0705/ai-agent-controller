import { fail } from '../../shared/errors.js';
import type { Clock } from '../../shared/support.js';
import { isoNow } from '../../shared/support.js';
import type { Run, RunStatus } from '../../shared/types.js';

const activeStatuses: ReadonlySet<RunStatus> = new Set([
  'CREATED',
  'RUNNING',
  'WAITING_USER_INPUT',
  'WAITING_APPROVAL',
]);

const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'LIMIT_EXCEEDED',
]);

const transitions: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  CREATED: new Set([
    'RUNNING',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'LIMIT_EXCEEDED',
  ]),
  RUNNING: new Set([
    'WAITING_USER_INPUT',
    'WAITING_APPROVAL',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'LIMIT_EXCEEDED',
  ]),
  WAITING_USER_INPUT: new Set([
    'RUNNING',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'LIMIT_EXCEEDED',
  ]),
  WAITING_APPROVAL: new Set([
    'RUNNING',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'LIMIT_EXCEEDED',
  ]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
  LIMIT_EXCEEDED: new Set(),
};

export function isActiveRunStatus(status: RunStatus): boolean {
  return activeStatuses.has(status);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.has(status);
}

export function transitionRun(
  run: Run,
  nextStatus: RunStatus,
  clock: Clock,
  failureCode?: string,
): Run {
  if (!transitions[run.status].has(nextStatus)) {
    fail('CONFLICT', `Invalid Run transition: ${run.status} → ${nextStatus}`, {
      details: { runId: run.id },
    });
  }

  const updated: Run = {
    ...run,
    status: nextStatus,
    stateVersion: run.stateVersion + 1,
    updatedAt: isoNow(clock),
  };

  if (failureCode !== undefined) {
    return { ...updated, failureCode };
  }

  return updated;
}

export function requestRunCancellation(run: Run, clock: Clock): Run {
  if (!isActiveRunStatus(run.status)) {
    fail('CONFLICT', 'Only an active Run can be cancelled', {
      details: { runId: run.id },
    });
  }

  return {
    ...run,
    cancelRequestedAt: isoNow(clock),
    updatedAt: isoNow(clock),
  };
}
