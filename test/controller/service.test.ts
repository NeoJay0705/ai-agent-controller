import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { ControllerService } from '../../src/controller/service.js';
import { openControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerStore } from '../../src/controller/store.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type { ServiceLogger } from '../../src/controller/types.js';
import {
  artifactsPath,
  createSession,
  ensureArtifactsDirectory,
  flushTasks,
  makeUpdate,
  testConfig,
  USER_ID,
  CHAT_ID,
} from './helpers.js';

const SECRET_URL = 'https://upstream.invalid/request?token=raw-secret';

class ManualClock {
  current = 1000;

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
      service.start();
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
      expect(new Set(methods)).toEqual(new Set(['getUpdates', 'sendMessage']));
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
      service.start();
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
      service.start();
      await pumpUntil(
        sleeper,
        () =>
          sendCount === 1 &&
          sleeper.hasDelay(2000) &&
          resources.store.database
            .prepare(
              "SELECT COUNT(*) AS count FROM outbox WHERE kind IN ('reply','ack')",
            )
            .get()?.count === 3,
      );
      const afterRateLimit = resources.store.database
        .prepare(
          "SELECT kind, status, attempts, next_attempt_at FROM outbox WHERE kind IN ('reply','ack') ORDER BY rowid",
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
            "SELECT kind, status, attempts, next_attempt_at FROM outbox WHERE kind IN ('reply','ack') ORDER BY rowid",
          )
          .all(),
      ).toEqual(afterRateLimit);
      expect(
        resources.store.database
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='reply'")
          .get(),
      ).toMatchObject({ count: 2 });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });

      clock.advanceTo(3000);
      sleeper.releaseDelay(2000);
      await pumpUntil(sleeper, () => sendCount === 5);
      expect(
        resources.store.database
          .prepare(
            "SELECT status, attempts, next_attempt_at FROM outbox WHERE kind='ack'",
          )
          .get(),
      ).toEqual({ status: 'PENDING', attempts: 1, next_attempt_at: 3500 });
      expect(
        resources.store.database
          .prepare(
            "SELECT status, attempts, next_attempt_at FROM outbox WHERE kind='reply' ORDER BY rowid LIMIT 1",
          )
          .get(),
      ).toEqual({ status: 'PENDING', attempts: 2, next_attempt_at: 4000 });
      expect(
        resources.store.database
          .prepare(
            "SELECT status, attempts FROM outbox WHERE kind='reply' ORDER BY rowid DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ status: 'DELIVERED', attempts: 1 });
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });

      clock.advanceTo(3500);
      await pumpUntil(
        sleeper,
        () =>
          sendCount === 6 &&
          resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='ack'")
            .get()?.status === 'DELIVERED',
      );
      clock.advanceTo(4000);
      await pumpUntil(
        sleeper,
        () =>
          sendCount === 7 &&
          resources.store.database
            .prepare(
              "SELECT COUNT(*) AS count FROM outbox WHERE status='PENDING'",
            )
            .get()?.count === 0,
      );
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        resources.store.statusForSession(USER_ID, CHAT_ID)?.[0],
      ).toMatchObject({
        status: 'COMPLETED',
        checkpoint: 3,
      });
      expect(sentBodies).toHaveLength(7);
      expect(new Set(methods)).toEqual(new Set(['getUpdates', 'sendMessage']));
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
      service.start();
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
      sendCount += 1;
      const body = bodyOf(init);
      const chatId = Number(body['chat_id']);
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
      service.start();
      await pumpUntil(
        sleeper,
        () =>
          sendCount === 2 &&
          resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='reply'")
            .get()?.status === 'PENDING' &&
          resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='ack'")
            .get()?.status === 'DELIVERED',
      );
      expect(
        resources.store.database
          .prepare(
            "SELECT attempts, next_attempt_at FROM outbox WHERE kind='reply'",
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
          sendCount === 3 &&
          resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='reply'")
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
      service.start();
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
        checkpoint: 3,
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
      let releaseFatal!: (response: Response) => void;
      const fatalKinds: string[] = [];
      let service: ControllerService | undefined;
      const fetcher: FetchLike = (input, init) => {
        const method = methodName(input);
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
            ...(status === 401
              ? {
                  onFatal: (classification: string) => {
                    fatalKinds.push(classification);
                  },
                }
              : {}),
          },
        );
        service.start();
        await pumpUntil(
          sleeper,
          () =>
            senderStarted &&
            resources.store.database
              .prepare('SELECT status FROM jobs LIMIT 1')
              .get()?.status === 'RUNNING',
        );
        expect(sleeper.hasDelay(10_000)).toBe(true);
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
          new Set(['getUpdates', 'sendMessage']),
        );

        const reopened = new ControllerStore(
          new DatabaseSync(join(dataDir, 'controller.sqlite')),
          { now: clock.now },
        );
        expect(
          reopened.database
            .prepare('SELECT status, checkpoint FROM jobs')
            .get(),
        ).toEqual({
          status: 'RUNNING',
          checkpoint: 0,
        });
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

  it('persists prompt delivery mapping and resumes the original Job after switching Session', async () => {
    await ensureArtifactsDirectory();
    const dataDir = dataDirectory('service-prompt-reply');
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      JOB_CONCURRENCY: '1',
      DEMO_STEP_MS: '1',
    });
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const resources = await openControllerResources(config, { now: clock.now });
    const methods: string[] = [];
    const updates = [
      makeUpdate(1, '/new prompt-session'),
      makeUpdate(2, '/queue ask: more input'),
    ];
    let sendCount = 0;
    let promptId = 0;
    let service: ControllerService | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      methods.push(method);
      if (method === 'getUpdates') return updateResponse(updates.splice(0));
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      sendCount += 1;
      const messageId = 11_000 + sendCount;
      if (
        typeof body['text'] === 'string' &&
        body['text'].includes('Please provide the missing input')
      ) {
        promptId = messageId;
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
        { clock, sleep: sleeper.sleep },
      );
      service.start();
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
      expect(
        resources.store.database
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt'")
          .get(),
      ).toMatchObject({ count: 1 });

      updates.push(
        makeUpdate(3, '/new other-session'),
        makeUpdate(4, 'additional details', { replyTo: promptId }),
      );
      await pumpUntil(
        sleeper,
        () =>
          resources.store.statusForJob(USER_ID, job.id)?.status ===
            'COMPLETED' &&
          resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='completed'")
            .get()?.status === 'DELIVERED',
      );
      expect(resources.store.selectedSession(USER_ID, CHAT_ID)?.name).toBe(
        'other-session',
      );
      expect(resources.store.statusForJob(USER_ID, job.id)).toMatchObject({
        id: job.id,
        status: 'COMPLETED',
        appliedSteering: ['additional details'],
        pendingSteering: 0,
      });
      const completion = resources.store.database
        .prepare("SELECT text FROM outbox WHERE kind='completed'")
        .get() as { text: string };
      expect(completion.text).toContain('Original input: ask: more input');
      expect(completion.text).toContain('additional details');
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(new Set(methods)).toEqual(new Set(['getUpdates', 'sendMessage']));
    } finally {
      await service?.stop();
      await removeDirectory(dataDir);
    }
  });
});
