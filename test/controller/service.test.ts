import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
  ControllerService as ProductionControllerService,
  type ServiceOptions,
} from '../../src/controller/service.js';
import { openControllerResources } from '../../src/controller/lifecycle.js';
import type { ControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerStore } from '../../src/controller/store.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type {
  ControllerConfig,
  ServiceLogger,
} from '../../src/controller/types.js';
import type { AgentNodeResult, AgentRuntime } from '../../src/flow/types.js';
import { loadFlowBundleConfig } from '../../src/flow/config-file.js';
import {
  artifactsPath,
  createSession,
  ensureArtifactsDirectory,
  flushTasks,
  makeUpdate,
  testConfig,
  testFlowBundle,
  UNSUPPORTED_AGENT_RUNTIME,
  USER_ID,
  CHAT_ID,
} from './helpers.js';
import { FakeAgentRuntime } from '../flow/helpers.js';

type BotConfig = Extract<ControllerConfig, { readonly mode: 'bot' }>;

class ControllerService extends ProductionControllerService {
  constructor(
    config: BotConfig,
    resources: ControllerResources,
    telegram: TelegramClient,
    options: ServiceOptions = {},
  ) {
    super(config, resources, telegram, testFlowBundle(), {
      ...options,
      agentRuntimeForTests:
        options.agentRuntimeForTests ?? UNSUPPORTED_AGENT_RUNTIME,
    });
  }
}

const SECRET_URL = 'https://upstream.invalid/request?token=raw-secret';

class ManualClock {
  current = 0;

  now = (): number => this.current;

  advanceTo(time: number): void {
    this.current = time;
  }
}

class ManualSleep {
  private readonly pending: Array<{
    readonly milliseconds: number;
    readonly finish: () => void;
  }> = [];

  sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', finish);
        const index = this.pending.findIndex((item) => item.finish === finish);
        if (index >= 0) this.pending.splice(index, 1);
        resolve();
      };
      this.pending.push({ milliseconds, finish });
      signal.addEventListener('abort', finish, { once: true });
    });
  };

  hasDelay(milliseconds: number): boolean {
    return this.pending.some((item) => item.milliseconds === milliseconds);
  }

  pendingDelays(): readonly number[] {
    return this.pending.map((item) => item.milliseconds);
  }

  releaseAtMost(maximum: number): void {
    for (const item of [...this.pending]) {
      if (item.milliseconds <= maximum) item.finish();
    }
  }

  releaseDelay(milliseconds: number): void {
    for (const item of [...this.pending]) {
      if (item.milliseconds === milliseconds) item.finish();
    }
  }
}

async function startService(
  service: ControllerService,
  clock: ManualClock,
  sleeper: ManualSleep,
): Promise<void> {
  service.start();
  const readyTime = Math.floor(clock.current / 1000) * 1000 + 1000;
  const delay = readyTime - clock.current;
  clock.advanceTo(readyTime);
  sleeper.releaseDelay(delay);
  await flushTasks();
}

function methodName(input: Parameters<FetchLike>[0]): string {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return new URL(url).pathname.split('/').at(-1) ?? '';
}

function bodyOf(init: Parameters<FetchLike>[1]): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON body.');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(result: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, result }), { status }),
  );
}

function updateResponse(result: unknown): Promise<Response> {
  return jsonResponse(result);
}

