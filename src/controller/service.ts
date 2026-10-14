import type { ControllerConfig, ServiceLogger } from './types.js';
import { DemoRunner } from './runner.js';
import { TelegramRouter } from './router.js';
import { TelegramClient, TelegramError } from './telegram.js';
import type { ControllerResources } from './lifecycle.js';

export interface ServiceOptions {
  readonly clock?: { now(): number };
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly logger?: ServiceLogger;
  readonly onFatal?: (classification: string) => void;
  readonly pollIntervalMs?: number;
  readonly outboxIntervalMs?: number;
}

export class ControllerService {
  readonly router: TelegramRouter;
  readonly runner: DemoRunner;
  private readonly resources: ControllerResources;
  private readonly telegram: TelegramClient;
  private readonly now: () => number;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly logger: ServiceLogger;
  private readonly onFatal: (classification: string) => void;
  private readonly pollIntervalMs: number;
  private readonly outboxIntervalMs: number;
  private readonly abortController = new AbortController();
  private loops: Promise<void>[] = [];
  private started = false;
  private stopping: Promise<void> | null = null;
  private fatal = false;

  constructor(
    config: ControllerConfig,
    resources: ControllerResources,
    telegram: TelegramClient,
    options: ServiceOptions = {},
  ) {
    this.resources = resources;
    this.telegram = telegram;
    this.now = () => options.clock?.now() ?? Date.now();
    this.sleep = options.sleep ?? abortableSleep;
    this.logger = options.logger ?? consoleLogger;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.outboxIntervalMs = options.outboxIntervalMs ?? 100;
    this.router = new TelegramRouter(resources.store, config);
    this.runner = new DemoRunner(resources.store, config, {
      clock: { now: this.now },
      sleep: this.sleep,
      onError: () => {
        this.logger.error('runner storage or execution error');
      },
    });
  }

  start(): void {
    if (this.started)
      throw new Error('Controller service has already started.');
    this.started = true;
    this.loops = [this.pollLoop(), this.runnerLoop(), this.outboxLoop()].map(
      (loop) =>
        loop.catch(() => {
          this.failController('service loop error');
        }),
    );
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.stopping = this.stopInternal();
    return this.stopping;
  }

  private async stopInternal(): Promise<void> {
    this.abortController.abort();
    await this.runner.stop();
    await Promise.all(this.loops);
    await this.resources.close();
  }

  private async pollLoop(): Promise<void> {
    let attempts = 0;
    const signal = this.abortController.signal;
    while (!isSignalAborted(signal)) {
      try {
        const updates = await this.telegram.getUpdates(
          this.resources.store.getOffset(),
          signal,
        );
        for (const update of [...updates].sort(
          (left, right) => left.update_id - right.update_id,
        )) {
          if (isSignalAborted(signal)) return;
          this.router.handle(update);
        }
        if (updates.length === 0) await this.sleep(this.pollIntervalMs, signal);
        attempts = 0;
      } catch (error) {
        if (isSignalAborted(signal) || isAborted(error)) return;
        if (isFatalTelegram(error)) {
          this.failController(error.kind);
          return;
        }
        this.logger.warn(pollErrorClassification(error));
        await this.backoff(attempts, error, signal);
        attempts += 1;
      }
    }
  }

  private async runnerLoop(): Promise<void> {
    let attempts = 0;
    const signal = this.abortController.signal;
    while (!isSignalAborted(signal)) {
      try {
        this.runner.tick();
        attempts = 0;
        await this.sleep(100, signal);
      } catch (error) {
        if (isSignalAborted(signal) || isAborted(error)) return;
        this.logger.warn('runner storage retry');
        await this.backoff(attempts, error, signal);
        attempts += 1;
      }
    }
  }

  private async outboxLoop(): Promise<void> {
    let attempts = 0;
    const signal = this.abortController.signal;
    while (!isSignalAborted(signal)) {
      try {
        const due = this.resources.store.dueOutbox(this.now());
        if (due.length === 0) {
          await this.sleep(this.outboxIntervalMs, signal);
          attempts = 0;
          continue;
        }
        for (const item of due) {
          if (isSignalAborted(signal)) return;
          try {
            const sent = await this.telegram.sendMessage(
              item.chatId,
              item.text,
              signal,
            );
            this.resources.store.deliverOutbox(
              item.id,
              sent.chatId,
              sent.messageId,
              this.now(),
            );
          } catch (error) {
            if (isSignalAborted(signal) || isAborted(error)) return;
            if (isFatalTelegram(error)) {
              this.failController(error.kind);
              return;
            }
            if (error instanceof TelegramError && error.kind === 'permanent') {
              this.resources.store.failOutbox(item.id);
            } else {
              const delay = retryDelay(item.attempts, error);
              this.resources.store.retryOutbox(item.id, this.now() + delay);
              this.logger.warn(`outbox retry: ${classification(error)}`);
              if (
                error instanceof TelegramError &&
                error.kind === 'rate_limited'
              ) {
                await this.backoff(attempts, error, signal);
                break;
              }
            }
          }
        }
        attempts = 0;
      } catch {
        if (isSignalAborted(signal)) return;
        this.logger.warn('outbox storage retry');
        await this.backoff(attempts, undefined, signal);
        attempts += 1;
      }
    }
  }

  private async backoff(
    attempts: number,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (isSignalAborted(signal)) return;
    const milliseconds = retryDelay(attempts, error);
    try {
      await this.sleep(milliseconds, signal);
    } catch {
      // Abort is the expected result during shutdown.
    }
  }

  private failController(classification: string): void {
    if (this.fatal) return;
    this.fatal = true;
    this.logger.error(`controller stopped: ${classification}`);
    this.abortController.abort();
    void this.stop().catch(() => {
      this.logger.error('controller shutdown failed');
    });
    try {
      this.onFatal(classification);
    } catch {
      this.logger.error('fatal shutdown callback failed');
    }
  }
}

export function retryDelay(attempt: number, error: unknown): number {
  if (
    error instanceof TelegramError &&
    error.kind === 'rate_limited' &&
    error.retryAfterSeconds !== undefined
  ) {
    return error.retryAfterSeconds * 1000;
  }
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
}

function pollErrorClassification(error: unknown): string {
  if (error instanceof TelegramError) return `poll retry: ${error.kind}`;
  return 'poll retry: storage or protocol error';
}

function classification(error: unknown): string {
  return error instanceof TelegramError ? error.kind : 'storage';
}

function isFatalTelegram(error: unknown): error is TelegramError {
  return (
    error instanceof TelegramError &&
    (error.kind === 'credential' || error.kind === 'conflict')
  );
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isAborted(error: unknown): boolean {
  return error instanceof TelegramError && error.kind === 'aborted';
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

const consoleLogger: ServiceLogger = {
  info: (message) => {
    console.info(message);
  },
  warn: (message) => {
    console.warn(message);
  },
  error: (message) => {
    console.error(message);
  },
};
