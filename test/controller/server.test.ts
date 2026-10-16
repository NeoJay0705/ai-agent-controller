import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/server.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type { ServiceLogger } from '../../src/controller/types.js';
import type { ControllerStore } from '../../src/controller/store.js';
import { MAX_FLOW_CONFIG_BYTES } from '../../src/flow/config.js';
import {
  artifactsPath,
  flushTasks,
  makeUpdate,
  TEST_TOKEN,
  USER_ID,
  UNSUPPORTED_AGENT_RUNTIME,
} from './helpers.js';

const FLOW_CONFIG_PATH = resolve(process.cwd(), 'config/pi-flow.example.json');
const OAUTH_CONFIG_PATH = resolve(
  process.cwd(),
  'config/pi-flow.oauth.example.json',
);
const CONFIG_FIXTURE_DIR = resolve(
  process.cwd(),
  '.test-artifacts/pi-flow/server-config',
);

async function ensureConfigFixtureDirectory(): Promise<void> {
  await mkdir(CONFIG_FIXTURE_DIR, { recursive: true, mode: 0o700 });
}

function openReadyGate(clock: ManualClock, sleeper: ManualSleep): void {
  const readyTime = Math.floor(clock.current / 1000) * 1000 + 1000;
  const delay = readyTime - clock.current;
  clock.current = readyTime;
  sleeper.releaseAtMost(delay);
}

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

function serviceStore(server: RunningServer): ControllerStore {
  if (server.service === undefined)
    throw new Error('Bot mode service is required.');
  return (
    server.service as unknown as {
      readonly resources: { readonly store: ControllerStore };
    }
  ).resources.store;
}

