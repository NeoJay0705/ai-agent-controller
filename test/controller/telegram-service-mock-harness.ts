import { randomUUID } from 'node:crypto';
import { chmod, mkdir, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { AgentRuntime } from '../../src/flow/types.js';
import type {
  TelegramCommand,
  FetchLike,
} from '../../src/controller/telegram.js';
import { startServer, type RunningServer } from '../../src/server.js';

const ROOT = resolve(process.cwd());
const OWNER = 424242;
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const BOT_URL = 'https://api.telegram.org';
type Check = {
  name: string;
  status: 'unverified' | 'passed' | 'failed';
  detail?: string;
};
type Scenario = {
  name: string;
  status: 'unverified' | 'passed' | 'failed';
  checks: Check[];
};
type Sent = { messageId: number; chatId: number; text: string };
type Call = {
  method: string;
  offset?: number;
  allowed_updates?: unknown;
  timeout?: number;
  chatId?: number;
  scope?: unknown;
  commands?: unknown;
  success: boolean;
};
class HarnessCheckError extends Error {
  constructor(readonly safeLabel: string) {
    super(safeLabel);
    this.name = 'HarnessCheckError';
  }
}

type HarnessReport = {
  status: 'unverified' | 'passed' | 'failed';
  stage: 'running' | 'passed' | 'failed';
  runId: string;
  pid: number;
  controller: {
    host: string;
    port: number;
    healthStatus?: number;
    healthBody?: unknown;
  };
  mockTelegram: { host: string; port: number };
  scenarios: Scenario[];
  boundaries: string[];
  cleanup: Record<string, unknown>;
  artifacts: Record<string, string>;
  error?: string | { code: string; stage: string };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HarnessCheckError(message);
}
function json(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    'Expected JSON object request.',
  );
  return parsed as Record<string, unknown>;
}
function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolveListen(server.address() as AddressInfo);
    });
  });
}
function closeHttp(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((e) => {
      if (e) reject(e);
      else resolveClose();
    });
  });
}
function readClose(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => {
      resolveClose();
    });
  });
}
function availablePort(): Promise<number> {
  const server = createServer();
  return listen(server).then(async (address) => {
    await closeHttp(server);
    return address.port;
  });
}
function connectable(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once('error', () => {
      resolveConnect(false);
    });
  });
}
const wait = (ms = 20): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function waitFor<T>(
  label: string,
  predicate: () => T | null | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(20);
  }
  throw new HarnessCheckError(`Timed out waiting for ${label}.`);
}

class MockTelegram {
  readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      json(res, { ok: false, error_code: 400 }, 400);
    });
  });
  readonly updates: unknown[] = [];
  readonly calls: Call[] = [];
  readonly sent: Sent[] = [];
  readonly commands: Array<{
    chatId?: number;
    commands: unknown;
    attempt: number;
    success: boolean;
  }> = [];
  address!: AddressInfo;
  private nextUpdate = 1;
  private nextMessage = 1;
  private guest429 = true;
  async start(): Promise<void> {
    this.address = await listen(this.server);
  }
  inject(update: unknown): number {
    const id = this.nextUpdate++;
    this.updates.push({ update_id: id, ...(update as object) });
    return id;
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === 'POST' && req.url === '/test/inject') {
      const value = await body(req);
      const messages = value['messages'];
      if (Array.isArray(messages)) {
        const updateIds = (messages as unknown[]).map((message) =>
          this.inject({ message }),
        );
        json(res, { update_ids: updateIds });
      } else {
        const updateId = this.inject(value);
        json(res, { update_id: updateId });
      }
      return;
    }
    if (
      req.method !== 'POST' ||
      !req.url ||
      !['/getMe', '/getUpdates', '/sendMessage', '/setMyCommands'].includes(
        req.url,
      )
    ) {
      json(res, { ok: false, error_code: 404 }, 404);
      return;
    }
    const method = req.url.slice(1);
    const input = await body(req);
    if (method === 'getMe') {
      this.calls.push({ method, success: true });
      json(res, {
        ok: true,
        result: {
          id: 123456,
          is_bot: true,
          first_name: 'Synthetic',
          username: 'synthetic_bot',
        },
      });
      return;
    }
    if (method === 'getUpdates') {
      const offset = Number(input['offset']);
      const allowed = input['allowed_updates'];
      const timeout = Number(input['timeout']);
      this.calls.push({
        method,
        offset,
        allowed_updates: allowed,
        timeout,
        success: true,
      });
      for (let index = this.updates.length - 1; index >= 0; index--)
        if ((this.updates[index] as { update_id: number }).update_id < offset)
          this.updates.splice(index, 1);
      json(res, {
        ok: true,
        result: this.updates.filter(
          (update) => (update as { update_id: number }).update_id >= offset,
        ),
      });
      return;
    }
    if (method === 'sendMessage') {
      const chatId = Number(input['chat_id']);
      const text = String(input['text']);
      const sent = { messageId: this.nextMessage++, chatId, text };
      this.sent.push(sent);
      this.calls.push({ method, chatId, success: true });
      json(res, {
        ok: true,
        result: { message_id: sent.messageId, chat: { id: chatId } },
      });
      return;
    }
    const scope = input['scope'] as { chat_id?: number } | undefined;
    const chatId = scope?.chat_id;
    const attempt =
      this.commands.filter((item) => item.chatId === chatId).length + 1;
    if (chatId !== undefined && chatId !== OWNER && this.guest429) {
      this.guest429 = false;
      this.commands.push({
        chatId,
        commands: input['commands'],
        attempt,
        success: false,
      });
      this.calls.push({
        method,
        chatId,
        scope,
        commands: input['commands'],
        success: false,
      });
      json(
        res,
        { ok: false, error_code: 429, parameters: { retry_after: 1 } },
        429,
      );
      return;
    }
    this.commands.push({
      ...(chatId === undefined ? {} : { chatId }),
      commands: input['commands'],
      attempt,
      success: true,
    });
    this.calls.push({
      method,
      ...(chatId === undefined ? {} : { chatId }),
      scope,
      commands: input['commands'],
      success: true,
    });
    json(res, { ok: true, result: true });
  }
}

