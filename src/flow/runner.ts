import { ControllerStore } from '../controller/store.js';
import { FlowExecutor } from './executor.js';
import { FlowStore } from './store.js';

export interface FlowRunnerOptions {
  readonly concurrency: number;
  readonly now?: () => number;
  readonly onError?: (error: Error) => void;
}

interface Worker {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly controller: AbortController;
  promise: Promise<void>;
}

function executionFailureCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  return error.code === 'FLOW_STORAGE_INVALID' ? error.code : null;
}

/** Session-partitioned scheduler. Workers, not persisted status, own slots. */
export class FlowRunner {
  private readonly controllerStore: ControllerStore;
  private readonly flowStore: FlowStore;
  private readonly executor: FlowExecutor;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;
  private readonly workers = new Map<string, Worker>();
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    controllerStore: ControllerStore,
    flowStore: FlowStore,
    executor: FlowExecutor,
    options: FlowRunnerOptions,
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new TypeError(
        'Flow runner concurrency must be a positive integer.',
      );
    }
    this.controllerStore = controllerStore;
    this.flowStore = flowStore;
    this.executor = executor;
    this.concurrency = options.concurrency;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    try {
      this.flowStore.failExpiredWaitingJobs(now);
    } catch {
      this.report('FLOW_SCHEDULER_FAILED');
      return;
    }
    this.abortExpiredWorkers(now);
    const slots = Math.max(0, this.concurrency - this.workers.size);
    if (slots === 0) return;
    const excludedSessions = new Set(
      [...this.workers.values()].map((worker) => worker.sessionId),
    );
    let reserved;
    try {
      reserved = this.flowStore.reserveReadyJobs(now, slots, excludedSessions);
    } catch {
      this.report('FLOW_SCHEDULER_FAILED');
      return;
    }
    for (const reservation of reserved) {
      const context = this.flowStore.getJobContext(reservation.jobId);
      if (context === null || context.status !== 'RUNNING') {
        this.report('FLOW_SCHEDULER_FAILED');
        continue;
      }
      const persisted = this.controllerStore.statusForJob(
        context.ownerId,
        reservation.jobId,
      );
      if (persisted === null || persisted.status !== 'RUNNING') continue;
      const controller = new AbortController();
      const worker: Worker = {
        sessionId: reservation.sessionId,
        ownerId: context.ownerId,
        controller,
        promise: Promise.resolve(),
      };
      worker.promise = this.executor
        .execute(reservation.jobId, controller.signal)
        .catch((error: unknown) => {
          this.report(executionFailureCode(error) ?? 'FLOW_EXECUTION_FAILED');
        })
        .finally(() => {
          if (this.workers.get(reservation.jobId) === worker) {
            this.workers.delete(reservation.jobId);
          }
        });
      this.workers.set(reservation.jobId, worker);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopped = true;
    const workers = [...this.workers.values()];
    for (const worker of workers) {
      if (!worker.controller.signal.aborted) {
        worker.controller.abort('RUNNER_STOPPED');
      }
    }
    this.stopPromise = (async () => {
      await Promise.all(workers.map((worker) => worker.promise));
      try {
        await this.executor.dispose();
      } catch {
        this.report('FLOW_RUNTIME_DISPOSED');
        throw new Error('FLOW_RUNTIME_DISPOSED');
      }
    })();
    return this.stopPromise;
  }

  private abortExpiredWorkers(now: number): void {
    for (const [jobId, worker] of this.workers) {
      const job = this.controllerStore.statusForJob(worker.ownerId, jobId);
      if (job === null) {
        if (!worker.controller.signal.aborted) {
          worker.controller.abort('RUNNER_STOPPED');
        }
        continue;
      }
      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        if (!worker.controller.signal.aborted) {
          worker.controller.abort('RUNNER_STOPPED');
        }
        continue;
      }
      if (
        job.status === 'RUNNING' &&
        job.deadlineAt !== null &&
        now >= job.deadlineAt &&
        !worker.controller.signal.aborted
      ) {
        worker.controller.abort('TIMEOUT');
      }
    }
  }

  private report(code: string): void {
    try {
      this.onError(new Error(code));
    } catch {
      // Error reporting cannot release a worker or alter Job state.
    }
  }
}
