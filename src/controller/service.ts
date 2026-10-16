import type { AgentRuntime, FlowBundle } from '../flow/types.js';
import { FlowExecutor } from '../flow/executor.js';
import { assertFlowAuthConfiguration } from '../flow/config-file.js';
import { FlowRegistry } from '../flow/registry.js';
import { FlowRunner } from '../flow/runner.js';
import { FlowStore } from '../flow/store.js';
import { PiCliRpcRuntime } from '../flow/pi-rpc-runtime.js';
import type { ControllerConfig, ServiceLogger } from './types.js';
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
  readonly environment?: (name: string) => string | undefined;
  /** Test-only AgentRuntime injection. Production always uses PiCliRpcRuntime. */
  readonly agentRuntimeForTests?: AgentRuntime;
}

const READY_NOTICE = 'Controller is READY. 請重新傳送啟動期間的訊息。';
const ORCHESTRATION_FAILURES = new Set([
  'FLOW_STORAGE_INVALID',
  'FLOW_SCHEDULER_FAILED',
  'FLOW_RUNTIME_DISPOSED',
  'FLOW_EXECUTION_FAILED',
]);

export class ControllerService {
  readonly router: TelegramRouter;
  readonly runner: FlowRunner;
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
  private readonly flowStore: FlowStore;
  private readonly allowedUserId: string;
  private readonly abortController = new AbortController();
  private loops: Promise<void>[] = [];
  private startupTask: Promise<void> | null = null;
  private readyAtSec: number | null = null;
  private started = false;
  private stopping: Promise<void> | null = null;
  private fatal = false;

  constructor(
    config: ControllerConfig,
    resources: ControllerResources,
    telegram: TelegramClient,
    bundle: FlowBundle,
    options: ServiceOptions = {},
  ) {
    if (config.mode !== 'bot') {
      throw new TypeError('Bot configuration is required.');
    }
    assertFlowAuthConfiguration(bundle, config.piAuthFile);
    this.allowedUserId = config.allowedUserId;
    this.resources = resources;
    this.telegram = telegram;
    this.now = () => options.clock?.now() ?? Date.now();
    this.sleep = options.sleep ?? abortableSleep;
    this.logger = options.logger ?? consoleLogger;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.outboxIntervalMs = options.outboxIntervalMs ?? 100;

    const registry = new FlowRegistry(bundle);
    this.flowStore = new FlowStore(resources.store, registry, {
      now: this.now,
    });
    const agentRuntime =
      options.agentRuntimeForTests ??
      new PiCliRpcRuntime({
        dataDir: config.dataDir,
        flowStore: this.flowStore,
        ...(config.piAuthFile === undefined
          ? {}
          : { piAuthFile: config.piAuthFile }),
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      });
    const executor = new FlowExecutor(
      resources.store,
      this.flowStore,
      agentRuntime,
      { now: this.now },
    );
    this.runner = new FlowRunner(resources.store, this.flowStore, executor, {
      concurrency: config.concurrency,
      now: this.now,
      onError: (error) => {
        const code = safeClassification(error);
        if (ORCHESTRATION_FAILURES.has(code)) {
          this.failController(code);
        } else {
          this.logger.warn(`runner stopped: ${code}`);
        }
      },
    });
    this.router = new TelegramRouter(resources.store, config, {
      readyAtSec: () => this.readyAtSec ?? Number.MAX_SAFE_INTEGER,
      onSkipped: (classification) => {
        this.logger.warn(`update skipped: ${classification}`);
      },
      flowStore: this.flowStore,
    });
  }

  start(): void {
    if (this.started || this.stopping !== null) {
      throw new Error('Controller service has already started.');
    }
    this.flowStore.restartTerminateAll();
    this.readyAtSec = Math.floor(this.now() / 1000) + 1;
    this.started = true;
    this.startupTask = this.startAfterReady().catch(() => {
      if (!signalIsAborted(this.abortController.signal)) {
        this.failController('FLOW_STORAGE_INVALID');
      }
    });
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.stopping = this.stopInternal();
    return this.stopping;
  }

