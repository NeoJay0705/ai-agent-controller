import { fail } from '../../shared/errors.js';
import type { RunBudget, UsageSnapshot } from '../../shared/types.js';

export interface UsageLimits {
  readonly maxConcurrentUserRuns?: number;
  readonly maxConcurrentTenantRuns?: number;
  readonly maxUserTokens?: number;
  readonly maxTenantTokens?: number;
  readonly maxUserRuns?: number;
  readonly maxTenantRuns?: number;
}

export interface UsageCounters {
  readonly activeUserRuns: number;
  readonly activeTenantRuns: number;
  readonly userTokens: number;
  readonly tenantTokens: number;
  readonly userRuns: number;
  readonly tenantRuns: number;
}

export interface AdmissionRequest {
  readonly limits: UsageLimits;
  readonly counters: UsageCounters;
  readonly rateAllowed: boolean;
}

export interface RunUsageIncrement {
  readonly llmCalls?: number;
  readonly toolCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
  readonly durationMs?: number;
}

export class UsagePolicy {
  assertAdmission(request: AdmissionRequest): void {
    if (!request.rateAllowed) {
      fail('RATE_LIMITED', 'Request rate limit exceeded', { retryable: true });
    }

    assertLimit(
      request.counters.activeUserRuns,
      request.limits.maxConcurrentUserRuns,
      'CONCURRENCY_LIMITED',
      'User concurrency limit exceeded',
    );
    assertLimit(
      request.counters.activeTenantRuns,
      request.limits.maxConcurrentTenantRuns,
      'CONCURRENCY_LIMITED',
      'Tenant concurrency limit exceeded',
    );
    assertLimit(
      request.counters.userTokens,
      request.limits.maxUserTokens,
      'QUOTA_EXCEEDED',
      'User token quota exceeded',
    );
    assertLimit(
      request.counters.tenantTokens,
      request.limits.maxTenantTokens,
      'QUOTA_EXCEEDED',
      'Tenant token quota exceeded',
    );
    assertLimit(
      request.counters.userRuns,
      request.limits.maxUserRuns,
      'QUOTA_EXCEEDED',
      'User run quota exceeded',
    );
    assertLimit(
      request.counters.tenantRuns,
      request.limits.maxTenantRuns,
      'QUOTA_EXCEEDED',
      'Tenant run quota exceeded',
    );
  }

  assertRunBudget(
    budget: RunBudget,
    current: UsageSnapshot,
    increment: RunUsageIncrement,
  ): void {
    assertBudget(
      current.llmCalls + (increment.llmCalls ?? 0),
      budget.maxLlmCalls,
      'LLM call budget exceeded',
    );
    assertBudget(
      current.toolCalls + (increment.toolCalls ?? 0),
      budget.maxToolCalls,
      'Tool call budget exceeded',
    );
    assertBudget(
      current.inputTokens + (increment.inputTokens ?? 0),
      budget.maxInputTokens,
      'Input token budget exceeded',
    );
    assertBudget(
      current.outputTokens + (increment.outputTokens ?? 0),
      budget.maxOutputTokens,
      'Output token budget exceeded',
    );
    assertBudget(
      current.cost + (increment.cost ?? 0),
      budget.maxCost,
      'Run cost budget exceeded',
    );
    if (
      budget.maxDurationMs !== undefined &&
      current.durationMs + (increment.durationMs ?? 0) > budget.maxDurationMs
    ) {
      fail('LIMIT_EXCEEDED', 'Run duration budget exceeded');
    }
  }
}

function assertLimit(
  current: number,
  limit: number | undefined,
  code: 'CONCURRENCY_LIMITED' | 'QUOTA_EXCEEDED',
  message: string,
): void {
  if (limit !== undefined && current >= limit) {
    fail(code, message, { retryable: code === 'CONCURRENCY_LIMITED' });
  }
}

function assertBudget(
  current: number,
  limit: number | undefined,
  message: string,
): void {
  if (limit !== undefined && current > limit) {
    fail('LIMIT_EXCEEDED', message);
  }
}