describe('HTTP server and controller wiring', () => {
  it('starts health mode without creating data or calling Telegram, and closes the listener', async () => {
    const dataPath = artifactsPath('server-health-no-data');
    const port = await availablePort();
    let fetchCalls = 0;
    let server: RunningServer | undefined;
    const healthEnvironment: Record<string, string | undefined> = {
      HOST: '127.0.0.1',
      PORT: String(port),
      CONTROLLER_DATA_DIR: dataPath,
    };
    Object.defineProperty(healthEnvironment, 'PI_FLOW_CONFIG', {
      get() {
        throw new Error('health mode must not read Flow config');
      },
    });
    Object.defineProperty(healthEnvironment, 'PI_FLOW_AUTH_FILE', {
      get() {
        throw new Error('health mode must not read Pi auth source');
      },
    });
    try {
      server = await startServer({
        env: healthEnvironment,
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
          PI_FLOW_CONFIG: FLOW_CONFIG_PATH,
        },
        fetcher,
        service: {
          clock,
          sleep: sleeper.sleep,
          pollIntervalMs: 100,
          outboxIntervalMs: 100,
          agentRuntimeForTests: UNSUPPORTED_AGENT_RUNTIME,
        },
      });
      openReadyGate(clock, sleeper);
      expect(server.config.mode).toBe('bot');
      expect(await pathExists(join(dataDir, 'controller.lock'))).toBe(true);
      const health = await server.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
      await pumpUntil(sleeper, () => jobId !== undefined && sendCount >= 2);
      const currentJobId = jobId;
      if (currentJobId === undefined)
        throw new Error('Queued Job ID was not sent.');

      updates.push(makeUpdate(3, `/status ${currentJobId}`));
      await pumpUntil(
        sleeper,
        () =>
          bodies.some(
            (body) =>
              typeof body['text'] === 'string' &&
              body['text'].includes(`Job ${currentJobId} — COMPLETED`),
          ) &&
          bodies.some(
            (body) =>
              typeof body['text'] === 'string' &&
              body['text'].includes('Flow: intake/unsupported'),
          ),
      );
      expect(methods).toContain('getUpdates');
      expect(methods).toContain('sendMessage');
      expect(new Set(methods)).toEqual(
        new Set(['getUpdates', 'sendMessage', 'getMe', 'setMyCommands']),
      );
      expect(methods).not.toContain('deleteWebhook');
      expect(
        bodies.some(
          (body) =>
            typeof body['text'] === 'string' &&
            body['text'].includes('目前沒有符合目標的已註冊能力'),
        ),
      ).toBe(true);
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

  it('fails bot startup closed for missing, invalid, and oversized Flow config before opening resources', async () => {
    await ensureConfigFixtureDirectory();
    const missing = join(CONFIG_FIXTURE_DIR, 'missing-flow-config.json');
    const invalid = join(CONFIG_FIXTURE_DIR, 'invalid-flow-config.json');
    const oversized = join(CONFIG_FIXTURE_DIR, 'oversized-flow-config.json');
    const privateRaw = '{"private":"DO_NOT_ECHO"';
    await writeFile(invalid, privateRaw, { mode: 0o600 });
    await writeFile(oversized, Buffer.alloc(MAX_FLOW_CONFIG_BYTES + 1, 0x20), {
      mode: 0o600,
    });
    const cases = [
      { name: 'missing', path: missing, code: 'FLOW_CONFIG_MISSING' },
      { name: 'invalid', path: invalid, code: 'FLOW_CONFIG_INVALID' },
      { name: 'oversized', path: oversized, code: 'FLOW_CONFIG_TOO_LARGE' },
    ] as const;
    for (const testCase of cases) {
      const dataDir = join(CONFIG_FIXTURE_DIR, `data-${testCase.name}`);
      let fetchCalls = 0;
      let failure: unknown;
      try {
        await startServer({
          env: {
            TELEGRAM_BOT_TOKEN: TEST_TOKEN,
            TELEGRAM_ALLOWED_USER_ID: USER_ID,
            PI_FLOW_CONFIG: testCase.path,
            CONTROLLER_DATA_DIR: dataDir,
            HOST: '127.0.0.1',
            PORT: '3000',
          },
          fetcher: () => {
            fetchCalls += 1;
            return Promise.reject(new Error('Telegram must not be called.'));
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: testCase.code,
        message: testCase.code,
      });
      expect((failure as Error).message).not.toContain(privateRaw);
      expect((failure as Error).message).not.toContain(testCase.path);
      expect(await pathExists(dataDir)).toBe(false);
      expect(fetchCalls).toBe(0);
    }
  });

  it('requires auth before resources for effective pi-login nodes and accepts full API-key Node overrides', async () => {
    await ensureConfigFixtureDirectory();
    const source = JSON.parse(await readFile(OAUTH_CONFIG_PATH, 'utf8')) as {
      schemaVersion: number;
      flows: Array<{
        runtime: Record<string, unknown>;
        nodes: Array<{ kind: string; runtime?: Record<string, unknown> }>;
      }>;
    };
    const apiKeyRuntime = {
      provider: 'openai',
      model: 'gpt-6-luna',
      thinking: 'max',
      apiKeyEnv: 'OPENAI_API_KEY',
      auth: { mode: 'api-key' },
    };
    const partial = structuredClone(source);
    const firstAgent = partial.flows[0]?.nodes.find(
      (node) => node.kind === 'agent',
    );
    if (firstAgent === undefined) throw new Error('Expected an Agent Node.');
    firstAgent.runtime = apiKeyRuntime;
    const partialPath = join(
      CONFIG_FIXTURE_DIR,
      'oauth-partial-node-override.json',
    );
    await writeFile(partialPath, JSON.stringify(partial), { mode: 0o600 });

    const cases = [
      { name: 'oauth-no-auth', configPath: OAUTH_CONFIG_PATH },
      { name: 'oauth-partial-node-override', configPath: partialPath },
    ] as const;
    for (const testCase of cases) {
      const dataDir = join(CONFIG_FIXTURE_DIR, `data-${testCase.name}`);
      const port = await availablePort();
      let fetchCalls = 0;
      let server: RunningServer | undefined;
      let failure: unknown;
      try {
        server = await startServer({
          env: {
            TELEGRAM_BOT_TOKEN: TEST_TOKEN,
            TELEGRAM_ALLOWED_USER_ID: USER_ID,
            PI_FLOW_CONFIG: testCase.configPath,
            CONTROLLER_DATA_DIR: dataDir,
            HOST: '127.0.0.1',
            PORT: String(port),
          },
          fetcher: () => {
            fetchCalls += 1;
            return Promise.reject(new Error('Telegram must not be called.'));
          },
        });
      } catch (error) {
        failure = error;
      } finally {
        await server?.close();
      }
      expect(failure).toMatchObject({
        message: 'PI_FLOW_AUTH_FILE is required for pi-login authentication.',
      });
      expect((failure as Error).message).not.toContain(testCase.configPath);
      expect(await pathExists(dataDir)).toBe(false);
      expect(await canConnect(port)).toBe(false);
      expect(fetchCalls).toBe(0);
    }

    const fullyOverridden = structuredClone(source);
    for (const flow of fullyOverridden.flows) {
      for (const node of flow.nodes) {
        if (node.kind === 'agent') node.runtime = apiKeyRuntime;
      }
    }
    const fullPath = join(CONFIG_FIXTURE_DIR, 'oauth-full-node-overrides.json');
    await writeFile(fullPath, JSON.stringify(fullyOverridden), { mode: 0o600 });
    const fullDataDir = join(CONFIG_FIXTURE_DIR, 'data-full-node-overrides');
    const fullPort = await availablePort();
    let fetchCalls = 0;
    let server: RunningServer | undefined;
    try {
      server = await startServer({
        env: {
          TELEGRAM_BOT_TOKEN: TEST_TOKEN,
          TELEGRAM_ALLOWED_USER_ID: USER_ID,
          PI_FLOW_CONFIG: fullPath,
          CONTROLLER_DATA_DIR: fullDataDir,
          HOST: '127.0.0.1',
          PORT: String(fullPort),
        },
        fetcher: () => {
          fetchCalls += 1;
          return Promise.reject(new Error('Telegram must not be called.'));
        },
      });
      expect(server.config.mode).toBe('bot');
      expect(server.config).not.toHaveProperty('piAuthFile');
      expect(fetchCalls).toBe(0);
    } finally {
      await server?.close();
      await rm(fullDataDir, { recursive: true, force: true });
    }
  });

  it('passes the configured auth source through production Server and Service to the real Pi runtime', async () => {
    await ensureConfigFixtureDirectory();
    const sourceDirectory = join(CONFIG_FIXTURE_DIR, 'synthetic-oauth-source');
    await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
    const authPath = join(sourceDirectory, 'auth.json');
    const rawSourceMarker = 'SYNTHETIC_MALFORMED_AUTH_SOURCE_MARKER';
    await writeFile(authPath, `{"synthetic":"${rawSourceMarker}"`, {
      mode: 0o600,
    });
    const dataDir = artifactsPath('server-production-oauth-wiring').replace(
      /\.sqlite$/,
      '',
    );
    const port = await availablePort();
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const updates = [
      makeUpdate(1, '/new oauth-source-session'),
      makeUpdate(2, '/queue invalid OAuth source'),
    ];
    const methods: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    let sendCount = 0;
    let server: RunningServer | undefined;
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
        throw new Error(`Unexpected fake Telegram method ${method}.`);
      const body = bodyOf(init);
      bodies.push(body);
      sendCount += 1;
      return jsonResponse({
        message_id: 20_000 + sendCount,
        chat: { id: Number(body['chat_id']) },
      });
    };
    try {
      server = await startServer({
        env: {
          TELEGRAM_BOT_TOKEN: TEST_TOKEN,
          TELEGRAM_ALLOWED_USER_ID: USER_ID,
          PI_FLOW_CONFIG: OAUTH_CONFIG_PATH,
          PI_FLOW_AUTH_FILE: authPath,
          CONTROLLER_DATA_DIR: dataDir,
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        fetcher,
        service: {
          clock,
          sleep: sleeper.sleep,
          pollIntervalMs: 100,
          outboxIntervalMs: 100,
        },
      });
      openReadyGate(clock, sleeper);
      const activeServer = server;
      let jobId: string | undefined;
      const queuedJob = (): string | undefined => {
        for (const body of bodies) {
          if (typeof body['text'] !== 'string') continue;
          const match = /Queued job ([^\n.]+)\./.exec(body['text']);
          if (match?.[1] !== undefined) return match[1];
        }
        return undefined;
      };
      await pumpUntil(sleeper, () => {
        jobId = queuedJob();
        return (
          jobId !== undefined &&
          serviceStore(activeServer).statusForJob(USER_ID, jobId)?.status ===
            'FAILED'
        );
      });
      jobId = queuedJob();
      if (jobId === undefined) throw new Error('Expected a queued Job.');
      const activeJobId = jobId;
      const store = serviceStore(activeServer);
      const status = store.statusForJob(USER_ID, activeJobId);
      expect(status).toMatchObject({
        status: 'FAILED',
        failureCode: 'FLOW_AUTH_SOURCE_INVALID',
      });

      updates.push(makeUpdate(3, `/status ${activeJobId}`));
      await pumpUntil(sleeper, () =>
        bodies.some(
          (body) =>
            typeof body['text'] === 'string' &&
            body['text'].includes(`Job ${activeJobId} — FAILED`),
        ),
      );
      const outboxTexts = store.database
        .prepare('SELECT text FROM outbox WHERE job_id=?')
        .all(activeJobId) as Array<{ text: string }>;
      const allPublicText = [
        ...bodies.map((body) => body['text']),
        ...outboxTexts.map((row) => row.text),
        JSON.stringify(status),
      ].join('\n');
      expect(allPublicText).toContain('FLOW_AUTH_SOURCE_INVALID');
      expect(allPublicText).not.toContain(rawSourceMarker);
      expect(allPublicText).not.toContain(authPath);
      expect(JSON.stringify(status)).not.toContain(rawSourceMarker);
      expect(JSON.stringify(status)).not.toContain(authPath);
      expect(methods).toContain('getUpdates');
      expect(methods).toContain('sendMessage');
      expect(methods).not.toContain('provider');
      expect(await pathExists(join(dataDir, 'pi'))).toBe(false);
      expect(await readFile(authPath, 'utf8')).toBe(
        `{"synthetic":"${rawSourceMarker}"`,
      );
    } finally {
      await server?.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('closes HTTP and controller when the external fatal callback throws', async () => {
    const dataDir = artifactsPath('server-fatal-callback').replace(
      /\.sqlite$/,
      '',
    );
    const port = await availablePort();
    const log = logger();
    const sleeper = new ManualSleep();
    const clock = new ManualClock();
    const originalExitCode = process.exitCode;
    const methods: string[] = [];
    let callbackCalls = 0;
    let server: RunningServer | undefined;
    const fetcher: FetchLike = (input) => {
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
      if (method !== 'getUpdates')
        throw new Error('Only getUpdates is expected before fatal shutdown.');
      return Promise.resolve(new Response('not-json', { status: 401 }));
    };
    try {
      server = await startServer({
        env: {
          TELEGRAM_BOT_TOKEN: TEST_TOKEN,
          TELEGRAM_ALLOWED_USER_ID: USER_ID,
          PI_FLOW_CONFIG: FLOW_CONFIG_PATH,
          CONTROLLER_DATA_DIR: dataDir,
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        fetcher,
        service: {
          clock,
          sleep: sleeper.sleep,
          logger: log,
          onFatal: () => {
            callbackCalls += 1;
            throw new Error(SECRET_URL);
          },
        },
      });
      openReadyGate(clock, sleeper);
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
      expect(methods).toContain('getUpdates');
      expect(methods).toContain('sendMessage');
      const store = serviceStore(server);
      expect(() => store.getOffset()).toThrow();
    } finally {
      await server?.close();
      process.exitCode = originalExitCode;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
