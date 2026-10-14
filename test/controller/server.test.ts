import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/server.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type { ServiceLogger } from '../../src/controller/types.js';
import {
  artifactsPath,
  flushTasks,
  makeUpdate,
  TEST_TOKEN,
  USER_ID,
} from './helpers.js';

const SECRET_URL = 'https://upstream.invalid/request?token=raw-secret';

class ManualClock {
  current = Date.now() + 1_000_000;

  now = (): number => this.current;
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

  releaseAtMost(maximum: number): void {
    for (const item of [...this.pending]) {
      if (item.milliseconds <= maximum) item.finish();
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

function logger(): ServiceLogger & { readonly messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return address.port;
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
    throw new Error('Server service condition was not reached.');
}

function serviceStore(server: RunningServer) {
  if (server.service === undefined)
    throw new Error('Bot mode service is required.');
  return (
    server.service as unknown as {
      readonly resources: {
        readonly store: {
          getOffset(): number;
        };
      };
    }
  ).resources.store;
}

describe('HTTP server and controller wiring', () => {
  it('starts health mode without creating data or calling Telegram, and closes the listener', async () => {
    const dataPath = artifactsPath('server-health-no-data');
    const port = await availablePort();
    let fetchCalls = 0;
    let server: RunningServer | undefined;
    try {
      server = await startServer({
        env: {
          HOST: '127.0.0.1',
          PORT: String(port),
          CONTROLLER_DATA_DIR: dataPath,
        },
        fetcher: () => {
          fetchCalls += 1;
          return Promise.reject(
            new Error('Telegram fetch must not run in health mode.'),
          );
        },
      });
      expect(server.config.mode).toBe('health');
      expect(await pathExists(dataPath)).toBe(false);
      expect(fetchCalls).toBe(0);
      const injected = await server.app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(injected.statusCode).toBe(200);
      expect(injected.json()).toEqual({ status: 'ok' });
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      await server.close();
      server = undefined;
      expect(await canConnect(port)).toBe(false);
      expect(fetchCalls).toBe(0);
      expect(await pathExists(dataPath)).toBe(false);
    } finally {
      await server?.close();
      await rm(dataPath, { recursive: true, force: true });
    }
  });

  it('routes Bot updates through the real sender and closes HTTP, SQLite, and its lock', async () => {
    const dataDir = artifactsPath('server-bot-wiring').replace(/\.sqlite$/, '');
    const port = await availablePort();
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const updates = [
      makeUpdate(1, '/new server-session'),
      makeUpdate(2, '/queue one-job'),
    ];
    const methods: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    let jobId: string | undefined;
    let sendCount = 0;
    let server: RunningServer | undefined;
    const fetcher: FetchLike = (input, init) => {
      const method = methodName(input);
      methods.push(method);
      if (method === 'getUpdates') return updateResponse(updates.splice(0));
      if (method !== 'sendMessage')
        throw new Error(`Unexpected Telegram API method ${method}.`);
      const body = bodyOf(init);
      bodies.push(body);
      sendCount += 1;
      if (typeof body['text'] === 'string') {
        const match = /Queued job ([^\n.]+)\./.exec(body['text']);
        if (match !== null) jobId = match[1];
      }
      return jsonResponse({
        message_id: 12_000 + sendCount,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      server = await startServer({
        env: {
          TELEGRAM_BOT_TOKEN: TEST_TOKEN,
          TELEGRAM_ALLOWED_USER_ID: USER_ID,
          CONTROLLER_DATA_DIR: dataDir,
          HOST: '127.0.0.1',
          PORT: String(port),
          DEMO_STEP_MS: '10000',
        },
        fetcher,
        service: {
          clock,
          sleep: sleeper.sleep,
          pollIntervalMs: 100,
          outboxIntervalMs: 100,
        },
      });
      expect(server.config.mode).toBe('bot');
      expect(await pathExists(join(dataDir, 'controller.lock'))).toBe(true);
      const health = await server.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
      await pumpUntil(sleeper, () => jobId !== undefined && sendCount >= 2);
      const currentJobId = jobId;
      if (currentJobId === undefined)
        throw new Error('Queued Job ID was not sent.');

      updates.push(
        makeUpdate(3, `/steer ${currentJobId} add context`),
        makeUpdate(4, `/status ${currentJobId}`),
      );
      await pumpUntil(
        sleeper,
        () =>
          bodies.some(
            (body) =>
              typeof body['text'] === 'string' &&
              body['text'].includes('Steering saved for job'),
          ) &&
          bodies.some(
            (body) =>
              typeof body['text'] === 'string' &&
              body['text'].includes('Steering: pending=1'),
          ),
      );
      expect(methods).toContain('getUpdates');
      expect(methods).toContain('sendMessage');
      expect(new Set(methods)).toEqual(new Set(['getUpdates', 'sendMessage']));
      expect(methods).not.toContain('deleteWebhook');
      expect(
        bodies.some(
          (body) =>
            typeof body['text'] === 'string' &&
            body['text'].includes(`Job ${currentJobId} — RUNNING`),
        ),
      ).toBe(true);

      sleeper.releaseAtMost(10_000);
      await pumpUntil(
        sleeper,
        () =>
          bodies.some(
            (body) =>
              typeof body['text'] === 'string' &&
              body['text'].includes('Completed. Original input: one-job') &&
              body['text'].includes('add context'),
          ),
        10_000,
      );
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(200);
      const store = serviceStore(server);
      await server.close();
      server = undefined;
      expect(() => store.getOffset()).toThrow();
      expect(await pathExists(join(dataDir, 'controller.lock'))).toBe(false);
      expect(await canConnect(port)).toBe(false);
    } finally {
      await server?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('closes HTTP and controller when the external fatal callback throws', async () => {
    const dataDir = artifactsPath('server-fatal-callback').replace(
      /\.sqlite$/,
      '',
    );
    const port = await availablePort();
    const log = logger();
    const originalExitCode = process.exitCode;
    const methods: string[] = [];
    let callbackCalls = 0;
    let server: RunningServer | undefined;
    const fetcher: FetchLike = (input) => {
      const method = methodName(input);
      methods.push(method);
      if (method !== 'getUpdates')
        throw new Error('Only getUpdates is expected before fatal shutdown.');
      return Promise.resolve(new Response('not-json', { status: 401 }));
    };
    try {
      server = await startServer({
        env: {
          TELEGRAM_BOT_TOKEN: TEST_TOKEN,
          TELEGRAM_ALLOWED_USER_ID: USER_ID,
          CONTROLLER_DATA_DIR: dataDir,
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        fetcher,
        service: {
          logger: log,
          onFatal: () => {
            callbackCalls += 1;
            throw new Error(SECRET_URL);
          },
        },
      });
      for (let attempt = 0; attempt < 200 && callbackCalls === 0; attempt += 1)
        await flushTasks();
      expect(callbackCalls).toBe(1);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!(await canConnect(port))) break;
        await flushTasks();
      }
      expect(await canConnect(port)).toBe(false);
      expect(await pathExists(join(dataDir, 'controller.lock'))).toBe(false);
      expect(log.messages).toContain('controller stopped: credential');
      expect(log.messages).toContain('fatal shutdown callback failed');
      expect(log.messages.join('\n')).not.toContain(TEST_TOKEN);
      expect(log.messages.join('\n')).not.toContain(SECRET_URL);
      expect(methods).toEqual(['getUpdates']);
      const store = serviceStore(server);
      expect(() => store.getOffset()).toThrow();
    } finally {
      await server?.close();
      process.exitCode = originalExitCode;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