function testLogger(): ServiceLogger & {
  readonly messages: string[];
} {
  const messages: string[] = [];
  return {
    messages,
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
}

async function pumpUntil(
  sleep: ManualSleep,
  condition: () => boolean,
  maximumDelay = 100,
  attempts = 200,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return;
    sleep.releaseAtMost(maximumDelay);
    await flushTasks();
  }
  if (!condition())
    throw new Error(
      `Service condition was not reached in controlled turns; pending delays: ${sleep.pendingDelays().join(',')}.`,
    );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function dataDirectory(name: string): string {
  return artifactsPath(name).replace(/\.sqlite$/, '');
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe('controller service real loops', () => {
  it('requires Pi auth configuration even when a fake AgentRuntime is injected', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-pi-auth-required');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const resources = await openControllerResources(config);
    const bundle = await loadFlowBundleConfig(
      join(process.cwd(), 'config/pi-flow.oauth.example.json'),
    );
    try {
      expect(
        () =>
          new ProductionControllerService(
            config,
            resources,
            new TelegramClient(config.token, () => updateResponse([])),
            bundle,
            { agentRuntimeForTests: new FakeAgentRuntime() },
          ),
      ).toThrow('PI_FLOW_AUTH_FILE is required for pi-login authentication.');
    } finally {
      await resources.close();
      await removeDirectory(dataDir);
    }
  });

  it('sorts a polling batch and uses the committed offset on the next request', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-poll-order');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      JOB_CONCURRENCY: '1',
      DEMO_STEP_MS: '10000',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const offsets: number[] = [];
    const methods: string[] = [];
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      methods.push(method);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      methods.push(method);
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') {
        offsets.push(Number(bodyOf(init)['offset']));
        return offsets.length === 1
          ? updateResponse([
              makeUpdate(3, '/queue second'),
              makeUpdate(1, '/new ordered'),
              makeUpdate(2, '/queue first'),
            ])
          : updateResponse([]);
      }
      if (method === 'sendMessage') {
        return jsonResponse({
          message_id: 7000 + methods.length,
          chat: { id: Number(bodyOf(init)['chat_id']) },
        });
      }
      throw new Error(`Unexpected Telegram API method ${method}.`);
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        { clock, sleep: sleeper.sleep },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(
        sleeper,
        () =>
          resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 2 &&
          offsets.includes(4) &&
          methods.includes('sendMessage'),
      );

      expect(
        resources.store.database
          .prepare('SELECT input, sequence FROM jobs ORDER BY sequence')
          .all(),
      ).toEqual([
        { input: 'first', sequence: 1 },
        { input: 'second', sequence: 2 },
      ]);
      expect(
        resources.store.database
          .prepare('SELECT update_id FROM processed_updates ORDER BY update_id')
          .all(),
      ).toEqual([{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }]);
      expect(offsets.slice(0, 2)).toEqual([0, 4]);
      expect(new Set(methods)).toEqual(
        new Set(['getUpdates', 'sendMessage', 'getMe', 'setMyCommands']),
      );
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it('does not skip an update after a real router SQLite failure and retries with bounded backoff', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-router-retry');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      DEMO_STEP_MS: '10000',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    createSession(resources.store);
    resources.store.database.exec(`
      CREATE TRIGGER injected_router_fault BEFORE INSERT ON jobs
      BEGIN SELECT RAISE(ABORT, 'injected router database fault'); END;
    `);
    const logger = testLogger();
    const offsets: number[] = [];
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') {
        offsets.push(Number(bodyOf(init)['offset']));
        if (offsets.length === 1)
          return updateResponse([makeUpdate(55, '/queue retry me')]);
        if (offsets.length === 2) {
          resources.store.database.exec('DROP TRIGGER injected_router_fault');
          return updateResponse([makeUpdate(55, '/queue retry me')]);
        }
        return updateResponse([]);
      }
      if (method === 'sendMessage') {
        return jsonResponse({
          message_id: 8000,
          chat: { id: Number(bodyOf(init)['chat_id']) },
        });
      }
      throw new Error(`Unexpected Telegram API method ${method}.`);
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        { clock, sleep: sleeper.sleep, logger },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(sleeper, () => sleeper.hasDelay(500));
      expect(resources.store.getOffset()).toBe(0);
      expect(resources.store.isUpdateProcessed(55)).toBe(false);
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 0 });
      expect(offsets).toEqual([0]);

      sleeper.releaseAtMost(500);
      await pumpUntil(
        sleeper,
        () => resources.store.isUpdateProcessed(55) && offsets.includes(56),
      );
      expect(offsets.slice(0, 2)).toEqual([0, 0]);
      expect(resources.store.getOffset()).toBe(56);
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        resources.store.database
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE kind='queued'")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(logger.messages).toContain(
        'poll retry: storage or protocol error',
      );
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it('retries sender 429, network, and non-JSON 503 without creating another Job', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-sender-retry');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      DEMO_STEP_MS: '10',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const methods: string[] = [];
    const sentBodies: Array<Record<string, unknown>> = [];
    const offsets: number[] = [];
    let sendCount = 0;
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      methods.push(method);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      methods.push(method);
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') {
        offsets.push(Number(bodyOf(init)['offset']));
        if (offsets.length === 1) {
          return updateResponse([
            makeUpdate(1, '/new retry-session'),
            makeUpdate(2, '/queue keep-one-job'),
          ]);
        }
        if (offsets.length === 2)
          return updateResponse([makeUpdate(3, '/status')]);
        return updateResponse([]);
      }
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      if (
        typeof body['text'] === 'string' &&
        body['text'].includes('Controller is READY')
      ) {
        return jsonResponse({
          message_id: 8999,
          chat: { id: Number(body['chat_id']) },
        });
      }
      sentBodies.push(body);
      sendCount += 1;
      if (sendCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 429,
              parameters: { retry_after: 2 },
            }),
            { status: 429 },
          ),
        );
      }
      if (sendCount === 2) return Promise.reject(new Error(SECRET_URL));
      if (sendCount === 3)
        return Promise.resolve(new Response('invalid-json', { status: 503 }));
      return jsonResponse({
        message_id: 9000 + sendCount,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        { clock, sleep: sleeper.sleep },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(
        sleeper,
        () =>
          sendCount === 1 &&
          sleeper.hasDelay(2000) &&
          resources.store.database
            .prepare(
              "SELECT COUNT(*) AS count FROM outbox WHERE kind IN ('reply','ack') AND text NOT LIKE '%Controller is READY%'",
            )
            .get()?.count === 3,
      );
      const afterRateLimit = resources.store.database
        .prepare(
          "SELECT kind, status, attempts, next_attempt_at FROM outbox WHERE kind IN ('reply','ack') AND text NOT LIKE '%Controller is READY%' ORDER BY rowid",
        )
        .all();
      expect(afterRateLimit).toEqual([
        {
          kind: 'reply',
          status: 'PENDING',
          attempts: 1,
          next_attempt_at: 3000,
        },
        { kind: 'ack', status: 'PENDING', attempts: 0, next_attempt_at: 1000 },
        {
          kind: 'reply',
          status: 'PENDING',
          attempts: 0,
          next_attempt_at: 1000,
        },
      ]);
      await pumpUntil(
        sleeper,
        () =>
          resources.store.statusForSession(USER_ID, CHAT_ID)?.[0]?.status ===
          'COMPLETED',
      );
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        resources.store.database
          .prepare("SELECT status, attempts FROM outbox WHERE kind='completed'")
          .get(),
      ).toEqual({ status: 'PENDING', attempts: 0 });
      expect(sendCount).toBe(1);

      clock.advanceTo(2999);
      await flushTasks();
      expect(sendCount).toBe(1);
      expect(
        resources.store.database
          .prepare(
            "SELECT kind, status, attempts, next_attempt_at FROM outbox WHERE kind IN ('reply','ack') AND text NOT LIKE '%Controller is READY%' ORDER BY rowid",
          )
          .all(),
      ).toEqual(afterRateLimit);
      expect(
        resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE kind='reply' AND text NOT LIKE '%Controller is READY%'",
          )
          .get(),
      ).toMatchObject({ count: 2 });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });

      clock.advanceTo(3000);
      sleeper.releaseDelay(2000);
      for (let retry = 0; retry < 10; retry += 1) {
        const nextDue = resources.store.database
          .prepare(
            "SELECT MIN(next_attempt_at) AS next_attempt_at FROM outbox WHERE status='PENDING'",
          )
          .get() as { next_attempt_at: number | null };
        if (nextDue.next_attempt_at === null) break;
        clock.advanceTo(Math.max(clock.current, nextDue.next_attempt_at));
        sleeper.releaseAtMost(30_000);
        await pumpUntil(
          sleeper,
          () =>
            (
              resources.store.database
                .prepare(
                  "SELECT COUNT(*) AS count FROM outbox WHERE status='PENDING' AND next_attempt_at<=?",
                )
                .get(clock.current) as { count: number }
            ).count === 0,
        );
      }
      expect(
        resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE status='PENDING'",
          )
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        resources.store.statusForSession(USER_ID, CHAT_ID)?.[0],
      ).toMatchObject({ status: 'COMPLETED' });
      expect(sentBodies.length).toBeGreaterThanOrEqual(4);
      expect(new Set(methods)).toEqual(
        new Set(['getUpdates', 'sendMessage', 'getMe', 'setMyCommands']),
      );
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it('aborts the sender cooldown promptly during shutdown', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-cooldown-stop');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      DEMO_STEP_MS: '10000',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    let offsets = 0;
    let sendCount = 0;
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') {
        offsets += 1;
        return offsets === 1
          ? updateResponse([
              makeUpdate(1, '/new cooldown-stop'),
              makeUpdate(2, '/queue stop-during-cooldown'),
            ])
          : updateResponse([]);
      }
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      sendCount += 1;
      if (sendCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 429,
              parameters: { retry_after: 2 },
            }),
            { status: 429 },
          ),
        );
      }
      return jsonResponse({
        message_id: 12_000 + sendCount,
        chat: { id: Number(bodyOf(init)['chat_id']) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        { clock, sleep: sleeper.sleep },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(sleeper, () => sendCount === 1 && sleeper.hasDelay(2000));
      expect(
        resources.store.database
          .prepare("SELECT attempts FROM outbox WHERE kind='ack'")
          .get(),
      ).toMatchObject({ attempts: 0 });
      await expect(service.stop()).resolves.toBeUndefined();
      expect(sendCount).toBe(1);
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it('retries a mismatched sendMessage chat ID without marking the outbox delivered', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-mismatched-chat');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      DEMO_STEP_MS: '10000',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const logger = testLogger();
    let offsets = 0;
    let sendCount = 0;
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') {
        offsets += 1;
        return offsets === 1
          ? updateResponse([
              makeUpdate(1, '/new mismatch-session'),
              makeUpdate(2, '/queue do-not-duplicate'),
            ])
          : updateResponse([]);
      }
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      const chatId = Number(body['chat_id']);
      if (
        typeof body['text'] === 'string' &&
        body['text'].includes('Controller is READY')
      ) {
        return jsonResponse({
          message_id: 12_999,
          chat: { id: chatId },
        });
      }
      sendCount += 1;
      return jsonResponse({
        message_id: 13_000 + sendCount,
        chat: { id: chatId + (sendCount === 1 ? 1 : 0) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        { clock, sleep: sleeper.sleep, logger },
      );
      await startService(service, clock, sleeper);
      const mismatchReached = (): boolean =>
        sendCount === 2 &&
        resources.store.database
          .prepare(
            "SELECT status FROM outbox WHERE kind='reply' AND text NOT LIKE '%Controller is READY%'",
          )
          .get()?.status === 'PENDING' &&
        resources.store.database
          .prepare("SELECT status FROM outbox WHERE kind='ack'")
          .get()?.status === 'DELIVERED';
      try {
        await pumpUntil(sleeper, mismatchReached);
      } catch {
        const rows = resources.store.database
          .prepare(
            'SELECT kind, status, attempts, next_attempt_at, text FROM outbox ORDER BY rowid',
          )
          .all();
        throw new Error(
          `Mismatch delivery state: sendCount=${String(sendCount)}; offsets=${String(offsets)}; rows=${JSON.stringify(rows)}; logs=${JSON.stringify(logger.messages)}`,
        );
      }
      expect(
        resources.store.database
          .prepare(
            "SELECT attempts, next_attempt_at FROM outbox WHERE kind='reply' AND text NOT LIKE '%Controller is READY%'",
          )
          .get(),
      ).toEqual({ attempts: 1, next_attempt_at: 1500 });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(logger.messages).toContain('outbox retry: transient');

      clock.advanceTo(1500);
      await pumpUntil(
        sleeper,
        () =>
          sendCount >= 3 &&
          resources.store.database
            .prepare(
              "SELECT status FROM outbox WHERE kind='reply' AND text NOT LIKE '%Controller is READY%'",
            )
            .get()?.status === 'DELIVERED',
      );
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it('marks a blocked recipient delivery failed without rerunning its completed Job', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-blocked-recipient');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      DEMO_STEP_MS: '5',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const methods: string[] = [];
    let offsets = 0;
    let jobId: string | undefined;
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      methods.push(method);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      methods.push(method);
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') {
        offsets += 1;
        return offsets === 1
          ? updateResponse([
              makeUpdate(1, '/new blocked-session'),
              makeUpdate(2, '/queue finish-once'),
            ])
          : updateResponse([]);
      }
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      if (
        typeof body['text'] === 'string' &&
        body['text'].includes('Queued job ')
      ) {
        const matched = /Queued job ([^\n.]+)\./.exec(body['text']);
        jobId = matched?.[1];
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error_code: 403 }), {
            status: 403,
          }),
        );
      }
      return jsonResponse({
        message_id: 10_000 + methods.length,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        { clock, sleep: sleeper.sleep },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(
        sleeper,
        () =>
          jobId !== undefined &&
          resources.store.statusForJob(USER_ID, jobId)?.status ===
            'COMPLETED' &&
          resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='ack'")
            .get()?.status === 'FAILED',
      );
      expect(jobId).toBeDefined();
      expect(resources.store.statusForJob(USER_ID, jobId ?? '')).toMatchObject({
        status: 'COMPLETED',
      });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        resources.store.database
          .prepare("SELECT attempts FROM outbox WHERE kind='ack'")
          .get(),
      ).toMatchObject({ attempts: 1 });
      expect(methods).not.toContain('deleteWebhook');
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it.each([
    { status: 401, kind: 'credential' },
    { status: 409, kind: 'conflict' },
  ])(
    'fully stops polling, sender, runner, DB, and lock on fatal HTTP $status',
    async ({ status, kind }) => {
      await ensureArtifactsDirectory();
      const dataDir = dataDirectory(`service-fatal-${String(status)}`);
      const config = testConfig({
        CONTROLLER_DATA_DIR: dataDir,
        DEMO_STEP_MS: '10000',
      });
      const sleeper = new ManualSleep();
      const clock = new ManualClock();
      const resources = await openControllerResources(config, {
        now: clock.now,
      });
      const logger = testLogger();
      const methods: string[] = [];
      let pollCount = 0;
      let senderStarted = false;
      let agentStarted = false;
      const blockedRuntime: AgentRuntime = {
        run({ signal }) {
          agentStarted = true;
          return new Promise<AgentNodeResult>((_resolve, reject) => {
            const fail = (): void => {
              const error = new Error('FLOW_ABORTED') as Error & {
                code: string;
              };
              error.code = 'FLOW_ABORTED';
              reject(error);
            };
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener('abort', fail, { once: true });
          });
        },
        async dispose() {},
      };
      let releaseFatal!: (response: Response) => void;
      const fatalKinds: string[] = [];
      let service: ControllerService | undefined;
      const fetcher: FetchLike = (input, init) => {
        const method = methodName(input);
        methods.push(method);
        if (method === 'getMe')
          return jsonResponse({
            id: 123456,
            is_bot: true,
            first_name: 'Synthetic',
            username: 'synthetic_bot',
          });
        methods.push(method);
        if (method === 'setMyCommands') return jsonResponse(true);
        methods.push(method);
        if (method === 'getUpdates') {
          pollCount += 1;
          if (pollCount === 1) {
            return updateResponse([
              makeUpdate(1, '/new fatal-session'),
              makeUpdate(2, '/queue keep-running-checkpoint'),
            ]);
          }
          return new Promise<Response>((resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new Error(SECRET_URL));
              return;
            }
            releaseFatal = resolve;
            signal?.addEventListener(
              'abort',
              () => {
                reject(new Error(SECRET_URL));
              },
              { once: true },
            );
          });
        }
        if (method === 'sendMessage') {
          senderStarted = true;
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new Error(SECRET_URL));
              return;
            }
            signal?.addEventListener(
              'abort',
              () => {
                reject(new Error(SECRET_URL));
              },
              { once: true },
            );
          });
        }
        throw new Error(`Unexpected Telegram API method ${method}.`);
      };
      try {
        service = new ControllerService(
          config,
          resources,
          new TelegramClient(config.token, fetcher),
          {
            clock,
            sleep: sleeper.sleep,
            logger,
            agentRuntimeForTests: blockedRuntime,
            ...(status === 401
              ? {
                  onFatal: (classification: string) => {
                    fatalKinds.push(classification);
                  },
                }
              : {}),
          },
        );
        await startService(service, clock, sleeper);
        await pumpUntil(
          sleeper,
          () =>
            senderStarted &&
            agentStarted &&
            resources.store.database
              .prepare('SELECT status FROM jobs LIMIT 1')
              .get()?.status === 'RUNNING',
        );
        releaseFatal(new Response('invalid-json', { status }));
        await pumpUntil(sleeper, () =>
          logger.messages.includes(`controller stopped: ${kind}`),
        );
        await service.stop();

        expect(fatalKinds).toEqual(status === 401 ? ['credential'] : []);
        expect(await exists(join(dataDir, 'controller.lock'))).toBe(false);
        expect(logger.messages.join('\n')).not.toContain(config.token);
        expect(logger.messages.join('\n')).not.toContain(SECRET_URL);
        expect(methods).toContain('getUpdates');
        expect(methods).toContain('sendMessage');
        expect(methods).not.toContain('deleteWebhook');
        expect(new Set(methods)).toEqual(
          new Set(['getUpdates', 'sendMessage', 'getMe', 'setMyCommands']),
        );

        const reopened = new ControllerStore(
          new DatabaseSync(join(dataDir, 'controller.sqlite')),
          { now: clock.now },
        );
        expect(
          reopened.database.prepare('SELECT status FROM jobs').get(),
        ).toEqual({ status: 'RUNNING' });
        expect(
          reopened.database
            .prepare("SELECT status, attempts FROM outbox WHERE kind='ack'")
            .get(),
        ).toEqual({ status: 'PENDING', attempts: 0 });
        reopened.close();

        const replacement = await openControllerResources(config);
        await replacement.close();
      } finally {
        await service?.stop();
        await removeDirectory(dataDir);
      }
    },
  );

  it('sends valid notifications beyond more than 20 unsendable RUNNING prompts', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-running-stale-prompts');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      JOB_CONCURRENCY: '32',
      MAX_PENDING_JOBS: '100',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const updates = [
      makeUpdate(1, '/new active-worker'),
      makeUpdate(2, '/queue wait for stale prompt test'),
    ];
    const sentTexts: string[] = [];
    let workerStarted = false;
    let releaseWorker!: () => void;
    let resolveWorkerStarted!: () => void;
    const workerStartedTask = new Promise<void>((resolve) => {
      resolveWorkerStarted = resolve;
    });
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const runtime: AgentRuntime = {
      async run({ signal }) {
        workerStarted = true;
        resolveWorkerStarted();
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            signal.removeEventListener('abort', finish);
            resolve();
          };
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener('abort', finish, { once: true });
          void workerGate.then(finish);
        });
        if (signal.aborted) {
          const error = new Error('FLOW_ABORTED') as Error & { code: string };
          error.code = 'FLOW_ABORTED';
          throw error;
        }
        return {
          transition: 'ready',
          result: { suggestedFlow: null },
        };
      },
      async dispose() {},
    };
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') return updateResponse(updates.splice(0));
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      const text = typeof body['text'] === 'string' ? body['text'] : '';
      sentTexts.push(text);
      return jsonResponse({
        message_id: 15_000 + sentTexts.length,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        {
          clock,
          sleep: sleeper.sleep,
          agentRuntimeForTests: runtime,
        },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(sleeper, () => workerStarted);
      await workerStartedTask;

      for (let index = 0; index < 25; index += 1) {
        const ownerId = `stale-owner-${String(index)}`;
        const chatId = `stale-chat-${String(index)}`;
        const sessionId = resources.store.transaction(
          () =>
            resources.store.createSession(
              ownerId,
              chatId,
              `stale-${String(index)}`,
            ).id,
        );
        const jobId = resources.store.transaction(() =>
          resources.store.queueJob(ownerId, chatId, 'stale prompt job', 100),
        );
        resources.store.transaction(() => {
          resources.store.database
            .prepare("UPDATE outbox SET status='DELIVERED' WHERE session_id=?")
            .run(sessionId);
          resources.store.database
            .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
            .run(jobId);
          resources.store.enqueueJobNotification(
            jobId,
            'prompt',
            `stale running prompt ${String(index)}`,
            0,
          );
        });
      }
      resources.store.transaction(() => {
        resources.store.reply(
          CHAT_ID,
          'valid notification after stale prompts',
        );
      });

      await pumpUntil(sleeper, () =>
        sentTexts.includes('valid notification after stale prompts'),
      );
      expect(
        sentTexts.some((text) => text.includes('stale running prompt')),
      ).toBe(false);
      expect(
        resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt' AND text LIKE '%stale running prompt%' AND status='PENDING'",
          )
          .get(),
      ).toMatchObject({ count: 25 });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM outbox_cancellations')
          .get(),
      ).toMatchObject({ count: 0 });

      releaseWorker();
      await pumpUntil(
        sleeper,
        () =>
          resources.store.statusForSession(USER_ID, CHAT_ID)?.[0]?.status ===
          'COMPLETED',
      );
      await service.stop();
      expect(() => resources.store.getOffset()).toThrow();
    } finally {
      releaseWorker();
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it('sleeps cancellably when a stale due snapshot contains no sendable items', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-stale-snapshot-sleep');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const sentTexts: string[] = [];
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') return updateResponse([]);
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      const text = typeof body['text'] === 'string' ? body['text'] : '';
      sentTexts.push(text);
      return jsonResponse({
        message_id: 16_000 + sentTexts.length,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        {
          clock,
          sleep: sleeper.sleep,
          pollIntervalMs: 700,
          outboxIntervalMs: 300,
        },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(
        sleeper,
        () =>
          sentTexts.some((text) => text.includes('Controller is READY')) &&
          sleeper.hasDelay(300),
      );

      let dueSnapshots = 0;
      const staleSnapshot = {
        id: 'stale-snapshot-row',
        sessionId: null,
        jobId: 'stale-job',
        kind: 'prompt' as const,
        text: 'stale prompt snapshot',
        attempts: 0,
        chatId: CHAT_ID,
        promptGeneration: 0,
        deliveryClass: 'business' as const,
      };
      resources.store.dueOutbox = () => {
        dueSnapshots += 1;
        return [staleSnapshot];
      };
      sleeper.releaseDelay(300);
      await flushTasks();
      expect(dueSnapshots).toBe(1);
      for (let turn = 0; turn < 5; turn += 1) await flushTasks();
      expect(dueSnapshots).toBe(1);
      expect(sleeper.hasDelay(300)).toBe(true);

      await service.stop();
      expect(() => resources.store.getOffset()).toThrow();
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });

  it.each([
    {
      message: 'FLOW_STORAGE_INVALID',
      classification: 'FLOW_STORAGE_INVALID',
    },
    {
      message: 'FLOW_SCHEDULER_FAILED',
      classification: 'FLOW_SCHEDULER_FAILED',
    },
    {
      message: 'SYNTHETIC_UNSAFE_DETAILS',
      classification: 'FLOW_EXECUTION_FAILED',
    },
  ])(
    'uses only an orchestration allowlist for fatal callback classification',
    async ({ message, classification }) => {
      await ensureArtifactsDirectory();
      const dataDir = dataDirectory(
        `service-fatal-classification-${classification}`,
      );
      const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
      const sleeper = new ManualSleep();
      const clock = new ManualClock();
      const resources = await openControllerResources(config, {
        now: clock.now,
      });
      const logger = testLogger();
      const fatalKinds: string[] = [];
      let service: ControllerService | undefined;
      try {
        service = new ControllerService(
          config,
          resources,
          new TelegramClient(config.token, () => updateResponse([])),
          {
            clock,
            sleep: sleeper.sleep,
            logger,
            onFatal: (kind) => fatalKinds.push(kind),
          },
        );
        await startService(service, clock, sleeper);
        const reporter = service.runner as unknown as {
          report(code: string): void;
        };
        reporter.report(message);
        await pumpUntil(sleeper, () => fatalKinds.length > 0);
        expect(fatalKinds).toEqual([classification]);
        expect(logger.messages).not.toContain(message);
        expect(logger.messages).toContain(
          `controller stopped: ${classification}`,
        );
        await service.stop();
        expect(() => resources.store.getOffset()).toThrow();
      } finally {
        await service?.stop();
        await removeDirectory(dataDir);
      }
    },
  );

  it('closes resources after a runner dispose rejection and cancels the READY gate', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-stop-dispose-rejection');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const logger = testLogger();
    const fatalKinds: string[] = [];
    let service: ControllerService | undefined;
    const runtime: AgentRuntime = {
      run() {
        return Promise.reject(new Error('SYNTHETIC_RUN_FAILURE'));
      },
      dispose() {
        return Promise.reject(new Error('SYNTHETIC_DISPOSE_FAILURE'));
      },
    };
    const calls: string[] = [];
    const fetcher: FetchLike = (input) => {
      calls.push(methodName(input));
      return updateResponse([]);
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        {
          clock,
          sleep: sleeper.sleep,
          logger,
          agentRuntimeForTests: runtime,
          onFatal: (kind) => fatalKinds.push(kind),
        },
      );
      service.start();
      await flushTasks();
      await expect(service.stop()).rejects.toMatchObject({
        message: 'FLOW_RUNTIME_DISPOSED',
      });
      expect(fatalKinds).toEqual(['FLOW_RUNTIME_DISPOSED']);
      expect(calls).toEqual([]);
      expect(logger.messages.join('\n')).not.toContain(
        'SYNTHETIC_DISPOSE_FAILURE',
      );
      expect(await exists(join(dataDir, 'controller.lock'))).toBe(false);
      expect(() => resources.store.getOffset()).toThrow();
    } finally {
      await service?.stop().catch(() => undefined);
      await removeDirectory(dataDir);
    }
  });

  it('binds real prompt replies to the original Job after /use switches Session', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-prompt-reply');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      JOB_CONCURRENCY: '1',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const methods: string[] = [];
    const updates = [
      makeUpdate(1, '/new prompt-session'),
      makeUpdate(2, '/queue MBTI self-reflection'),
    ];
    let sendCount = 0;
    let promptId = 0;
    let questionPromptId = 0;
    let candidatePromptId = 0;
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      methods.push(method);
      if (method === 'getMe')
        return jsonResponse({
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        });
      methods.push(method);
      if (method === 'setMyCommands') return jsonResponse(true);
      if (method === 'getUpdates') return updateResponse(updates.splice(0));
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      sendCount += 1;
      const messageId = 11_000 + sendCount;
      if (typeof body['text'] === 'string') {
        if (body['text'].includes('請明確回覆 Flow ID')) promptId = messageId;
        if (body['text'].includes('以下是原創生活偏好題')) {
          questionPromptId = messageId;
        }
        if (body['text'].includes('解析候選')) candidatePromptId = messageId;
      }
      return jsonResponse({
        message_id: messageId,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, fetcher),
        {
          clock,
          sleep: sleeper.sleep,
          agentRuntimeForTests: new FakeAgentRuntime(),
        },
      );
      await startService(service, clock, sleeper);
      await pumpUntil(
        sleeper,
        () =>
          promptId > 0 &&
          resources.store.database
            .prepare('SELECT status FROM jobs LIMIT 1')
            .get()?.status === 'WAITING_INPUT',
      );
      const job = resources.store.database
        .prepare('SELECT id FROM jobs')
        .get() as { id: string };
      expect(resources.store.findPrompt(CHAT_ID, promptId)).toMatchObject({
        jobId: job.id,
        ownerId: USER_ID,
        active: true,
      });

      updates.push(makeUpdate(3, '/new other-session'));
      await pumpUntil(
        sleeper,
        () =>
          resources.store.selectedSession(USER_ID, CHAT_ID)?.name ===
          'other-session',
      );
      const otherSession = resources.store.selectedSession(USER_ID, CHAT_ID);
      if (otherSession === null) throw new Error('Expected the other Session.');
      updates.push(
        makeUpdate(4, `/use ${otherSession.id}`),
        makeUpdate(5, 'mbti', { replyTo: promptId }),
      );
      await pumpUntil(
        sleeper,
        () =>
          questionPromptId > 0 &&
          resources.store.statusForJob(USER_ID, job.id)?.status ===
            'WAITING_INPUT' &&
          resources.store
            .statusForJob(USER_ID, job.id)
            ?.appliedSteering.includes('mbti') === true,
      );
      expect(resources.store.selectedSession(USER_ID, CHAT_ID)?.id).toBe(
        otherSession.id,
      );
      expect(resources.store.statusForJob(USER_ID, job.id)).toMatchObject({
        id: job.id,
        status: 'WAITING_INPUT',
        appliedSteering: ['mbti'],
        pendingSteering: 0,
      });

      updates.push(
        makeUpdate(6, '1=2 2=0 3=null 4=1', { replyTo: questionPromptId }),
      );
      await pumpUntil(
        sleeper,
        () =>
          candidatePromptId > 0 &&
          resources.store
            .statusForJob(USER_ID, job.id)
            ?.appliedSteering.includes('1=2 2=0 3=null 4=1') === true,
      );
      expect(
        resources.store.findPrompt(CHAT_ID, questionPromptId),
      ).toMatchObject({
        jobId: job.id,
        ownerId: USER_ID,
        active: false,
      });
      expect(
        resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE kind='completed'",
          )
          .get(),
      ).toMatchObject({ count: 0 });
      expect(new Set(methods)).toEqual(
        new Set(['getUpdates', 'sendMessage', 'getMe', 'setMyCommands']),
      );
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });
});
