import { DomainError, type ControllerStore } from '../controller/store.js';
import type { TrialStore } from '../controller/trial-store.js';
import type { AgentRuntime, AgentNodeResult, UsageBudget } from './types.js';

/** Adds durable guest usage accounting without changing the Agent result contract. */
export class TrialBudgetRuntime implements AgentRuntime {
  constructor(
    private readonly inner: AgentRuntime,
    private readonly controllerStore: ControllerStore,
    private readonly trialStore: TrialStore,
  ) {}

  async run(
    input: Parameters<AgentRuntime['run']>[0],
  ): Promise<AgentNodeResult> {
    const job = this.controllerStore.database
      .prepare('SELECT owner_id,session_id FROM jobs WHERE id=?')
      .get(input.jobId) as
      { owner_id?: unknown; session_id?: unknown } | undefined;
    if (
      job === undefined ||
      typeof job.owner_id !== 'string' ||
      job.session_id !== input.controllerSessionId
    ) {
      throw new TrialRuntimeError('FLOW_ACCESS_DENIED');
    }
    let begun: ReturnType<TrialStore['beginUsage']>;
    try {
      begun = this.controllerStore.transaction(() =>
        this.trialStore.beginUsage(
          job.owner_id as string,
          input.controllerSessionId,
          input.jobId,
        ),
      );
    } catch (error) {
      throw mapTrialError(error);
    }
    if (begun === null) return await this.inner.run(input);

    const started = new Set<number>();
    const received = new Set<number>();
    const usageState = { requestedComplete: false };
    let storageFailed = false;
    const usageBudget: UsageBudget = {
      limitTokens: begun.remainingTokens,
      onRequestStarted: (sequence) => {
        if (
          !Number.isSafeInteger(sequence) ||
          sequence < 0 ||
          started.has(sequence)
        ) {
          storageFailed = true;
          throw new TrialRuntimeError('FLOW_STORAGE_INVALID');
        }
        started.add(sequence);
      },
      onUsage: (sequence, totalTokens) => {
        if (!started.has(sequence) || received.has(sequence)) {
          storageFailed = true;
          throw new TrialRuntimeError('FLOW_STORAGE_INVALID');
        }
        try {
          this.controllerStore.transaction(() => {
            this.trialStore.recordUsage(
              begun.operationId,
              sequence,
              totalTokens,
            );
          });
          received.add(sequence);
        } catch {
          storageFailed = true;
          throw new TrialRuntimeError('FLOW_STORAGE_INVALID');
        }
      },
      onSettled: (complete) => {
        usageState.requestedComplete =
          complete &&
          started.size > 0 &&
          started.size === received.size &&
          [...started].every((seq) => received.has(seq));
      },
    };
    let outcome:
      | { readonly kind: 'resolved'; readonly result: AgentNodeResult }
      | { readonly kind: 'rejected'; readonly error: Error };
    try {
      outcome = {
        kind: 'resolved',
        result: await this.inner.run({ ...input, usageBudget }),
      };
    } catch (error) {
      outcome = {
        kind: 'rejected',
        error:
          error instanceof Error
            ? error
            : new TrialRuntimeError('FLOW_EXECUTION_FAILED'),
      };
    }
    try {
      this.controllerStore.transaction(() => {
        this.trialStore.finishUsage(
          begun.operationId,
          usageState.requestedComplete && !storageFailed,
        );
      });
    } catch {
      storageFailed = true;
    }
    if (storageFailed) throw new TrialRuntimeError('FLOW_STORAGE_INVALID');
    if (outcome.kind === 'rejected') throw outcome.error;
    if (!usageState.requestedComplete)
      throw new TrialRuntimeError('FLOW_USAGE_UNKNOWN');
    return outcome.result;
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

class TrialRuntimeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'TrialRuntimeError';
    this.code = code;
  }
}

function mapTrialError(error: unknown): Error {
  if (!(error instanceof DomainError))
    return new TrialRuntimeError('FLOW_STORAGE_INVALID');
  switch (error.code) {
    case 'QUOTA_TOKEN_LIMIT':
      return new TrialRuntimeError('FLOW_TOKEN_LIMIT');
    case 'QUOTA_USAGE_UNKNOWN':
      return new TrialRuntimeError('FLOW_USAGE_UNKNOWN');
    case 'ACCESS_DENIED':
    case 'NOT_FOUND':
      return new TrialRuntimeError('FLOW_ACCESS_DENIED');
    default:
      return new TrialRuntimeError('FLOW_STORAGE_INVALID');
  }
}
