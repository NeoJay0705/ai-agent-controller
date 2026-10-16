import type { Environment } from './config.js';

export interface TrialPolicy {
  readonly trialDurationMs: number;
  readonly inviteTtlMs: number;
  readonly maxJobs: number;
  readonly jobWindowMs: number;
  readonly maxJobsPerWindow: number;
  readonly maxMessages: number;
  readonly messageWindowMs: number;
  readonly maxMessagesPerWindow: number;
  readonly maxPendingJobs: number;
  readonly maxSessions: number;
  readonly maxRunningJobs: number;
  readonly sessionTokenLimit: number;
  readonly userTokenLimit: number;
  readonly commandDialogTtlMs: number;
  readonly controlMaxPerMinute: number;
}

const TIMER_MAX = 2_147_483_647;
const COUNTER_MAX = 1_000_000_000;

export const DEFAULT_TRIAL_POLICY: TrialPolicy = Object.freeze({
  trialDurationMs: 3_600_000,
  inviteTtlMs: 600_000,
  maxJobs: 3,
  jobWindowMs: 600_000,
  maxJobsPerWindow: 2,
  maxMessages: 100,
  messageWindowMs: 60_000,
  maxMessagesPerWindow: 20,
  maxPendingJobs: 2,
  maxSessions: 2,
  maxRunningJobs: 1,
  sessionTokenLimit: 100_000,
  userTokenLimit: 200_000,
  commandDialogTtlMs: 300_000,
  controlMaxPerMinute: 10,
});

const ENV_FIELDS = {
  TRIAL_DURATION_MS: ['trialDurationMs', TIMER_MAX],
  INVITE_TTL_MS: ['inviteTtlMs', TIMER_MAX],
  TRIAL_MAX_JOBS: ['maxJobs', COUNTER_MAX],
  TRIAL_JOB_WINDOW_MS: ['jobWindowMs', TIMER_MAX],
  TRIAL_MAX_JOBS_PER_WINDOW: ['maxJobsPerWindow', COUNTER_MAX],
  TRIAL_MAX_MESSAGES: ['maxMessages', COUNTER_MAX],
  TRIAL_MESSAGE_WINDOW_MS: ['messageWindowMs', TIMER_MAX],
  TRIAL_MAX_MESSAGES_PER_WINDOW: ['maxMessagesPerWindow', COUNTER_MAX],
  TRIAL_MAX_PENDING_JOBS: ['maxPendingJobs', COUNTER_MAX],
  TRIAL_MAX_SESSIONS: ['maxSessions', COUNTER_MAX],
  TRIAL_MAX_RUNNING_JOBS: ['maxRunningJobs', 1],
  TRIAL_SESSION_TOKEN_LIMIT: ['sessionTokenLimit', COUNTER_MAX],
  TRIAL_USER_TOKEN_LIMIT: ['userTokenLimit', COUNTER_MAX],
  COMMAND_DIALOG_TTL_MS: ['commandDialogTtlMs', TIMER_MAX],
  CONTROL_MAX_PER_MINUTE: ['controlMaxPerMinute', COUNTER_MAX],
} as const satisfies Record<string, readonly [keyof TrialPolicy, number]>;

export function parseTrialPolicy(env: Environment): TrialPolicy {
  const policy: Record<keyof TrialPolicy, number> = {
    ...DEFAULT_TRIAL_POLICY,
  };
  for (const [name, [field, maximum]] of Object.entries(ENV_FIELDS)) {
    const raw = env[name];
    if (raw === undefined) continue;
    const match = /^[0-9]+$/.exec(raw);
    if (match === null || match[0] !== raw) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new Error(`${name} must be between 1 and ${String(maximum)}`);
    }
    policy[field] = parsed;
  }
  return Object.freeze(policy);
}
