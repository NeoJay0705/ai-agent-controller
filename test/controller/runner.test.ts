import { describe, expect, it } from 'vitest';

import { DemoRunner } from '../../src/controller/runner.js';
import { TelegramRouter } from '../../src/controller/router.js';
import { ControllerStore } from '../../src/controller/store.js';
import { DatabaseSync } from 'node:sqlite';
import {
  testConfig,
  makeUpdate,
  USER_ID,
  CHAT_ID,
  createSession,
  memoryStore,
  artifactsPath,
  ensureArtifactsDirectory,
  removeDatabaseArtifacts,
  waitUntil,
} from './helpers.js';

class ManualSleep {
  private pending: Array<() => void> = [];

  sleep = (_milliseconds: number, signal: AbortSignal): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const release = (): void => {
        signal.removeEventListener('abort', cancel);
        const index = this.pending.indexOf(release);
        if (index >= 0) this.pending.splice(index, 1);
        resolve();
      };
      const cancel = (): void => {
        signal.removeEventListener('abort', cancel);
        const index = this.pending.indexOf(release);
        if (index >= 0) this.pending.splice(index, 1);
        reject(abortError());
      };
      this.pending.push(release);
      signal.addEventListener('abort', cancel, { once: true });
    });
  };

  get count(): number {
    return this.pending.length;
  }

  releaseAll(): void {
    for (const release of [...this.pending]) release();
  }
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function queue(
  store: ControllerStore,
  content: string,
  ownerId = USER_ID,
  chatId = CHAT_ID,
): string {
  return store.transaction(() => store.queueJob(ownerId, chatId, content, 100));
}

