import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerService } from '../../src/controller/service.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import { TelegramRouter } from '../../src/controller/router.js';
import { TrialStore } from '../../src/controller/trial-store.js';
import { DEFAULT_TRIAL_POLICY } from '../../src/controller/trial-policy.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type { AgentNodeResult, AgentRuntime } from '../../src/flow/types.js';
import {
  DEFAULT_BOT_COMMANDS,
  GUEST_BOT_COMMANDS,
} from '../../src/controller/commands.js';
import {
  artifactsPath,
  ensureArtifactsDirectory,
  memoryStore,
  flushTasks,
  makeUpdate,
  testConfig,
  testFlowBundle,
  waitUntil,
} from './helpers.js';

class Clock {
  value = 1_000;
  now = (): number => this.value;
}
class Sleep {
  waits: Array<() => void> = [];
  sleep = (_ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waits.push(done);
      signal.addEventListener('abort', done, { once: true });
    });
  release() {
    for (const done of this.waits.splice(0)) done();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface FixtureOptions {
  runtime: AgentRuntime;
  setCommands?: (chatId: number | undefined, commands: unknown) => boolean;
}
async function fixture({ runtime, setCommands }: FixtureOptions) {
  await ensureArtifactsDirectory();
  const dataDir = artifactsPath('controlled-trial-service').replace(
    /\.sqlite$/,
    '',
  );
  const config = testConfig({
    CONTROLLER_DATA_DIR: dataDir,
    JOB_CONCURRENCY: '2',
    MAX_PENDING_JOBS: '20',
  });
  const clock = new Clock();
  const sleep = new Sleep();
  const updates: ReturnType<typeof makeUpdate>[] = [];
  const sent: Array<{ chatId: number; text: string }> = [];
  const scopes: Array<{ chatId: number | undefined; commands: unknown }> = [];
  const fetcher: FetchLike = (input, init) => {
    const method = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    ).pathname
      .split('/')
      .at(-1);
    if (method === 'getMe')
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { username: 'synthetic_bot' } }),
        ),
      );
    if (method === 'getUpdates')
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: updates.splice(0) })),
      );
    if (typeof init?.body !== 'string')
      throw new Error('Expected JSON request body.');
    const body = JSON.parse(init.body) as {
      chat_id?: number;
      text?: string;
      scope?: { chat_id?: number };
      commands?: unknown;
    };
    if (method === 'setMyCommands') {
      const chatId = body.scope?.chat_id;
      const rateLimited = setCommands?.(chatId, body.commands) ?? false;
      if (!rateLimited) scopes.push({ chatId, commands: body.commands });
      return Promise.resolve(
        rateLimited
          ? new Response(
              JSON.stringify({
                ok: false,
                error_code: 429,
                parameters: { retry_after: 1 },
              }),
              { status: 429 },
            )
          : new Response(JSON.stringify({ ok: true, result: true })),
      );
    }
    if (method === 'sendMessage') {
      const chatId = body.chat_id;
      if (chatId === undefined || body.text === undefined)
        throw new Error('Invalid fake sendMessage request.');
      sent.push({ chatId, text: body.text });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: sent.length, chat: { id: chatId } },
          }),
        ),
      );
    }
    throw new Error(`Unexpected Telegram method: ${String(method)}`);
  };
  const resources = await openControllerResources(config, { now: clock.now });
  const service = new ControllerService(
    config,
    resources,
    new TelegramClient(config.token, fetcher),
    testFlowBundle(),
    {
      clock,
      sleep: sleep.sleep,
      pollIntervalMs: 1,
      outboxIntervalMs: 1,
      agentRuntimeForTests: runtime,
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  const pump = async (turns = 8) => {
    for (let i = 0; i < turns; i++) {
      sleep.release();
      await flushTasks();
    }
  };
  return {
    config,
    clock,
    sleep,
    updates,
    sent,
    scopes,
    resources,
    service,
    pump,
  };
}
const readyResult = {
  transition: 'ready',
  result: { suggestedFlow: null },
} as const;

describe('controlled trial service wiring', () => {
  it('serializes guest runs across Sessions, finalizes revoke only after runtime settle, and protects Owner work', async () => {
    const entered = deferred<undefined>();
    const gate = deferred<AgentNodeResult>();
    let guestRuns = 0;
    let ownerRuns = 0;
    let guestSignalAborted = false;
    const runtime: AgentRuntime = {
      run(input) {
        if (
          input.node.id === 'recommend' &&
          input.input.includes('first guest request')
        ) {
          guestRuns++;
          entered.resolve(undefined);
          const budget = input.usageBudget;
          if (budget !== undefined) budget.onRequestStarted(0);
          input.signal.addEventListener(
            'abort',
            () => {
              guestSignalAborted = true;
            },
            { once: true },
          );
          return gate.promise.then((result) => {
            if (budget !== undefined) {
              budget.onUsage(0, 7);
              budget.onSettled(true);
            }
            return result;
          });
        }
        if (
          input.node.id === 'recommend' &&
          input.input.includes('second guest request')
        )
          guestRuns++;
        if (
          input.node.id === 'recommend' &&
          input.input.includes('owner request')
        )
          ownerRuns++;
        const budget = input.usageBudget;
        if (budget !== undefined) {
          budget.onRequestStarted(0);
          budget.onUsage(0, 7);
          budget.onSettled(true);
        }
        return Promise.resolve(readyResult);
      },
      async dispose() {},
    };
    const f = await fixture({ runtime });
    try {
      f.service.start();
      f.clock.value = 2_000;
      await f.pump();
      f.updates.push(makeUpdate(1, '/allow 616161 1h'));
      await f.pump();
      f.updates.push(
        makeUpdate(2, '/new guest-a', { userId: 616161, chatId: 616161 }),
        makeUpdate(3, '/queue first guest request', {
          userId: 616161,
          chatId: 616161,
        }),
      );
      await f.pump();
      await waitUntil(() => guestRuns === 1);
      await entered.promise;
      const jobs = f.resources.store.database
        .prepare('SELECT id,status FROM jobs ORDER BY created_at,sequence')
        .all() as Array<{ id: string; status: string }>;
      const first = jobs.find((job) => job.status === 'RUNNING');
      if (first === undefined)
        throw new Error('Expected the running guest job.');
      f.updates.push(
        makeUpdate(4, '/new guest-b', { userId: 616161, chatId: 616161 }),
        makeUpdate(5, '/queue second guest request', {
          userId: 616161,
          chatId: 616161,
        }),
      );
      await f.pump();
      const second = f.resources.store.database
        .prepare(
          "SELECT id,status FROM jobs WHERE input='second guest request'",
        )
        .get() as { id: string; status: string };
      expect(second.status).toBe('QUEUED');
      expect(guestRuns).toBe(1);
      f.updates.push(
        makeUpdate(6, '/new owner-work'),
        makeUpdate(7, '/queue owner request'),
      );
      await f.pump();
      await waitUntil(() => ownerRuns === 1);
      f.updates.push(makeUpdate(8, '/revoke 616161'));
      await f.pump();
      expect(f.resources.store.statusForJob('616161', first.id)?.status).toBe(
        'CANCELLING',
      );
      expect(f.resources.store.statusForJob('616161', second.id)?.status).toBe(
        'CANCELLED',
      );
      expect(guestSignalAborted).toBe(true);
      const revisionBefore = f.resources.store.database
        .prepare('SELECT revision FROM flow_runs WHERE job_id=?')
        .get(first.id) as { revision: number };
      expect(ownerRuns).toBe(1);
      expect(
        f.resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE owner_id='424242' AND status='CANCELLED'",
          )
          .get(),
      ).toEqual({ count: 0 });
      await f.pump();
      expect(f.resources.store.statusForJob('616161', first.id)?.status).toBe(
        'CANCELLING',
      );
      expect(
        f.resources.store.database
          .prepare('SELECT revision FROM flow_runs WHERE job_id=?')
          .get(first.id),
      ).toEqual(revisionBefore);
      gate.resolve(readyResult);
      await waitUntil(
        () =>
          f.resources.store.statusForJob('616161', first.id)?.status ===
          'CANCELLED',
      );
      await f.pump();
      expect(
        f.resources.store.database
          .prepare('SELECT revision FROM flow_runs WHERE job_id=?')
          .get(first.id),
      ).toEqual(revisionBefore);
      expect(
        f.resources.store.database
          .prepare(
            'SELECT COUNT(*) AS count FROM session_facts WHERE owner_id=?',
          )
          .get('616161'),
      ).toEqual({ count: 0 });
      expect(
        f.resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE job_id=? AND kind='completed'",
          )
          .get(first.id),
      ).toEqual({ count: 0 });
      expect(guestRuns).toBe(1);
      expect(ownerRuns).toBe(1);
      expect(
        f.resources.store.database
          .prepare(
            'SELECT state,total_tokens FROM trial_usage_operations WHERE job_id=?',
          )
          .get(first.id),
      ).toEqual({ state: 'complete', total_tokens: 7 });
    } finally {
      gate.resolve(readyResult);
      await f.service.stop();
    }
  });

  it('expires a waiting guest without new Telegram input and blocks business outbox before send', async () => {
    const runtime: AgentRuntime = {
      run(input) {
        const budget = input.usageBudget;
        if (budget !== undefined) {
          budget.onRequestStarted(0);
          budget.onUsage(0, 7);
          budget.onSettled(true);
        }
        return Promise.resolve({
          transition: 'ready',
          result: {
            suggestedFlow: input.node.id === 'recommend' ? 'mbti' : null,
          },
        });
      },
      async dispose() {},
    };
    const f = await fixture({ runtime });
    try {
      f.service.start();
      f.clock.value = 2_000;
      await f.pump();
      f.updates.push(
        makeUpdate(1, '/allow 616161 1s'),
        makeUpdate(2, '/new expiry-session', {
          userId: 616161,
          chatId: 616161,
        }),
        makeUpdate(3, '/queue choose a flow', {
          userId: 616161,
          chatId: 616161,
        }),
      );
      await f.pump();
      await waitUntil(
        () =>
          (
            f.resources.store.database
              .prepare(
                "SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt' AND status='DELIVERED'",
              )
              .get() as { count: number }
          ).count > 0,
      );
      const job = f.resources.store.database
        .prepare("SELECT id,status FROM jobs WHERE owner_id='616161'")
        .get() as { id: string; status: string };
      expect(job.status).toBe('WAITING_INPUT');
      expect(
        f.resources.store.database
          .prepare('SELECT active FROM prompt_bindings WHERE job_id=?')
          .get(job.id),
      ).toEqual({ active: 1 });
      const trial = f.resources.store.database
        .prepare("SELECT chat_id FROM trial_users WHERE user_id='616161'")
        .get() as { chat_id: string };
      f.updates.push(
        makeUpdate(4, '/queue', { userId: 616161, chatId: 616161 }),
      );
      await f.pump();
      expect(
        f.resources.store.database
          .prepare(
            'SELECT user_id,chat_id,command FROM command_dialogs WHERE user_id=? AND chat_id=?',
          )
          .get('616161', '616161'),
      ).toEqual({ user_id: '616161', chat_id: '616161', command: 'queue' });
      expect(job.status).toBe('WAITING_INPUT');
      const session = f.resources.store.database
        .prepare('SELECT session_id FROM jobs WHERE id=?')
        .get(job.id) as { session_id: string };
      expect(
        f.resources.store.database
          .prepare('SELECT message_id FROM prompt_bindings WHERE job_id=?')
          .get(job.id),
      ).toBeDefined();
      const marker = 'synthetic-business-marker';
      f.resources.store.transaction(() => {
        f.resources.store.reply(trial.chat_id, marker, session.session_id);
      });
      const markerOutbox = f.resources.store.database
        .prepare(
          "SELECT id,session_id,job_id,delivery_class FROM outbox WHERE text LIKE '%' || ? || '%'",
        )
        .get(marker) as {
        id: string;
        session_id: string;
        job_id: string | null;
        delivery_class: string;
      };
      expect(markerOutbox.id.length).toBeGreaterThan(0);
      expect(markerOutbox.session_id).toBe(session.session_id);
      expect(markerOutbox.job_id).toBeNull();
      expect(markerOutbox.delivery_class).toBe('business');
      f.clock.value = 3_001;
      await f.pump(20);
      expect(
        f.resources.store.database
          .prepare(
            'SELECT user_id,chat_id,command FROM command_dialogs WHERE user_id=? AND chat_id=?',
          )
          .get('616161', '616161'),
      ).toBeUndefined();
      expect(
        f.resources.store.database
          .prepare("SELECT revoked_at FROM trial_users WHERE user_id='616161'")
          .get(),
      ).toEqual({ revoked_at: 3_001 });
      expect(f.resources.store.statusForJob('616161', job.id)?.status).toBe(
        'CANCELLED',
      );
      expect(
        f.resources.store.database
          .prepare('SELECT active FROM prompt_bindings WHERE job_id=?')
          .get(job.id),
      ).toEqual({ active: 0 });
      expect(
        f.resources.store.database
          .prepare("SELECT status FROM outbox WHERE text LIKE '%' || ? || '%' ")
          .get(marker),
      ).toEqual({ status: 'FAILED' });
      expect(f.sent.some((message) => message.text.includes(marker))).toBe(
        false,
      );
      expect(
        f.resources.store.isOutboxSendable(
          f.resources.store.database
            .prepare("SELECT id FROM outbox WHERE text LIKE '%' || ? || '%' ")
            .get(marker)?.id as string,
        ),
      ).toBe(false);
      expect(
        f.sent.some(
          (message) =>
            message.text.includes('Trial access revoked') ||
            message.text.includes('Job cancelled'),
        ),
      ).toBe(true);
    } finally {
      await f.service.stop();
    }
  });

  it('keeps grant successful when guest menu registration is rate-limited, retries desired scope, and revokes commands', async () => {
    let guestFailures = 1;
    const runtime: AgentRuntime = {
      run() {
        return Promise.resolve(readyResult);
      },
      async dispose() {},
    };
    // Retry-after is deterministic; the fixture owns the service clock.
    const f = await fixture({
      runtime,
      setCommands(chatId) {
        if (chatId === 616161 && guestFailures > 0) {
          guestFailures--;
          return true;
        }
        return false;
      },
    });
    try {
      f.service.start();
      f.clock.value = 2_000;
      await f.pump();
      f.updates.push(makeUpdate(1, '/allow 616161 1h'));
      await f.pump();
      expect(guestFailures).toBe(0);
      expect(
        f.resources.store.database
          .prepare("SELECT role FROM command_menu_sync WHERE chat_id='616161'")
          .get(),
      ).toEqual({ role: 'guest' });
      expect(
        f.resources.store.database
          .prepare("SELECT expires_at FROM trial_users WHERE user_id='616161'")
          .get(),
      ).toBeDefined();
      expect(
        f.scopes.some(
          (scope) =>
            scope.chatId === 616161 &&
            JSON.stringify(scope.commands) ===
              JSON.stringify(GUEST_BOT_COMMANDS),
        ),
      ).toBe(false);
      f.clock.value += 1_000;
      await f.pump(20);
      expect(
        f.scopes.some(
          (scope) =>
            scope.chatId === 616161 &&
            JSON.stringify(scope.commands) ===
              JSON.stringify(GUEST_BOT_COMMANDS),
        ),
      ).toBe(true);
      const guestScope = f.scopes.find(
        (scope) =>
          scope.chatId === 616161 &&
          JSON.stringify(scope.commands) === JSON.stringify(GUEST_BOT_COMMANDS),
      );
      expect(guestScope).toBeDefined();
      f.updates.push(
        makeUpdate(2, '/new menu-guest', { userId: 616161, chatId: 616161 }),
        makeUpdate(3, '/revoke 616161'),
      );
      await f.pump(15);
      expect(
        f.scopes.some(
          (scope) =>
            scope.chatId === 616161 &&
            JSON.stringify(scope.commands) ===
              JSON.stringify(DEFAULT_BOT_COMMANDS),
        ),
      ).toBe(true);
      const update = makeUpdate(4, '/queue must-not-create', {
        userId: 616161,
        chatId: 616161,
      });
      f.updates.push(update);
      await f.pump();
      expect(
        f.resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toEqual({ count: 0 });
      expect(f.resources.store.getOffset()).toBe(5);
    } finally {
      await f.service.stop();
    }
  });

  it('redeems an invite once across users and preserves prior guest counters', () => {
    let now = 10_000;
    const store = memoryStore({ now: () => now });
    const trials = new TrialStore(store, '424242', DEFAULT_TRIAL_POLICY, {
      now: () => now,
    });
    const invite = store.transaction(() => trials.createInvite(100, 200));
    const router = new TelegramRouter(store, testConfig(), {
      readyAtSec: () => 0,
      now: () => now,
      trialStore: trials,
    });
    router.handle(
      makeUpdate(1, `/start ${invite.token}`, {
        userId: 616161,
        chatId: 616161,
      }),
    );
    router.handle(
      makeUpdate(1, `/start ${invite.token}`, {
        userId: 616161,
        chatId: 616161,
      }),
    );
    router.handle(
      makeUpdate(2, `/start ${invite.token}`, {
        userId: 717171,
        chatId: 717171,
      }),
    );
    expect(
      store.database
        .prepare('SELECT user_id,messages_used FROM trial_users')
        .all(),
    ).toEqual([{ user_id: '616161', messages_used: 1 }]);
    expect(
      store.database.prepare('SELECT used_by FROM trial_invites').get(),
    ).toEqual({ used_by: '616161' });

    now = invite.expiresAt + 100;
    store.transaction(() => trials.expireTrials());
    const nextInvite = store.transaction(() => trials.createInvite(100, 200));
    router.handle(
      makeUpdate(3, `/start ${nextInvite.token}`, {
        userId: 616161,
        chatId: 616161,
      }),
    );
    expect(
      store.database
        .prepare(
          'SELECT messages_used,revoked_at FROM trial_users WHERE user_id=?',
        )
        .get('616161'),
    ).toMatchObject({
      messages_used: 1,
      revoked_at: now,
    });
    expect(
      store.database
        .prepare('SELECT used_by FROM trial_invites WHERE token_hash=?')
        .get(createHash('sha256').update(nextInvite.token).digest('hex')),
    ).toEqual({ used_by: null });
    store.close();
  });

  it('grants guests, applies explicit queue commands, tracks usage, and ignores ordinary queue text', async () => {
    const dataDir = artifactsPath('controlled-trial-integration').replace(
      /\.sqlite$/,
      '',
    );
    const config = testConfig({
      CONTROLLER_DATA_DIR: dataDir,
      JOB_CONCURRENCY: '2',
    });
    const clock = new Clock();
    const sleep = new Sleep();
    const updates = [makeUpdate(1, '/allow 616161 1h')];
    const fetcher: FetchLike = (input, init) => {
      const method = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ).pathname
        .split('/')
        .at(-1);
      if (method === 'getMe')
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: { username: 'synthetic_bot' } }),
          ),
        );
      if (method === 'setMyCommands')
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: true })),
        );
      if (method === 'getUpdates')
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: updates.splice(0) })),
        );
      if (typeof init?.body !== 'string')
        throw new Error('Expected JSON request body.');
      const body = JSON.parse(init.body) as { chat_id: number };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 1, chat: { id: body.chat_id } },
          }),
        ),
      );
    };
    const runtime: AgentRuntime = {
      run(input) {
        const budget = input.usageBudget;
        if (budget !== undefined) {
          budget.onRequestStarted(0);
          budget.onUsage(0, 7);
          budget.onSettled(true);
        }
        return Promise.resolve({
          transition: 'ready',
          result: { suggestedFlow: null },
        });
      },
      async dispose() {},
    };
    const resources = await openControllerResources(config, { now: clock.now });
    const service = new ControllerService(
      config,
      resources,
      new TelegramClient(config.token, fetcher),
      testFlowBundle(),
      {
        clock,
        sleep: sleep.sleep,
        pollIntervalMs: 1,
        outboxIntervalMs: 1,
        agentRuntimeForTests: runtime,
        logger: { info() {}, warn() {}, error() {} },
      },
    );
    try {
      service.start();
      clock.value = 2_000;
      sleep.release();
      await flushTasks();
      for (let i = 0; i < 20; i++) {
        sleep.release();
        await flushTasks();
      }
      expect(
        resources.store.database
          .prepare('SELECT expires_at FROM trial_users WHERE user_id=?')
          .get('616161'),
      ).toBeDefined();
      updates.push(
        makeUpdate(2, '/new guest', { userId: 616161, chatId: 616161 }),
        makeUpdate(3, 'ordinary input must not queue', {
          userId: 616161,
          chatId: 616161,
        }),
        makeUpdate(4, '/queue synthetic request', {
          userId: 616161,
          chatId: 616161,
        }),
      );
      for (let i = 0; i < 100; i++) {
        sleep.release();
        await flushTasks();
      }
      expect(
        resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        resources.store.database.prepare('SELECT input FROM jobs').get(),
      ).toEqual({ input: 'synthetic request' });
      expect(
        resources.store.database
          .prepare(
            'SELECT jobs_used,messages_used,tokens_used FROM trial_users WHERE user_id=?',
          )
          .get('616161'),
      ).toMatchObject({ jobs_used: 1, messages_used: 3, tokens_used: 7 });
    } finally {
      await service.stop();
    }
  });
});