class FakeRuntime implements AgentRuntime {
  readonly jobs = new Map<
    string,
    { invokes: number; settled: number; aborted: number }
  >();
  readonly gates = new Map<
    string,
    { release: () => void; promise: Promise<void> }
  >();
  private pending = 0;
  run(
    input: Parameters<AgentRuntime['run']>[0],
  ): ReturnType<AgentRuntime['run']> {
    const counts = this.jobs.get(input.jobId) ?? {
      invokes: 0,
      settled: 0,
      aborted: 0,
    };
    counts.invokes++;
    this.jobs.set(input.jobId, counts);
    const budget = input.usageBudget;
    budget?.onRequestStarted(1);
    input.signal.addEventListener(
      'abort',
      () => {
        counts.aborted++;
      },
      { once: true },
    );
    let work: Promise<void>;
    if (input.input.includes('hold-running')) {
      let resolveGate!: () => void;
      let released = false;
      const promise = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      this.pending++;
      this.gates.set(input.jobId, {
        promise,
        release: () => {
          if (released) return;
          released = true;
          this.pending--;
          resolveGate();
        },
      });
      work = promise;
    } else {
      work = Promise.resolve();
    }
    return work.then(() => {
      budget?.onUsage(1, 7);
      budget?.onSettled(true);
      counts.settled++;
      return {
        transition: 'ready',
        result: {
          suggestedFlow: input.input.includes('queued-from-dialog')
            ? null
            : 'mbti',
        },
      };
    });
  }
  release(jobId: string): void {
    this.gates.get(jobId)?.release();
  }
  dispose(): Promise<void> {
    assert(this.pending === 0, 'Runtime dispose found pending gate.');
    return Promise.resolve();
  }
  get pendingGates(): number {
    return this.pending;
  }
  get allSettled(): boolean {
    return [...this.jobs.values()].every(
      (entry) => entry.settled === entry.invokes,
    );
  }
}

