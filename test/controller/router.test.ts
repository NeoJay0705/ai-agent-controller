import { describe, expect, it } from 'vitest';

import { TelegramRouter } from '../../src/controller/router.js';
import { FlowExecutor } from '../../src/flow/executor.js';
import { FakeAgentRuntime, testFlowStore } from '../flow/helpers.js';
import {
  memoryStore,
  makeUpdate,
  testConfig,
  USER_ID,
  CHAT_ID,
  createSession,
} from './helpers.js';

describe('Telegram router and durable update handling', () => {
  const routerOptions = { readyAtSec: () => 0 };
  it('gates on the envelope date before authorization or text access', () => {
    const store = memoryStore();
    const skipped: string[] = [];
    const router = new TelegramRouter(store, testConfig(), {
      readyAtSec: () => 10,
      onSkipped: (classification) => skipped.push(classification),
    });
    const early = makeUpdate(1, 'DO_NOT_READ_EARLY', { date: 9 });
    if (early.message === undefined) throw new Error('Expected a message.');
    Object.defineProperty(early.message, 'text', {
      get() {
        throw new Error('early message text was read');
      },
    });
    expect(() => {
      router.handle(early);
    }).not.toThrow();

    const invalid = makeUpdate(2, 'DO_NOT_READ_INVALID', { date: -1 });
    if (invalid.message === undefined) throw new Error('Expected a message.');
    Object.defineProperty(invalid.message, 'text', {
      get() {
        throw new Error('invalid-date message text was read');
      },
    });
    expect(() => {
      router.handle(invalid);
    }).not.toThrow();

    const atBoundary = makeUpdate(3, '/new accepted-at-boundary', { date: 10 });
    router.handle(atBoundary);
    const malformedText = makeUpdate(4, 'not-a-string', { date: 10 });
    if (malformedText.message === undefined)
      throw new Error('Expected a message.');
    Object.defineProperty(malformedText.message, 'text', { value: 42 });
    router.handle(malformedText);

    expect(store.listSessions(USER_ID).map((session) => session.name)).toEqual([
      'accepted-at-boundary',
    ]);
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 0 });
    expect(store.getOffset()).toBe(5);
    expect(skipped).toEqual(['before_ready', 'invalid_message_date']);
    const replies = store
      .dueOutbox(Date.now())
      .map((item) => item.text)
      .join('\n');
    expect(replies).toContain('Only text messages are supported.');
    expect(replies).not.toContain('DO_NOT_READ');
    store.close();
  });

  it('authorizes private user IDs, ignores other updates, deduplicates, and advances offset', () => {
    const store = memoryStore();
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    router.handle(makeUpdate(5, '/new private'));
    router.handle(
      makeUpdate(6, '/new should-not-exist', { chatType: 'group' }),
    );
    router.handle(makeUpdate(7, '/new wrong-user', { userId: 989898 }));
    router.handle(makeUpdate(8, '/new channel', { chatType: 'channel' }));
    router.handle(makeUpdate(5, '/new duplicate'));

    expect(store.listSessions(USER_ID)).toHaveLength(1);
    expect(store.listSessions(USER_ID)[0]?.name).toBe('private');
    expect(store.getOffset()).toBe(9);
    expect(
      store.database
        .prepare('SELECT COUNT(*) AS count FROM processed_updates')
        .get(),
    ).toMatchObject({ count: 4 });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 0 });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
    ).toMatchObject({ count: 1 });
    store.close();
  });

  it('creates and switches sessions, queues text, steers a fixed job, and answers queries directly', () => {
    const store = memoryStore();
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    router.handle(makeUpdate(1, '/new first'));
    const first = store.selectedSession(USER_ID, CHAT_ID);
    expect(first).not.toBeNull();
    if (first === null) throw new Error('Expected the selected session.');
    const firstId = first.id;
    router.handle(makeUpdate(2, 'first input'));
    const job = store.database
      .prepare('SELECT id, sequence, status FROM jobs')
      .get() as {
      id: string;
      sequence: number;
      status: string;
    };
    expect(job.status).toBe('QUEUED');
    router.handle(makeUpdate(3, `/steer ${job.id} supplement`));
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare("SELECT steering_state FROM messages WHERE kind='steering'")
        .get(),
    ).toMatchObject({ steering_state: 'pending' });
    expect(
      store.database
        .prepare('SELECT next_sequence FROM sessions WHERE id=?')
        .get(firstId),
    ).toMatchObject({ next_sequence: 3 });

    router.handle(makeUpdate(4, '/new second'));
    const second = store.selectedSession(USER_ID, CHAT_ID);
    expect(second?.id).not.toBe(firstId);
    router.handle(makeUpdate(5, `/use ${firstId}`));
    expect(store.selectedSession(USER_ID, CHAT_ID)?.id).toBe(firstId);
    router.handle(makeUpdate(6, '/status'));
    router.handle(makeUpdate(7, `/status ${job.id}`));
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE kind='queued'")
        .get(),
    ).toMatchObject({ count: 1 });
    expect(store.getOffset()).toBe(8);
    store.close();
  });

  it('rejects missing selection, malformed commands, non-text, whitespace, and over-limit messages without partial jobs', () => {
    const store = memoryStore();
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    router.handle(makeUpdate(1, 'ordinary text'));
    router.handle(makeUpdate(2, '/queue data'));
    router.handle(makeUpdate(3, '   '));
    router.handle(makeUpdate(4, '/not-supported x'));
    router.handle(makeUpdate(5, undefined));
    router.handle(makeUpdate(6, 'x'.repeat(4097)));
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 0 });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM messages').get(),
    ).toMatchObject({ count: 0 });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
    ).toMatchObject({ count: 6 });
    expect(store.getOffset()).toBe(7);
    store.close();
  });

  it('routes an active prompt reply to its original job after switching sessions and rejects expired replies', async () => {
    const now = 10_000;
    const store = memoryStore({ now: () => now });
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    router.handle(makeUpdate(1, '/new original'));
    router.handle(makeUpdate(2, 'flow request'));
    const job = store.database.prepare('SELECT id FROM jobs').get() as {
      id: string;
    };
    const flowStore = testFlowStore(store, () => now);
    const executor = new FlowExecutor(
      store,
      flowStore,
      new FakeAgentRuntime(),
      { now: () => now },
    );
    flowStore.reserveReadyJobs(now, 1);
    await executor.execute(job.id, new AbortController().signal);
    const prompt = store
      .dueOutbox(now + 1)
      .find((item) => item.kind === 'prompt');
    expect(prompt).toBeDefined();
    store.deliverOutbox(prompt?.id ?? '', Number(CHAT_ID), 9001, now + 2);
    expect(store.findPrompt(CHAT_ID, 9001)).toMatchObject({
      jobId: job.id,
      active: true,
    });

    router.handle(makeUpdate(3, '/new other'));
    router.handle(makeUpdate(4, 'reply steering', { replyTo: 9001 }));
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare(
          "SELECT job_id, steering_state FROM messages WHERE kind='steering'",
        )
        .get(),
    ).toMatchObject({ job_id: job.id, steering_state: 'pending' });
    expect(store.selectedSession(USER_ID, CHAT_ID)?.name).toBe('other');

    store.deactivatePrompts(job.id, 'PROMPT_SUPERSEDED');
    router.handle(makeUpdate(5, 'late reply', { replyTo: 9001 }));
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE content='late reply'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    store.close();
  });

  it('rolls back initial job, message sequence, reply, dedup record, and offset together', () => {
    const store = memoryStore();
    const sessionId = createSession(store);
    const beforeOutbox = store.database
      .prepare('SELECT COUNT(*) AS count FROM outbox')
      .get();
    expect(() =>
      store.transaction(() => {
        store.queueJob(USER_ID, CHAT_ID, 'atomic input', 10);
        store.recordUpdate(100);
        throw new Error('forced transaction failure');
      }),
    ).toThrow('forced transaction failure');
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 0 });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM messages').get(),
    ).toMatchObject({ count: 0 });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
    ).toEqual(beforeOutbox);
    expect(
      store.database
        .prepare('SELECT next_sequence FROM sessions WHERE id=?')
        .get(sessionId),
    ).toMatchObject({ next_sequence: 1 });
    expect(store.getOffset()).toBe(0);
    expect(store.isUpdateProcessed(100)).toBe(false);
    expect(() => store.transaction(() => Promise.resolve(undefined))).toThrow(
      /must be synchronous/,
    );
    store.close();
  });

  it('does not reveal whether another owner has a session or job', () => {
    const store = memoryStore();
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    store.transaction(() =>
      store.createSession('111111', '111111', 'private-name'),
    );
    router.handle(makeUpdate(1, '/use missing-or-private-id'));
    router.handle(makeUpdate(2, '/status missing-or-private-id'));
    const texts = store
      .dueOutbox(Date.now())
      .filter((item) => item.chatId === CHAT_ID)
      .map((item) => item.text)
      .join('\n');
    expect(texts).not.toContain('private-name');
    expect(texts).not.toContain('missing-or-private-id');
    expect(texts).toContain('Session not found.');
    expect(texts).toContain('Job not found.');
    store.close();
  });

  it('does not authorize a different ID with the same username', () => {
    const store = memoryStore();
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    const unauthorized = makeUpdate(1, '/new impostor', { userId: 989898 });
    const message = unauthorized.message;
    if (message === undefined) throw new Error('Expected test message.');
    router.handle({
      ...unauthorized,
      message: { ...message, from: { id: 989898, username: 'trusted-user' } },
    });
    router.handle(makeUpdate(2, '/new authorized'));
    expect(store.listSessions(USER_ID).map((session) => session.name)).toEqual([
      'authorized',
    ]);
    expect(store.listSessions('989898')).toHaveLength(0);
    expect(store.getOffset()).toBe(3);
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 0 });
    store.close();
  });

  it('filters /sessions by owner and gives identical /use and /status errors for private and missing IDs', () => {
    const store = memoryStore();
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    router.handle(makeUpdate(1, '/new own-session'));
    const another = store.transaction(() => {
      const session = store.createSession('111111', '111111', 'private-name');
      const jobId = store.queueJob('111111', '111111', 'private work', 10);
      return { sessionId: session.id, jobId };
    });
    router.handle(makeUpdate(2, '/sessions'));
    const sessionsReply = store.database
      .prepare(
        'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(CHAT_ID) as { text: string };
    expect(sessionsReply.text).toContain('own-session');
    expect(sessionsReply.text).not.toContain('private-name');
    expect(sessionsReply.text).not.toContain(another.sessionId);

    router.handle(makeUpdate(3, `/use ${another.sessionId}`));
    const privateSessionUse = store.database
      .prepare(
        'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(CHAT_ID) as { text: string };
    router.handle(makeUpdate(4, '/use absent-session-id'));
    const missingSessionUse = store.database
      .prepare(
        'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(CHAT_ID) as { text: string };
    expect(privateSessionUse.text).toBe(missingSessionUse.text);
    expect(privateSessionUse.text).toContain('Session not found.');

    router.handle(makeUpdate(5, `/status ${another.jobId}`));
    const privateJobStatus = store.database
      .prepare(
        'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(CHAT_ID) as { text: string };
    router.handle(makeUpdate(6, '/status absent-job-id'));
    const missingJobStatus = store.database
      .prepare(
        'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(CHAT_ID) as { text: string };
    expect(privateJobStatus.text).toBe(missingJobStatus.text);
    expect(privateJobStatus.text).toContain('Job not found.');
    store.close();
  });

  it('creates a Job for /queue and enforces MAX_PENDING_JOBS in every active state without partial writes', async () => {
    for (const stage of ['QUEUED', 'RUNNING', 'WAITING_INPUT'] as const) {
      const store = memoryStore({ now: () => 1000 });
      const router = new TelegramRouter(
        store,
        testConfig({ MAX_PENDING_JOBS: '1' }),
        routerOptions,
      );
      router.handle(makeUpdate(1, '/new capacity'));
      router.handle(makeUpdate(2, '/queue first'));
      const first = store.database.prepare('SELECT id FROM jobs').get() as {
        id: string;
      };
      if (stage === 'RUNNING') {
        store.scheduleAvailable(1000, 1, 60_000);
      } else if (stage === 'WAITING_INPUT') {
        const flowStore = testFlowStore(store, () => 1000);
        const executor = new FlowExecutor(
          store,
          flowStore,
          new FakeAgentRuntime(),
          { now: () => 1000 },
        );
        flowStore.reserveReadyJobs(1000, 1);
        await executor.execute(first.id, new AbortController().signal);
      }
      expect(store.statusForJob(USER_ID, first.id)?.status).toBe(stage);
      const sequenceBefore = store.database
        .prepare('SELECT next_sequence FROM sessions WHERE owner_id=?')
        .get(USER_ID);
      router.handle(makeUpdate(3, '/queue rejected at limit'));
      expect(
        store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
      ).toMatchObject({
        count: 1,
      });
      expect(
        store.database.prepare('SELECT COUNT(*) AS count FROM messages').get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare('SELECT next_sequence FROM sessions WHERE owner_id=?')
          .get(USER_ID),
      ).toEqual(sequenceBefore);
      const refusal = store.database
        .prepare(
          'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(CHAT_ID) as { text: string };
      expect(refusal.text).toContain('pending job limit');

      router.handle(makeUpdate(4, `/status ${first.id}`));
      const status = store.database
        .prepare(
          'SELECT text FROM outbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(CHAT_ID) as { text: string };
      expect(status.text).toContain(`Job ${first.id}`);
      expect(status.text).toContain(stage);
      expect(store.getOffset()).toBe(5);
      store.close();
    }
  });

  it('rejects the second pending steering without changing the first or its sequence', () => {
    const store = memoryStore();
    const router = new TelegramRouter(
      store,
      testConfig({ MAX_PENDING_STEERING: '1' }),
      routerOptions,
    );
    router.handle(makeUpdate(1, '/new steering-limit'));
    router.handle(makeUpdate(2, '/queue target'));
    const job = store.database.prepare('SELECT id FROM jobs').get() as {
      id: string;
    };
    router.handle(makeUpdate(3, `/steer ${job.id} first supplement`));
    const sequenceBefore = store.database
      .prepare('SELECT next_sequence FROM sessions WHERE owner_id=?')
      .get(USER_ID);
    router.handle(makeUpdate(4, `/steer ${job.id} rejected supplement`));
    expect(
      store.database
        .prepare(
          "SELECT content, steering_state FROM messages WHERE kind='steering'",
        )
        .all(),
    ).toEqual([{ content: 'first supplement', steering_state: 'pending' }]);
    expect(
      store.database
        .prepare('SELECT next_sequence FROM sessions WHERE owner_id=?')
        .get(USER_ID),
    ).toEqual(sequenceBefore);
    expect(store.statusForJob(USER_ID, job.id)).toMatchObject({
      pendingSteering: 1,
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    store.close();
  });

  it('gives explicit /queue precedence over an active prompt reply', async () => {
    const now = 1000;
    const store = memoryStore({ now: () => now });
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    router.handle(makeUpdate(1, '/new prompt-priority'));
    router.handle(makeUpdate(2, '/queue MBTI request'));
    const first = store.database.prepare('SELECT id FROM jobs').get() as {
      id: string;
    };
    const flowStore = testFlowStore(store, () => now);
    const executor = new FlowExecutor(
      store,
      flowStore,
      new FakeAgentRuntime(),
      { now: () => now },
    );
    flowStore.reserveReadyJobs(now, 1);
    await executor.execute(first.id, new AbortController().signal);
    const prompt = store
      .dueOutbox(now + 1)
      .find((item) => item.kind === 'prompt');
    if (prompt === undefined) throw new Error('Expected a prompt outbox item.');
    store.deliverOutbox(prompt.id, Number(CHAT_ID), 8765, now + 2);
    router.handle(makeUpdate(3, '/queue explicit job', { replyTo: 8765 }));
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 2 });
    expect(
      store.database
        .prepare('SELECT id, input, status FROM jobs ORDER BY sequence')
        .all(),
    ).toMatchObject([
      { id: first.id, input: 'MBTI request', status: 'WAITING_INPUT' },
      { input: 'explicit job', status: 'QUEUED' },
    ]);
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE kind='steering'")
        .get(),
    ).toMatchObject({ count: 0 });
    store.close();
  });

  it('throws and rolls back actual SQLite router faults, then accepts the same update once', () => {
    const store = memoryStore();
    const sessionId = createSession(store);
    const router = new TelegramRouter(store, testConfig(), routerOptions);
    const beforeOutbox = store.database
      .prepare('SELECT COUNT(*) AS count FROM outbox')
      .get();
    store.database.exec(`
      CREATE TRIGGER reject_router_ack BEFORE INSERT ON outbox
      WHEN NEW.kind='ack'
      BEGIN SELECT RAISE(ABORT, 'injected SQLite outbox failure'); END;
    `);
    const update = makeUpdate(501, '/queue atomic');
    expect(() => {
      router.handle(update);
    }).toThrow(/injected SQLite outbox failure/);
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({
      count: 0,
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM messages').get(),
    ).toMatchObject({
      count: 0,
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
    ).toEqual(beforeOutbox);
    expect(
      store.database
        .prepare('SELECT next_sequence FROM sessions WHERE id=?')
        .get(sessionId),
    ).toMatchObject({ next_sequence: 1 });
    expect(store.isUpdateProcessed(501)).toBe(false);
    expect(store.getOffset()).toBe(0);

    store.database.exec('DROP TRIGGER reject_router_ack');
    router.handle(update);
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({
      count: 1,
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM messages').get(),
    ).toMatchObject({
      count: 1,
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
    ).toMatchObject({
      count: 2,
    });
    expect(
      store.database
        .prepare('SELECT next_sequence FROM sessions WHERE id=?')
        .get(sessionId),
    ).toMatchObject({ next_sequence: 2 });
    expect(store.isUpdateProcessed(501)).toBe(true);
    expect(store.getOffset()).toBe(502);
    store.close();
  });
});
