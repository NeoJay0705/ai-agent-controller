import type { ControllerConfig, JobRecord } from './types.js';
import { ControllerStore } from './store.js';

export interface RunnerClock {
  now(): number;
}

export type RunnerSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export class DemoRunner {
  private readonly store: ControllerStore;
  private readonly config: ControllerConfig;
  private readonly clock: RunnerClock;
  private readonly sleep: RunnerSleep;
  private readonly onError: (error: unknown) => void;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly abortController = new AbortController();
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    store: ControllerStore,
    config: ControllerConfig,
    options: {
      readonly clock?: RunnerClock;
      readonly sleep?: RunnerSleep;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.store = store;
    this.config = config;
    this.clock = options.clock ?? { now: Date.now };
    this.sleep = options.sleep ?? sleep;
    this.onError = options.onError ?? (() => undefined);
    this.store.assertConcurrencyLimit(config.concurrency);
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    this.store.expireDueJobs(now);
    const running = this.store.scheduleAvailable(
      now,
      this.config.concurrency,
      this.config.timeoutMs,
    );
    for (const jobId of running) {
      if (this.workers.has(jobId)) continue;
      const worker = this.runJob(jobId, this.abortController.signal)
        .catch((error: unknown) => {
          if (!this.abortController.signal.aborted) this.onError(error);
        })
        .finally(() => {
          this.workers.delete(jobId);
        });
      this.workers.set(jobId, worker);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopped = true;
    this.abortController.abort();
    this.stopPromise = Promise.all([...this.workers.values()]).then(
      () => undefined,
    );
    return this.stopPromise;
  }

  private async runJob(jobId: string, signal: AbortSignal): Promise<void> {
    while (!signalAborted(signal)) {
      const job = this.store.getRunningJob(jobId);
      if (job === null) return;
      if (job.deadlineAt !== null && this.clock.now() >= job.deadlineAt) {
        this.store.advanceStep(jobId, this.clock.now());
        return;
      }
      try {
        await this.sleep(this.config.stepMs, signal);
      } catch (error) {
        if (signalAborted(signal) || isAbortError(error)) return;
        throw error;
      }
      if (signalAborted(signal)) return;
      const updated = this.store.advanceStep(jobId, this.clock.now());
      if (updated === null || updated.status !== 'RUNNING') return;
    }
  }
}

export function defaultRunnerSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return sleep(milliseconds, signal);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Runner wait aborted.');
  error.name = 'AbortError';
  return error;
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export type { JobRecord };