  private async startAfterReady(): Promise<void> {
    const signal = this.abortController.signal;
    const readyAtSec = this.readyAtSec;
    if (readyAtSec === null) return;
    while (!signal.aborted) {
      const remaining = readyAtSec * 1000 - this.now();
      if (remaining <= 0) break;
      await this.sleep(remaining, signal);
    }
    if (signalIsAborted(signal)) return;

    this.resources.store.transaction(() => {
      this.resources.store.reply(this.allowedUserId, READY_NOTICE);
    });
    if (signalIsAborted(signal)) return;
    this.loops = [this.pollLoop(), this.runnerLoop(), this.outboxLoop()].map(
      (loop) =>
        loop.catch(() => {
          if (!signalIsAborted(signal))
            this.failController('FLOW_STORAGE_INVALID');
        }),
    );
  }

  private async stopInternal(): Promise<void> {
    this.abortController.abort();
    const runnerStop = this.runner.stop().then(
      (): { readonly ok: true } => ({ ok: true }),
      (error: unknown): { readonly ok: false; readonly error: unknown } => ({
        ok: false,
        error,
      }),
    );
    await this.startupTask;
    await Promise.all(this.loops);
    const result = await runnerStop;
    await this.resources.close();
    if (!result.ok) throw result.error;
  }

  private async pollLoop(): Promise<void> {
    let attempts = 0;
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      try {
        const updates = await this.telegram.getUpdates(
          this.resources.store.getOffset(),
          signal,
        );
        for (const update of [...updates].sort(
          (left, right) => left.update_id - right.update_id,
        )) {
          if (signalIsAborted(signal)) return;
          this.router.handle(update);
        }
        if (updates.length === 0) await this.sleep(this.pollIntervalMs, signal);
        attempts = 0;
      } catch (error) {
        if (signalIsAborted(signal) || isAborted(error)) return;
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
    while (!signal.aborted) {
      try {
        this.runner.tick();
        attempts = 0;
        await this.sleep(100, signal);
      } catch (error) {
        if (signalIsAborted(signal) || isAborted(error)) return;
        const code = safeClassification(error);
        if (ORCHESTRATION_FAILURES.has(code)) {
          this.failController(code);
          return;
        }
        this.logger.warn(`runner retry: ${code}`);
        await this.backoff(attempts, error, signal);
        attempts += 1;
      }
    }
  }

  private async outboxLoop(): Promise<void> {
    let attempts = 0;
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      try {
        const due = this.resources.store.dueOutbox(this.now());
        if (due.length === 0) {
          await this.sleep(this.outboxIntervalMs, signal);
          attempts = 0;
          continue;
        }
        let sendableItems = 0;
        for (const item of due) {
          if (signalIsAborted(signal)) return;
          if (!this.resources.store.isOutboxSendable(item.id)) continue;
          sendableItems += 1;
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
            if (signalIsAborted(signal) || isAborted(error)) return;
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
        if (sendableItems === 0) {
          await this.sleep(this.outboxIntervalMs, signal);
        }
      } catch {
        if (signalIsAborted(signal)) return;
        this.failController('FLOW_STORAGE_INVALID');
        return;
      }
    }
  }

  private async backoff(
    attempts: number,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
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

function safeClassification(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'FLOW_EXECUTION_FAILED';
  }
  const candidates: string[] = [];
  if ('code' in error && typeof error.code === 'string') {
    candidates.push(error.code);
  }
  if (error instanceof Error) candidates.push(error.message);
  return (
    candidates.find((candidate) => ORCHESTRATION_FAILURES.has(candidate)) ??
    'FLOW_EXECUTION_FAILED'
  );
}

function isFatalTelegram(error: unknown): error is TelegramError {
  return (
    error instanceof TelegramError &&
    (error.kind === 'credential' || error.kind === 'conflict')
  );
}

function isAborted(error: unknown): boolean {
  return error instanceof TelegramError && error.kind === 'aborted';
}

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
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