describe('durable demo runner', () => {
  it('keeps per-session FIFO and limits concurrent RUNNING jobs across sessions', async () => {
    const store = memoryStore({ now: () => 1000 });
    const firstSession = createSession(store, 'one');
    const secondSession = createSession(store, 'two', USER_ID, '616161');
    const first = queue(store, 'first');
    const next = queue(store, 'next');
    const other = queue(store, 'other', USER_ID, '616161');
    const sleeper = new ManualSleep();
    const runner = new DemoRunner(
      store,
      testConfig({ JOB_CONCURRENCY: '2', DEMO_STEP_MS: '1' }),
      {
        clock: { now: () => 1000 },
        sleep: sleeper.sleep,
      },
    );

    runner.tick();
    expect(store.getRunningJob(first)?.sessionId).toBe(firstSession);
    expect(store.getRunningJob(other)?.sessionId).toBe(secondSession);
    expect(store.statusForJob(USER_ID, next)?.status).toBe('QUEUED');
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='RUNNING'")
        .get(),
    ).toMatchObject({ count: 2 });
    expect(sleeper.count).toBe(2);

    for (let step = 0; step < 3; step += 1) {
      sleeper.releaseAll();
      await waitUntil(
        () =>
          sleeper.count === 2 ||
          (store.statusForJob(USER_ID, first)?.status === 'COMPLETED' &&
            store.statusForJob(USER_ID, other)?.status === 'COMPLETED'),
      );
      await waitUntil(
        () =>
          (store.statusForJob(USER_ID, first)?.checkpoint ?? -1) >=
          Math.min(step + 1, 3),
      );
    }
    expect(store.statusForJob(USER_ID, first)?.status).toBe('COMPLETED');
    expect(store.statusForJob(USER_ID, other)?.status).toBe('COMPLETED');
    runner.tick();
    expect(store.getRunningJob(next)?.status).toBe('RUNNING');
    await waitUntil(() => sleeper.count === 1);
    for (let step = 0; step < 3; step += 1) {
      sleeper.releaseAll();
      await waitUntil(
        () =>
          (store.statusForJob(USER_ID, next)?.checkpoint ?? -1) >=
          Math.min(step + 1, 3),
      );
    }
    expect(store.statusForJob(USER_ID, next)?.status).toBe('COMPLETED');
    await runner.stop();
    store.close();
  });

  it('waits for input once, resumes the same Job, applies steering at a safe point, and preserves its deadline', async () => {
    const now = 5000;
    const store = memoryStore({ now: () => now });
    createSession(store);
    const jobId = queue(store, 'ask: details');
    const sleeper = new ManualSleep();
    const runner = new DemoRunner(
      store,
      testConfig({ JOB_TIMEOUT_MS: '60000' }),
      {
        clock: { now: () => now },
        sleep: sleeper.sleep,
      },
    );
    runner.tick();
    const originalDeadline = store.statusForJob(USER_ID, jobId)?.deadlineAt;
    sleeper.releaseAll();
    await waitUntil(
      () => store.statusForJob(USER_ID, jobId)?.status === 'WAITING_INPUT',
    );
    expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
      checkpoint: 1,
      status: 'WAITING_INPUT',
    });
    expect(
      store.dueOutbox(now).filter((item) => item.kind === 'prompt'),
    ).toHaveLength(1);

    store.transaction(() =>
      store.steerJob(USER_ID, jobId, 'more detail', 100, CHAT_ID),
    );
    runner.tick();
    expect(store.statusForJob(USER_ID, jobId)?.status).toBe('RUNNING');
    expect(store.statusForJob(USER_ID, jobId)?.deadlineAt).toBe(
      originalDeadline,
    );
    await waitUntil(() => sleeper.count === 1);
    sleeper.releaseAll();
    await waitUntil(() => store.statusForJob(USER_ID, jobId)?.checkpoint === 2);
    expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
      status: 'RUNNING',
      appliedSteering: ['more detail'],
    });
    sleeper.releaseAll();
    await waitUntil(
      () => store.statusForJob(USER_ID, jobId)?.status === 'COMPLETED',
    );
    expect(
      store
        .dueOutbox(now)
        .some(
          (item) =>
            item.kind === 'completed' &&
            item.text.includes('Original input: ask: details') &&
            item.text.includes('more detail'),
        ),
    ).toBe(true);
    await runner.stop();
    store.close();
  });

  it('fails pending steering on deadline and demo failure, then allows the next FIFO job', async () => {
    let now = 2000;
    const store = memoryStore({ now: () => now });
    createSession(store);
    const timeoutJob = queue(store, 'ask: wait');
    const queuedAfter = queue(store, 'next after timeout');
    const sleeper = new ManualSleep();
    const runner = new DemoRunner(
      store,
      testConfig({ JOB_TIMEOUT_MS: '1000' }),
      {
        clock: { now: () => now },
        sleep: sleeper.sleep,
      },
    );
    runner.tick();
    sleeper.releaseAll();
    await waitUntil(
      () => store.statusForJob(USER_ID, timeoutJob)?.status === 'WAITING_INPUT',
    );
    store.transaction(() =>
      store.steerJob(USER_ID, timeoutJob, 'late details', 100, CHAT_ID),
    );
    now = 3000;
    runner.tick();
    expect(store.statusForJob(USER_ID, timeoutJob)).toMatchObject({
      status: 'FAILED',
      failureCode: 'TIMEOUT',
      pendingSteering: 0,
      notAppliedSteering: 1,
    });
    expect(store.statusForJob(USER_ID, queuedAfter)?.status).toBe('RUNNING');
    await runner.stop();

    const failStore = memoryStore({ now: () => 4000 });
    createSession(failStore);
    const failJob = queue(failStore, 'fail: deliberate');
    const subsequent = queue(failStore, 'subsequent');
    failStore.transaction(() =>
      failStore.steerJob(USER_ID, failJob, 'do not apply', 100, CHAT_ID),
    );
    const failSleeper = new ManualSleep();
    const failRunner = new DemoRunner(failStore, testConfig(), {
      clock: { now: () => 4000 },
      sleep: failSleeper.sleep,
    });
    failRunner.tick();
    failSleeper.releaseAll();
    await waitUntil(
      () => failStore.statusForJob(USER_ID, failJob)?.status === 'FAILED',
    );
    expect(failStore.statusForJob(USER_ID, failJob)).toMatchObject({
      failureCode: 'DEMO_FAILURE',
      pendingSteering: 0,
      notAppliedSteering: 1,
    });
    failRunner.tick();
    expect(failStore.statusForJob(USER_ID, subsequent)?.status).toBe('RUNNING');
    await failRunner.stop();
    store.close();
    failStore.close();
  });

  it('reopens a real SQLite file at its checkpoint and rejects a lower concurrency that breaks the partition limit', async () => {
    await ensureArtifactsDirectory();
    const path = artifactsPath('runner-reopen');
    let store = new ControllerStore(new DatabaseSync(path), {
      now: () => 1000,
    });
    createSession(store, 'persisted');
    const first = queue(store, 'first persisted');
    store.scheduleAvailable(1000, 1, 20_000);
    store.advanceStep(first, 1500);
    expect(store.statusForJob(USER_ID, first)).toMatchObject({
      checkpoint: 1,
      deadlineAt: 21_000,
    });
    store.close();

    store = new ControllerStore(new DatabaseSync(path), { now: () => 5000 });
    expect(store.statusForJob(USER_ID, first)).toMatchObject({
      status: 'RUNNING',
      checkpoint: 1,
      deadlineAt: 21_000,
    });
    const sleeper = new ManualSleep();
    const runner = new DemoRunner(store, testConfig({ DEMO_STEP_MS: '1' }), {
      clock: { now: () => 5000 },
      sleep: sleeper.sleep,
    });
    runner.tick();
    await waitUntil(() => sleeper.count === 1);
    sleeper.releaseAll();
    await waitUntil(() => store.statusForJob(USER_ID, first)?.checkpoint === 2);
    await runner.stop();
    store.close();

    const crowded = new ControllerStore(new DatabaseSync(path), {
      now: () => 6000,
    });
    crowded.transaction(() => {
      crowded.createSession(USER_ID, '626262', 'second partition');
      crowded.queueJob(USER_ID, '626262', 'second active', 100);
    });
    crowded.scheduleAvailable(6000, 2, 20_000);
    expect(
      () => new DemoRunner(crowded, testConfig({ JOB_CONCURRENCY: '1' })),
    ).toThrow(/exceed JOB_CONCURRENCY/);
    crowded.close();
    await removeDatabaseArtifacts(path);
  });

  it('consumes steering submitted at checkpoint two before completion and rejects steering after completion', () => {
    const store = memoryStore({ now: () => 1000 });
    const router = new TelegramRouter(store, testConfig());
    router.handle(makeUpdate(1, '/new race-session'));
    router.handle(makeUpdate(2, '/queue finish-at-three'));
    const job = store.database.prepare('SELECT id FROM jobs').get() as {
      id: string;
    };
    store.scheduleAvailable(1000, 1, 60_000);
    store.advanceStep(job.id, 1001);
    store.advanceStep(job.id, 1002);
    expect(store.statusForJob(USER_ID, job.id)).toMatchObject({
      status: 'RUNNING',
      checkpoint: 2,
    });

    router.handle(makeUpdate(3, `/steer ${job.id} committed-before-finish`));
    expect(store.statusForJob(USER_ID, job.id)).toMatchObject({
      status: 'RUNNING',
      checkpoint: 2,
      pendingSteering: 1,
      appliedSteering: [],
    });
    const completed = store.advanceStep(job.id, 1003);
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      checkpoint: 3,
      pendingSteering: 0,
      appliedSteering: ['committed-before-finish'],
    });
    const completionRows = store.database
      .prepare("SELECT text FROM outbox WHERE kind='completed' AND job_id=?")
      .all(job.id);
    expect(completionRows).toHaveLength(1);
    expect((completionRows[0] as { text: string }).text).toContain(
      'committed-before-finish',
    );

    const completionBeforeLateSteer = store.database
      .prepare(
        "SELECT id, text, status FROM outbox WHERE kind='completed' AND job_id=?",
      )
      .all(job.id);
    router.handle(makeUpdate(4, `/steer ${job.id} too-late`));
    expect(store.statusForJob(USER_ID, job.id)).toMatchObject({
      status: 'COMPLETED',
      checkpoint: 3,
      appliedSteering: ['committed-before-finish'],
      pendingSteering: 0,
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE kind='steering'")
        .get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare(
          "SELECT id, text, status FROM outbox WHERE kind='completed' AND job_id=?",
        )
        .all(job.id),
    ).toEqual(completionBeforeLateSteer);
    expect(store.getOffset()).toBe(5);
    store.close();
  });

  it('keeps steering pending during RUNNING until a safe point and preserves its order in output', () => {
    const store = memoryStore({ now: () => 2000 });
    const router = new TelegramRouter(store, testConfig());
    router.handle(makeUpdate(1, '/new steering-order'));
    router.handle(makeUpdate(2, '/queue ordered-output'));
    const job = store.database.prepare('SELECT id FROM jobs').get() as {
      id: string;
    };
    store.scheduleAvailable(2000, 1, 60_000);
    router.handle(makeUpdate(3, `/steer ${job.id} first-detail`));
    router.handle(makeUpdate(4, `/steer ${job.id} second-detail`));
    expect(store.statusForJob(USER_ID, job.id)).toMatchObject({
      status: 'RUNNING',
      checkpoint: 0,
      pendingSteering: 2,
      appliedSteering: [],
    });
    expect(
      store.database
        .prepare(
          "SELECT content, steering_state FROM messages WHERE kind='steering' ORDER BY sequence",
        )
        .all(),
    ).toEqual([
      { content: 'first-detail', steering_state: 'pending' },
      { content: 'second-detail', steering_state: 'pending' },
    ]);
    store.advanceStep(job.id, 2001);
    expect(store.statusForJob(USER_ID, job.id)).toMatchObject({
      checkpoint: 1,
      pendingSteering: 0,
      appliedSteering: ['first-detail', 'second-detail'],
    });
    store.advanceStep(job.id, 2002);
    store.advanceStep(job.id, 2003);
    const completion = store.database
      .prepare("SELECT text FROM outbox WHERE kind='completed' AND job_id=?")
      .get(job.id) as { text: string };
    expect(completion.text.indexOf('first-detail')).toBeLessThan(
      completion.text.indexOf('second-detail'),
    );
    store.close();
  });

  it('applies pre-step steering at step one but still asks once for a new supplement', () => {
    const store = memoryStore({ now: () => 2500 });
    createSession(store, 'ask-steering');
    const jobId = queue(store, 'ask: needs more');
    store.transaction(() =>
      store.steerJob(USER_ID, jobId, 'before-first-step', 10, CHAT_ID),
    );
    store.scheduleAvailable(2500, 1, 60_000);
    store.advanceStep(jobId, 2501);
    expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
      status: 'WAITING_INPUT',
      checkpoint: 1,
      appliedSteering: ['before-first-step'],
      pendingSteering: 0,
    });
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt'")
        .get(),
    ).toMatchObject({ count: 1 });
    expect(store.scheduleAvailable(2502, 1, 60_000)).toEqual([]);
    expect(store.statusForJob(USER_ID, jobId)?.status).toBe('WAITING_INPUT');

    store.transaction(() =>
      store.steerJob(USER_ID, jobId, 'new-prompt-answer', 10, CHAT_ID),
    );
    expect(store.scheduleAvailable(2503, 1, 60_000)).toContain(jobId);
    store.advanceStep(jobId, 2504);
    store.advanceStep(jobId, 2505);
    expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
      status: 'COMPLETED',
      appliedSteering: ['before-first-step', 'new-prompt-answer'],
      pendingSteering: 0,
    });
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt'")
        .get(),
    ).toMatchObject({ count: 1 });
    const completion = store.database
      .prepare("SELECT text FROM outbox WHERE kind='completed' AND job_id=?")
      .get(jobId) as { text: string };
    expect(completion.text.indexOf('before-first-step')).toBeLessThan(
      completion.text.indexOf('new-prompt-answer'),
    );
    store.close();
  });

  it('rolls back a direct SQL violation of the one-active-Job partial unique index', () => {
    const store = memoryStore({ now: () => 3000 });
    const sessionId = createSession(store);
    const activeJob = queue(store, 'active');
    store.scheduleAvailable(3000, 1, 60_000);
    expect(() => {
      store.transaction(() => {
        store.database
          .prepare(
            `INSERT INTO jobs(id, session_id, owner_id, chat_id, sequence, input, status, checkpoint,
                              started_at, deadline_at, failure_code, created_at, updated_at)
             VALUES ('illegal-active', ?, ?, ?, 99, 'illegal', 'RUNNING', 0, 3000, 63000, NULL, 3000, 3000)`,
          )
          .run(sessionId, USER_ID, CHAT_ID);
      });
    }).toThrow(/UNIQUE constraint failed: jobs.session_id/);
    expect(store.statusForJob(USER_ID, activeJob)?.status).toBe('RUNNING');
    expect(
      store.database.prepare('SELECT COUNT(*) AS count FROM jobs').get(),
    ).toMatchObject({ count: 1 });
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE id='illegal-active'")
        .get(),
    ).toMatchObject({ count: 0 });
    store.close();
  });

  it('lets another Session run while waiting, blocks same-Session FIFO, and resumes without resetting deadline', () => {
    const store = memoryStore({ now: () => 4000 });
    const firstSession = createSession(store, 'waiting-session');
    const secondSession = createSession(
      store,
      'other-session',
      USER_ID,
      '616161',
    );
    const waitingJob = queue(store, 'ask: waiting', USER_ID, CHAT_ID);
    const sameSessionQueued = queue(
      store,
      'same-session-next',
      USER_ID,
      CHAT_ID,
    );
    const otherSessionJob = queue(
      store,
      'other-session-work',
      USER_ID,
      '616161',
    );

    store.scheduleAvailable(4000, 1, 60_000);
    store.advanceStep(waitingJob, 4001);
    const original = store.statusForJob(USER_ID, waitingJob);
    expect(original).toMatchObject({
      sessionId: firstSession,
      status: 'WAITING_INPUT',
      checkpoint: 1,
      deadlineAt: 64_000,
    });
    expect(store.statusForJob(USER_ID, sameSessionQueued)?.status).toBe(
      'QUEUED',
    );
    expect(store.statusForJob(USER_ID, otherSessionJob)?.sessionId).toBe(
      secondSession,
    );

    store.scheduleAvailable(4002, 1, 60_000);
    expect(store.statusForJob(USER_ID, otherSessionJob)?.status).toBe(
      'RUNNING',
    );
    expect(store.statusForJob(USER_ID, waitingJob)?.status).toBe(
      'WAITING_INPUT',
    );
    expect(store.statusForJob(USER_ID, sameSessionQueued)?.status).toBe(
      'QUEUED',
    );
    store.transaction(() =>
      store.steerJob(USER_ID, waitingJob, 'resume-details', 10, CHAT_ID),
    );
    store.scheduleAvailable(4003, 1, 60_000);
    expect(store.statusForJob(USER_ID, waitingJob)).toMatchObject({
      status: 'WAITING_INPUT',
      deadlineAt: original?.deadlineAt,
      pendingSteering: 1,
    });

    store.advanceStep(otherSessionJob, 4004);
    store.advanceStep(otherSessionJob, 4005);
    store.advanceStep(otherSessionJob, 4006);
    store.scheduleAvailable(4007, 1, 60_000);
    expect(store.statusForJob(USER_ID, waitingJob)).toMatchObject({
      status: 'RUNNING',
      startedAt: original?.startedAt,
      deadlineAt: original?.deadlineAt,
      pendingSteering: 1,
    });
    store.advanceStep(waitingJob, 4008);
    store.advanceStep(waitingJob, 4009);
    expect(store.statusForJob(USER_ID, waitingJob)).toMatchObject({
      status: 'COMPLETED',
      appliedSteering: ['resume-details'],
      deadlineAt: original?.deadlineAt,
    });
    store.scheduleAvailable(4010, 1, 60_000);
    expect(store.statusForJob(USER_ID, sameSessionQueued)?.status).toBe(
      'RUNNING',
    );
    store.close();
  });
});