type DbRow = Record<string, unknown>;
async function runTelegramServiceMockAcceptance(): Promise<HarnessReport> {
  const runId = randomUUID();
  const outDir = join(ROOT, '.test-artifacts/telegram-mock-service', runId);
  const dataDir = join(outDir, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700);
  await chmod(dataDir, 0o700);
  const report: HarnessReport = {
    status: 'unverified',
    stage: 'running',
    runId,
    pid: process.pid,
    controller: { host: '127.0.0.1', port: 0 },
    mockTelegram: { host: '127.0.0.1', port: 0 },
    scenarios: [],
    boundaries: [
      'real ControllerService, TelegramRouter, SQLite, FlowRunner, FlowExecutor, outbox, menus and HTTP listeners',
      'Fake AgentRuntime only; no Pi child, provider, OAuth or Telegram network access',
    ],
    cleanup: {},
    artifacts: { directory: outDir },
  };
  const mock = new MockTelegram();
  const runtime = new FakeRuntime();
  let runningServer: RunningServer | undefined;
  let db: DatabaseSync | undefined;
  let controllerPort = 0;
  let mockStopped = false;
  let controllerClosed = false;
  const cleanupErrors: Array<{ code: string; stage: string }> = [];
  const sendCursor = (): number => mock.sent.length;
  const addScenario = (name: string): Scenario => {
    const scenario: Scenario = { name, status: 'unverified', checks: [] };
    report.scenarios.push(scenario);
    process.stdout.write(`[mock-service] START ${name}\n`);
    return scenario;
  };
  const check = async (
    scenario: Scenario,
    name: string,
    action: () => Promise<void> | void,
  ): Promise<void> => {
    const row: Check = { name, status: 'unverified' };
    scenario.checks.push(row);
    try {
      await action();
      row.status = 'passed';
    } catch (error) {
      row.status = 'failed';
      row.detail =
        error instanceof HarnessCheckError
          ? error.safeLabel
          : 'check failed (runtime-error)';
      scenario.status = 'failed';
      throw error;
    }
  };
  const complete = (s: Scenario): void => {
    if (s.status !== 'failed')
      s.status =
        s.checks.length > 0 &&
        s.checks.every((item) => item.status === 'passed')
          ? 'passed'
          : 'unverified';
    if (s.status === 'passed')
      process.stdout.write(`[mock-service] PASS ${s.name}\n`);
    else
      process.stdout.write(
        `[mock-service] FAIL ${s.name} report=${join(outDir, 'report.json')}\n`,
      );
  };
  const fetchJson = async (
    url: string,
    init?: RequestInit,
  ): Promise<{ response: Response; value: Record<string, unknown> }> => {
    const response = await fetch(url, init);
    const value = (await response.json()) as Record<string, unknown>;
    return { response, value };
  };
  const waitSent = async (
    cursor: number,
    match: (message: Sent) => boolean,
  ): Promise<Sent> =>
    waitFor('a newly delivered Telegram message', () =>
      mock.sent.slice(cursor).find(match),
    );
  let updateMessage = 0;
  const makeMessage = (
    userId: number,
    text: string,
    replyTo?: number,
  ): Record<string, unknown> => ({
    message_id: ++updateMessage,
    date: Math.floor((Date.now() + clockOffset) / 1000),
    chat: { id: userId, type: 'private' },
    from: { id: userId },
    text,
    ...(replyTo === undefined
      ? {}
      : { reply_to_message: { message_id: replyTo } }),
  });
  const waitCommitted = async (updateId: number): Promise<void> => {
    await waitFor(`SQLite offset to commit update ${String(updateId)}`, () => {
      const value = db
        ?.prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
        .get() as { value?: string } | undefined;
      return value && Number(value.value) > updateId ? value : null;
    });
  };
  const inject = async (
    userId: number,
    text: string,
    replyTo?: number,
  ): Promise<{ updateId: number; cursor: number }> => {
    const cursor = sendCursor();
    const message = makeMessage(userId, text, replyTo);
    const result = await fetchJson(
      `http://127.0.0.1:${String(mock.address.port)}/test/inject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      },
    );
    assert(result.response.status === 200, 'Mock injection HTTP failed.');
    const updateId = Number(result.value['update_id']);
    await waitCommitted(updateId);
    return { updateId, cursor };
  };
  const injectBatch = async (
    entries: readonly { userId: number; text: string }[],
  ): Promise<number[]> => {
    const messages = entries.map(({ userId, text }) =>
      makeMessage(userId, text),
    );
    const result = await fetchJson(
      `http://127.0.0.1:${String(mock.address.port)}/test/inject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      },
    );
    assert(result.response.status === 200, 'Mock batch injection HTTP failed.');
    const updateIds = result.value['update_ids'];
    assert(Array.isArray(updateIds), 'Mock batch injection omitted IDs.');
    return updateIds.map(Number);
  };
  const act = async (
    userId: number,
    text: string,
    pattern: RegExp,
    replyTo?: number,
  ): Promise<Sent> => {
    const { cursor } = await inject(userId, text, replyTo);
    return waitSent(
      cursor,
      (message) => message.chatId === userId && pattern.test(message.text),
    );
  };
  const query = <T extends DbRow = DbRow>(
    sql: string,
    ...params: (string | number)[]
  ): T[] => (db?.prepare(sql).all(...params) ?? []) as T[];
  const one = (sql: string, ...params: (string | number)[]): DbRow => {
    const row = db?.prepare(sql).get(...params);
    assert(row !== undefined, `SQLite row missing for ${sql}`);
    return row;
  };
  const job = (id: string): DbRow =>
    one('SELECT id,status,input,owner_id FROM jobs WHERE id=?', id);
  const status = async (id: string): Promise<string> =>
    String(
      (
        await act(OWNER, `/status ${id}`, new RegExp(`Job ${id} — `))
      ).text.match(new RegExp(`Job ${id} — ([A-Z_]+)`))?.[1],
    );
  const bumpClock = async (ms: number): Promise<void> => {
    clockOffset += ms;
    await wait(25);
  };
  let clockOffset = 0;
  try {
    await mock.start();
    report.mockTelegram = { host: '127.0.0.1', port: mock.address.port };
    controllerPort = await availablePort();
    const logger = {
      info(): void {},
      warn(): void {},
      error(): void {},
    };
    const fetcher: FetchLike = async (input, init) => {
      const raw =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw);
      assert(
        url.origin === BOT_URL && url.pathname.startsWith(`/bot${TOKEN}/`),
        'Telegram bridge rejected a non-synthetic URL.',
      );
      assert(
        init?.method === 'POST' &&
          ['getMe', 'getUpdates', 'sendMessage', 'setMyCommands'].includes(
            url.pathname.slice(`/bot${TOKEN}/`.length),
          ),
        'Telegram bridge rejected request method.',
      );
      const endpoint = url.pathname.slice(`/bot${TOKEN}/`.length);
      return fetch(
        `http://127.0.0.1:${String(mock.address.port)}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.signal === undefined ? {} : { signal: init.signal }),
        },
      );
    };
    runningServer = await startServer({
      cwd: ROOT,
      env: {
        HOST: '127.0.0.1',
        PORT: String(controllerPort),
        CONTROLLER_DATA_DIR: dataDir,
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_ALLOWED_USER_ID: String(OWNER),
        PI_FLOW_CONFIG: join(ROOT, 'config/pi-flow.example.json'),
        OPENAI_API_KEY: 'synthetic-unused-test-key',
      },
      fetcher,
      service: {
        agentRuntimeForTests: runtime,
        clock: { now: () => Date.now() + clockOffset },
        pollIntervalMs: 20,
        outboxIntervalMs: 20,
        logger,
      },
    });
    report.controller = {
      host: runningServer.config.host,
      port: runningServer.config.port,
    };
    db = new DatabaseSync(join(dataDir, 'controller.sqlite'), {
      readOnly: true,
    });
    const health = await fetchJson(
      `http://127.0.0.1:${String(controllerPort)}/health`,
    );
    report.controller.healthStatus = health.response.status;
    report.controller.healthBody = health.value;
    const startup = addScenario('startup/menus');
    await check(startup, 'real bot-mode HTTP health returns 200 and ok', () => {
      assert(
        health.response.status === 200 && health.value['status'] === 'ok',
        'Controller health failed.',
      );
    });
    await check(
      startup,
      'READY and default plus owner command menus are delivered',
      async () => {
        await waitSent(
          0,
          (m) => m.chatId === OWNER && m.text.includes('Controller is READY'),
        );
        await waitFor('default commands', () =>
          mock.commands.find((x) => x.chatId === undefined && x.success),
        );
        const owner = await waitFor('owner commands', () =>
          mock.commands.find((x) => x.chatId === OWNER && x.success),
        );
        const names = (owner.commands as TelegramCommand[]).map(
          (x) => x.command,
        );
        assert(
          ['cancel', 'allow', 'revoke', 'guests', 'invite'].every((x) =>
            names.includes(x),
          ),
          'Owner commands missing.',
        );
        const defaults = mock.commands.find((x) => x.chatId === undefined)
          ?.commands as TelegramCommand[];
        assert(
          JSON.stringify(defaults.map((x) => x.command)) ===
            JSON.stringify(['start', 'help']),
          'Default command names differ.',
        );
      },
    );
    await check(
      startup,
      'long polling uses the committed update offset and message options',
      () => {
        const poll = mock.calls.find((x) => x.method === 'getUpdates');
        assert(
          poll &&
            poll.offset !== undefined &&
            Array.isArray(poll.allowed_updates) &&
            JSON.stringify(poll.allowed_updates) === '["message"]' &&
            poll.timeout === 25,
          'Expected long poll options/offset.',
        );
      },
    );
    complete(startup);

    await bumpClock(61_000);
    const admin = addScenario('allow UX and guest menu retry');
    await check(
      admin,
      'allow guide, invalid input retention, grant, guests and guest new-session are routed over HTTP',
      async () => {
        await act(OWNER, '/allow', /Use \/allow/);
        assert(
          one(
            "SELECT command FROM command_dialogs WHERE user_id='424242' AND chat_id='424242'",
          ).command === 'allow',
          'Allow dialog missing.',
        );
        await act(OWNER, 'not-a-user', /Use \/allow/);
        assert(
          query("SELECT user_id FROM trial_users WHERE user_id='not-a-user'")
            .length === 0,
          'Invalid input granted access.',
        );
        await act(OWNER, '616161 1h', /Trial access granted to 616161/);
        assert(
          query("SELECT user_id FROM trial_users WHERE user_id='616161'")
            .length === 1,
          'Guest grant missing.',
        );
        assert(
          query("SELECT command FROM command_dialogs WHERE user_id='424242'")
            .length === 0,
          'Allow dialog not cleared.',
        );
        await act(OWNER, '/guests', /616161.*active/);
        await act(616161, '/new guest-session', /Session created and selected/);
        assert(
          query("SELECT id FROM sessions WHERE owner_id='616161'").length === 1,
          'Guest session not created.',
        );
      },
    );
    await check(
      admin,
      'guest management denial and retry-after menu registration retain grant',
      async () => {
        const guestScope = mock.commands.filter((x) => x.chatId === 616161);
        assert(
          guestScope.some((x) => !x.success),
          'Expected guest setMyCommands 429.',
        );
        await act(616161, '/allow 626262 1h', /Owner only/);
        assert(
          query("SELECT user_id FROM trial_users WHERE user_id='626262'")
            .length === 0,
          'Guest granted another user.',
        );
        await waitFor('guest menu retry after one second', () =>
          mock.commands.find((x) => x.chatId === 616161 && x.success),
        );
        const commands = mock.commands.find(
          (x) => x.chatId === 616161 && x.success,
        )?.commands as TelegramCommand[];
        const names = commands.map((x) => x.command);
        assert(
          names.includes('queue') &&
            names.includes('cancel') &&
            !['allow', 'revoke', 'guests', 'invite'].some((x) =>
              names.includes(x),
            ),
          'Guest menu role incorrect.',
        );
      },
    );
    complete(admin);

    await bumpClock(61_000);
    const ux = addScenario('command UX');
    await check(
      ux,
      'new dialogue survives unknown command and clears after user text',
      async () => {
        await act(OWNER, '/new', /Use \/new/);
        await act(OWNER, '/unknown', /Unknown command/);
        assert(
          one("SELECT command FROM command_dialogs WHERE user_id='424242'")
            .command === 'new',
          'Unknown command cleared dialog.',
        );
        await act(OWNER, 'ux-main', /Session created and selected/);
        assert(
          query("SELECT command FROM command_dialogs WHERE user_id='424242'")
            .length === 0,
          'New dialog remained.',
        );
      },
    );
    await check(
      ux,
      'ordinary text, queue dialogue and status route without unwanted Jobs',
      async () => {
        const before = query('SELECT id FROM jobs').length;
        await act(OWNER, 'ordinary-no-context', /Use \/queue/);
        assert(
          query('SELECT id FROM jobs').length === before,
          'Ordinary text created Job.',
        );
        await act(OWNER, '/queue', /Use \/queue/);
        await act(OWNER, 'queued-from-dialog', /Queued job/);
        const row = one(
          "SELECT id,status FROM jobs WHERE input='queued-from-dialog'",
        );
        assert(
          row.status === 'COMPLETED' ||
            row.status === 'RUNNING' ||
            row.status === 'QUEUED',
          'Job row invalid.',
        );
        await waitFor(
          'queue runtime completion',
          () =>
            query(
              "SELECT id FROM jobs WHERE input='queued-from-dialog' AND status='COMPLETED'",
            )[0],
        );
        const invokes = [...runtime.jobs.values()].reduce(
          (n, j) => n + j.invokes,
          0,
        );
        await status(String(row.id));
        assert(
          [...runtime.jobs.values()].reduce((n, j) => n + j.invokes, 0) ===
            invokes,
          'Status invoked AgentRuntime.',
        );
      },
    );
    await check(
      ux,
      'use session and steer usage are validated; help clears dialog only',
      async () => {
        const sid = String(
          one(
            "SELECT id FROM sessions WHERE owner_id='424242' ORDER BY created_at LIMIT 1",
          ).id,
        );
        await act(OWNER, '/new other', /Session created/);
        await act(OWNER, '/use', /Use \/use/);
        await act(OWNER, sid, /Selected session/);
        assert(
          query("SELECT command FROM command_dialogs WHERE user_id='424242'")
            .length === 0,
          'Use dialog remained.',
        );
        await bumpClock(61_000);
        await act(OWNER, '/steer', /Use \/steer/);
        await act(OWNER, '/help', /Use \/queue/);
        assert(
          query("SELECT command FROM command_dialogs WHERE user_id='424242'")
            .length === 0,
          'Help dialog not cleared.',
        );
      },
    );
    complete(ux);

    await bumpClock(61_000);
    const cancel = addScenario('QUEUED/WAITING cancel and cancel UX');
    let waitingId = '';
    let waitingPromptId = 0;
    await check(
      cancel,
      'queue A reaches WAITING_INPUT and B stays queued then cancels',
      async () => {
        await act(OWNER, '/new cancel-session', /Session created/);
        await act(OWNER, '/queue ask:first', /Queued job/);
        waitingId = String(
          one("SELECT id FROM jobs WHERE input='ask:first'").id,
        );
        await waitFor(
          'A wait status',
          () =>
            query(
              "SELECT id FROM jobs WHERE id=? AND status='WAITING_INPUT'",
              waitingId,
            )[0],
        );
        const binding = await waitFor(
          'A prompt binding delivered',
          () =>
            query(
              'SELECT message_id FROM prompt_bindings WHERE job_id=? AND active=1',
              waitingId,
            )[0],
        );
        waitingPromptId = Number(binding.message_id);
        const prompt = await waitFor('A prompt delivered', () =>
          mock.sent.find((m) => m.messageId === waitingPromptId),
        );
        assert(
          prompt.text.includes('請明確回覆 Flow ID') &&
            /mbti|natal/i.test(prompt.text),
          'A prompt did not contain the expected flow choice.',
        );
        await act(OWNER, '/queue queued-B', /Queued job/);
        const b = String(one("SELECT id FROM jobs WHERE input='queued-B'").id);
        assert(job(b).status === 'QUEUED', 'B did not remain queued.');
        await act(OWNER, `/cancel ${b}`, new RegExp(`Job ${b}: CANCELLED`));
        assert(
          job(b).status === 'CANCELLED' &&
            (runtime.jobs.get(b)?.invokes ?? 0) === 0,
          'Queued B ran or was not cancelled.',
        );
      },
    );
    await check(
      cancel,
      'cancel dialogue supersedes queue and stale prompt reply is inert',
      async () => {
        await act(OWNER, '/queue', /Use \/queue/);
        await act(OWNER, '/cancel', /Send a Job ID to cancel/);
        assert(
          one("SELECT command FROM command_dialogs WHERE user_id='424242'")
            .command === 'cancel',
          'Cancel dialogue not selected.',
        );
        await act(OWNER, waitingId, new RegExp(`Job ${waitingId}: CANCELLED`));
        assert(
          job(waitingId).status === 'CANCELLED',
          'WAITING Job not cancelled.',
        );
        const priorJobs = query('SELECT id FROM jobs').length;
        const stale = await act(
          OWNER,
          'late reply',
          /no longer active/,
          waitingPromptId,
        );
        assert(
          stale.text.includes('That question is no longer active.'),
          'Stale prompt response differed.',
        );
        assert(
          query('SELECT id FROM jobs').length === priorJobs,
          'Stale prompt created Job.',
        );
        await act(
          OWNER,
          `/cancel ${waitingId}`,
          new RegExp(`Job ${waitingId}: CANCELLED`),
        );
      },
    );
    complete(cancel);

    await bumpClock(61_000);
    const runningCancellation = addScenario(
      'RUNNING cancellation settles before terminal',
    );
    let held = '';
    await check(
      runningCancellation,
      'running cancellation signals abort, waits to settle, preserves revision and releases next Job',
      async () => {
        await act(OWNER, '/allow 717171 1h', /Trial access granted/);
        await act(717171, '/new run-a', /Session created/);
        await act(717171, '/queue hold-running', /Queued job/);
        held = String(one("SELECT id FROM jobs WHERE input='hold-running'").id);
        await waitFor(
          'held runtime entered',
          () => runtime.jobs.get(held)?.invokes === 1,
        );
        assert(job(held).status === 'RUNNING', 'Held Job not RUNNING.');
        const startCounts = query(
          'SELECT state,total_tokens FROM trial_usage_operations WHERE job_id=?',
          held,
        )[0];
        await act(
          717171,
          `/cancel ${held}`,
          new RegExp(`Job ${held}: CANCELLING`),
        );
        assert(
          job(held).status === 'CANCELLING',
          'Cancel acknowledgement did not set CANCELLING.',
        );
        await waitFor(
          'Runner signals cancellation abort',
          () => (runtime.jobs.get(held)?.aborted ?? 0) > 0,
        );
        assert(
          job(held).status === 'CANCELLING' &&
            (runtime.jobs.get(held)?.aborted ?? 0) > 0,
          'Abort was not signalled.',
        );
        const revision = one(
          'SELECT revision FROM flow_runs WHERE job_id=?',
          held,
        ).revision;
        await act(
          717171,
          `/status ${held}`,
          new RegExp(`Job ${held} — CANCELLING`),
        );
        await act(717171, '/new run-b', /Session created/);
        await act(717171, '/queue next', /Queued job/);
        const next = String(one("SELECT id FROM jobs WHERE input='next'").id);
        await wait(100);
        assert(
          job(held).status === 'CANCELLING' &&
            job(next).status === 'QUEUED' &&
            (runtime.jobs.get(next)?.invokes ?? 0) === 0,
          'Cancellation did not hold scheduler slot.',
        );
        runtime.release(held);
        await waitFor(
          'settled cancellation',
          () =>
            query(
              "SELECT id FROM jobs WHERE id=? AND status='CANCELLED'",
              held,
            )[0],
        );
        await waitFor(
          'next job enters wait state',
          () =>
            query(
              "SELECT id FROM jobs WHERE id=? AND status='WAITING_INPUT'",
              next,
            )[0],
        );
        assert(
          one('SELECT revision FROM flow_runs WHERE job_id=?', held)
            .revision === revision,
          'Late result changed flow revision.',
        );
        assert(
          query(
            "SELECT id FROM outbox WHERE job_id=? AND kind='completed'",
            held,
          ).length === 0,
          'Cancellation emitted completion.',
        );
        const usage = one(
          'SELECT state,total_tokens FROM trial_usage_operations WHERE job_id=?',
          held,
        );
        assert(
          usage.state === 'complete' &&
            Number(usage.total_tokens) === 7 &&
            startCounts !== undefined,
          'Usage was not settled/charged.',
        );
      },
    );
    complete(runningCancellation);

    await bumpClock(61_000);
    const isolation = addScenario('isolation and Owner management');
    await check(
      isolation,
      'third guest cannot cancel/read private Job and cancel list is isolated',
      async () => {
        await act(OWNER, '/allow 818181 1h', /Trial access granted/);
        await act(OWNER, '/queue owner-private-marker', /Queued job/);
        const privateJob = String(
          one("SELECT id FROM jobs WHERE input='owner-private-marker'").id,
        );
        await act(818181, '/new third', /Session created/);
        await act(818181, `/cancel ${privateJob}`, /Job not found/);
        assert(
          job(privateJob).status !== 'CANCELLED',
          'Other owner Job was cancelled.',
        );
        const noArg = await act(
          818181,
          '/cancel',
          /No cancellable jobs|Send a Job ID/,
        );
        assert(
          !noArg.text.includes(privateJob) &&
            !noArg.text.includes('owner-private-marker'),
          'Cancel list leaked private Job.',
        );
      },
    );
    await check(
      isolation,
      'Owner cancellation does not grant private status and revoke resets menus',
      async () => {
        const ownJob = String(
          one(
            "SELECT id FROM jobs WHERE owner_id='717171' ORDER BY created_at DESC LIMIT 1",
          ).id,
        );
        await act(OWNER, `/cancel ${ownJob}`, new RegExp(`Job ${ownJob}:`));
        await act(OWNER, `/status ${ownJob}`, /Job not found/);
        await act(OWNER, '/revoke 616161', /Trial access revoked/);
        await waitFor('revoked default menu', () =>
          mock.commands.find(
            (x) =>
              x.chatId === 616161 &&
              x.success &&
              JSON.stringify(
                (x.commands as TelegramCommand[]).map((c) => c.command),
              ) === '["start","help"]',
          ),
        );
        const jobsBefore = query('SELECT id FROM jobs').length;
        const runtimeBefore = [...runtime.jobs.values()].reduce(
          (total, item) => total + item.invokes,
          0,
        );
        const sentBefore = sendCursor();
        const pollsBefore = mock.calls.filter(
          (call) => call.method === 'getUpdates',
        ).length;
        const { updateId } = await inject(616161, '/queue denied-after-revoke');
        await waitFor('revoked guest poll turns', () => {
          const polls = mock.calls.filter(
            (call) => call.method === 'getUpdates',
          ).length;
          return polls >= pollsBefore + 3 ? polls : null;
        });
        assert(
          Number(
            one("SELECT value FROM meta WHERE key='next_poll_offset'").value,
          ) > updateId,
          'Revoked guest update was not committed.',
        );
        assert(
          query("SELECT id FROM jobs WHERE input='denied-after-revoke'")
            .length === 0 && query('SELECT id FROM jobs').length === jobsBefore,
          'Revoked guest created Job.',
        );
        assert(
          [...runtime.jobs.values()].reduce(
            (total, item) => total + item.invokes,
            0,
          ) === runtimeBefore,
          'Revoked guest invoked AgentRuntime.',
        );
        assert(
          !mock.sent
            .slice(sentBefore)
            .some((message) => message.text.includes('denied-after-revoke')),
          'Revoked guest received a business reply.',
        );
      },
    );
    complete(isolation);

    await bumpClock(61_000);
    const invite = addScenario('invitation redemption and expiry loop');
    await check(
      invite,
      'two invite redeemers yield one trial and generated link is synthetic',
      async () => {
        const sent = await act(
          OWNER,
          '/invite 10m 5s',
          /https:\/\/t\.me\/synthetic_bot\?start=/,
        );
        const code = sent.text.match(/start=([A-Za-z0-9_-]{43})/)?.[1];
        assert(code, 'Invite link omitted token.');
        const codeUrl = `/start ${code}`;
        const batchIds = await injectBatch([
          { userId: 919191, text: codeUrl },
          { userId: 929292, text: codeUrl },
        ]);
        const lastUpdateId = batchIds.at(-1);
        assert(lastUpdateId !== undefined, 'Invite update batch was empty.');
        await waitCommitted(lastUpdateId);
        await waitFor(
          'single redeemed invite',
          () =>
            query(
              "SELECT user_id FROM trial_users WHERE user_id IN ('919191','929292')",
            ).length === 1,
        );
        const winner = String(
          one(
            "SELECT user_id FROM trial_users WHERE user_id IN ('919191','929292')",
          ).user_id,
        );
        assert(
          query("SELECT user_id FROM trial_users WHERE user_id='919191'")
            .length === 1 &&
            query("SELECT user_id FROM trial_users WHERE user_id='929292'")
              .length === 0,
          'Expected first invite redeemer to win.',
        );
        assert(
          Number(
            one('SELECT used_by FROM trial_invites WHERE used_by=919191')
              .used_by,
          ) === 919191 &&
            query('SELECT used_by FROM trial_invites WHERE used_by=929292')
              .length === 0,
          'Invite used_by did not match first redeemer.',
        );
        assert(
          query(
            "SELECT user_id FROM trial_users WHERE user_id IN ('919191','929292')",
          ).length === 1,
          'Invite redeemed more than once.',
        );
        await act(Number(winner), '/new invite-winner', /Session created/);
        await act(Number(winner), '/queue ask:invite-wait', /Queued job/);
        await waitFor(
          'invite winner waiting',
          () =>
            query(
              "SELECT id FROM jobs WHERE input='ask:invite-wait' AND status='WAITING_INPUT'",
            )[0],
        );
        assert(
          sent.text.includes('synthetic_bot'),
          'Invite host was not synthetic.',
        );
      },
    );
    await check(
      invite,
      'expiry loop revokes trial and cancels waiting Job without a new update',
      async () => {
        const expiredJob = one(
          "SELECT id,owner_id FROM jobs WHERE input='ask:invite-wait'",
        );
        const win = Number(expiredJob.owner_id);
        const expiredJobId = String(expiredJob.id);
        const expirySendCursor = sendCursor();
        await bumpClock(6_000);
        await waitFor(
          'trial expiry loop cancellation',
          () =>
            query(
              "SELECT id FROM jobs WHERE input='ask:invite-wait' AND status='CANCELLED'",
            )[0],
        );
        assert(
          query('SELECT update_id FROM processed_updates').length >= 1,
          'No processed updates.',
        );
        assert(
          one('SELECT revoked_at FROM trial_users WHERE user_id=?', String(win))
            .revoked_at !== null,
          'Expired trial was not revoked.',
        );
        assert(
          job(expiredJobId).status === 'CANCELLED',
          'Expiry did not cancel the waiting Job.',
        );
        const expiryNotice = await waitSent(
          expirySendCursor,
          (message) =>
            message.chatId === win &&
            message.text.includes(`Job ${expiredJobId}`) &&
            message.text.includes('Job cancelled (TRIAL_EXPIRED).'),
        );
        assert(
          expiryNotice.chatId === win &&
            job(expiredJobId).status === 'CANCELLED',
          `Expiry notification did not match winner Job ${expiredJobId}.`,
        );
        await waitFor('revoked winner default menu', () =>
          mock.commands.find(
            (item) =>
              item.chatId === win &&
              item.success &&
              JSON.stringify(
                (item.commands as TelegramCommand[]).map(
                  (command) => command.command,
                ),
              ) === '["start","help"]',
          ),
        );
      },
    );
    complete(invite);
  } catch (error) {
    report.status = 'failed';
    report.stage = 'failed';
    report.error =
      error instanceof HarnessCheckError
        ? error.safeLabel
        : { code: 'HARNESS_RUNTIME_ERROR', stage: 'scenario-execution' };
    const last = report.scenarios.at(-1);
    if (last) {
      if (last.status !== 'failed') {
        last.status = 'failed';
        const unverified = last.checks.find(
          (item) => item.status === 'unverified',
        );
        if (unverified) {
          unverified.status = 'failed';
          unverified.detail =
            error instanceof HarnessCheckError
              ? error.safeLabel
              : 'scenario failed (runtime-error)';
        }
      }
      process.stdout.write(
        `[mock-service] FAIL ${last.name} report=${join(outDir, 'report.json')}\n`,
      );
    }
  } finally {
    for (const gate of runtime.gates.values()) gate.release();
    const attemptCleanup = async (
      stage: string,
      action: () => Promise<void> | void,
    ): Promise<void> => {
      try {
        await action();
      } catch {
        cleanupErrors.push({ code: 'CLEANUP_OPERATION_FAILED', stage });
        report.status = 'failed';
        report.stage = 'failed';
      }
    };
    await attemptCleanup('controller-close', async () => {
      if (runningServer !== undefined) await runningServer.close();
      controllerClosed = runningServer !== undefined;
    });
    await attemptCleanup('database-close', () => {
      if (db !== undefined) {
        db.close();
        db = undefined;
      }
    });
    await attemptCleanup('mock-close', async () => {
      if (mock.server.listening) await readClose(mock.server);
      mockStopped = !mock.server.listening;
    });
    const anchorPath = join(dataDir, 'controller.kernel.lock');
    const markerPath = join(dataDir, 'controller.lock');
    const databasePath = join(dataDir, 'controller.sqlite');
    let anchorMode: number | null = null;
    let anchorRegular = false;
    let markerMissing = false;
    try {
      const anchor = await stat(anchorPath);
      anchorMode = anchor.mode & 0o777;
      anchorRegular = anchor.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        cleanupErrors.push({
          code: 'FILESYSTEM_CHECK_FAILED',
          stage: 'anchor-stat',
        });
    }
    try {
      await stat(markerPath);
      markerMissing = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        markerMissing = true;
      else
        cleanupErrors.push({
          code: 'FILESYSTEM_CHECK_FAILED',
          stage: 'marker-stat',
        });
    }
    let databaseExists = false;
    try {
      await stat(databasePath);
      databaseExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        cleanupErrors.push({
          code: 'FILESYSTEM_CHECK_FAILED',
          stage: 'database-stat',
        });
    }
    let controllerDisconnected = false;
    let mockDisconnected = false;
    await attemptCleanup('controller-connectivity-check', async () => {
      controllerDisconnected = controllerPort
        ? !(await connectable(controllerPort))
        : false;
    });
    await attemptCleanup('mock-connectivity-check', async () => {
      mockDisconnected = mock.address.port
        ? !(await connectable(mock.address.port))
        : false;
    });
    report.cleanup = {
      controllerClosed,
      mockStopped,
      controllerDisconnected,
      mockDisconnected,
      pendingRuntimeGates: runtime.pendingGates,
      runtimeAllSettled: runtime.allSettled,
      markerMissingAfterClose: markerMissing,
      anchorExistsAfterClose: anchorMode !== null,
      anchorMode,
      anchorRegular,
      databaseExists,
      cleanupErrors,
    };
    const transcriptPath = join(outDir, 'transcript.json');
    const callsPath = join(outDir, 'telegram-calls.json');
    const reportPath = join(outDir, 'report.json');
    report.artifacts = {
      directory: outDir,
      database: databasePath,
      transcript: transcriptPath,
      calls: callsPath,
      report: reportPath,
    };
    await attemptCleanup('write-transcript', () =>
      writePrivate(
        transcriptPath,
        JSON.stringify(
          mock.sent.map((m) => ({
            ...m,
            text: m.text
              .replace(/(\/start\s+)[A-Za-z0-9_-]{43}/g, '$1[redacted-invite]')
              .replace(/(start=)[A-Za-z0-9_-]{43}/g, '$1[redacted-invite]'),
          })),
          null,
          2,
        ),
      ),
    );
    await attemptCleanup('write-calls', () =>
      writePrivate(callsPath, JSON.stringify(mock.calls, null, 2)),
    );
    const cleanupOk =
      report.cleanup['controllerClosed'] === true &&
      report.cleanup['mockStopped'] === true &&
      report.cleanup['controllerDisconnected'] === true &&
      report.cleanup['mockDisconnected'] === true &&
      report.cleanup['markerMissingAfterClose'] === true &&
      report.cleanup['anchorRegular'] === true &&
      report.cleanup['anchorMode'] === 0o600 &&
      report.cleanup['databaseExists'] === true &&
      report.cleanup['pendingRuntimeGates'] === 0 &&
      report.cleanup['runtimeAllSettled'] === true &&
      cleanupErrors.length === 0;
    if (!cleanupOk) {
      report.status = 'failed';
      report.stage = 'failed';
      report.error ??= { code: 'CLEANUP_INVARIANT_FAILED', stage: 'cleanup' };
    }
    const allScenariosPassed =
      report.scenarios.length > 0 &&
      report.scenarios.every((s) => s.status === 'passed');
    if (report.status !== 'failed' && allScenariosPassed) {
      report.status = 'passed';
      report.stage = 'passed';
    } else if (report.status !== 'failed') {
      report.status = 'unverified';
    }
    await attemptCleanup('write-report', () =>
      writePrivate(reportPath, JSON.stringify(report, null, 2)),
    );
  }
  return report;
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(path, content, { mode: 0o600 }),
  );
  await chmod(path, 0o600);
}

export { runTelegramServiceMockAcceptance };
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await runTelegramServiceMockAcceptance();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}
