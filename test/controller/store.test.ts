import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { DemoRunner } from '../../src/controller/runner.js';
import { TelegramRouter } from '../../src/controller/router.js';
import { ControllerStore } from '../../src/controller/store.js';
import {
  artifactsPath,
  createSession,
  makeUpdate,
  ensureArtifactsDirectory,
  removeDatabaseArtifacts,
  testConfig,
  USER_ID,
  CHAT_ID,
} from './helpers.js';

function count(
  store: ControllerStore,
  sql: string,
  ...params: string[]
): number {
  const row = store.database.prepare(sql).get(...params) as
    { count: number } | undefined;
  return row?.count ?? 0;
}

function closeReopenedStores(stores: readonly ControllerStore[]): void {
  for (const store of stores) store.close();
}

describe('SQLite controller persistence and recovery', () => {
  beforeEach(async () => {
    await ensureArtifactsDirectory();
  });

  it('reopens a RUNNING Job at checkpoint one and completes with exactly two more steps', async () => {
    const path = artifactsPath('store-running-reopen');
    const stores: ControllerStore[] = [];
    try {
      let store = new ControllerStore(new DatabaseSync(path), {
        now: () => 1000,
      });
      stores.push(store);
      createSession(store, 'checkpoint-session');
      const jobId = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'resume-after-one', 10),
      );
      store.scheduleAvailable(1000, 1, 5000);
      store.advanceStep(jobId, 1500);
      expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
        status: 'RUNNING',
        checkpoint: 1,
        startedAt: 1000,
        deadlineAt: 6000,
      });
      store.close();

      store = new ControllerStore(new DatabaseSync(path), { now: () => 2000 });
      stores.push(store);
      expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
        status: 'RUNNING',
        checkpoint: 1,
        startedAt: 1000,
        deadlineAt: 6000,
      });
      store.advanceStep(jobId, 2500);
      expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
        status: 'RUNNING',
        checkpoint: 2,
        deadlineAt: 6000,
      });
      store.advanceStep(jobId, 3000);
      expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
        status: 'COMPLETED',
        checkpoint: 3,
        deadlineAt: 6000,
      });
      expect(
        count(
          store,
          "SELECT COUNT(*) AS count FROM outbox WHERE kind='completed'",
        ),
      ).toBe(1);
    } finally {
      closeReopenedStores(stores);
      await removeDatabaseArtifacts(path);
    }
  });

  it('refuses a lower restart concurrency without changing durable RUNNING Jobs', async () => {
    const path = artifactsPath('store-concurrency-reopen');
    const stores: ControllerStore[] = [];
    try {
      let store = new ControllerStore(new DatabaseSync(path), {
        now: () => 1000,
      });
      stores.push(store);
      createSession(store, 'first-running-session');
      createSession(store, 'second-running-session', USER_ID, '616161');
      store.transaction(() => {
        store.queueJob(USER_ID, CHAT_ID, 'first-running', 10);
        store.queueJob(USER_ID, '616161', 'second-running', 10);
      });
      store.scheduleAvailable(1000, 2, 60_000);
      const before = store.database
        .prepare(
          'SELECT id, status, checkpoint, started_at, deadline_at FROM jobs ORDER BY id',
        )
        .all();
      expect(before).toHaveLength(2);
      expect(
        (before as Array<{ status: string }>).every(
          (job) => job.status === 'RUNNING',
        ),
      ).toBe(true);
      store.close();

      store = new ControllerStore(new DatabaseSync(path), { now: () => 2000 });
      stores.push(store);
      expect(
        () => new DemoRunner(store, testConfig({ JOB_CONCURRENCY: '1' })),
      ).toThrow(/exceed JOB_CONCURRENCY/);
      const after = store.database
        .prepare(
          'SELECT id, status, checkpoint, started_at, deadline_at FROM jobs ORDER BY id',
        )
        .all();
      expect(after).toEqual(before);
      expect(store.getOffset()).toBe(0);
    } finally {
      closeReopenedStores(stores);
      await removeDatabaseArtifacts(path);
    }
  });

  it('keeps one WAITING_INPUT prompt after reopen and repeated scheduler ticks', async () => {
    const path = artifactsPath('store-waiting-reopen');
    const stores: ControllerStore[] = [];
    let runner: DemoRunner | undefined;
    try {
      let store = new ControllerStore(new DatabaseSync(path), {
        now: () => 1000,
      });
      stores.push(store);
      createSession(store, 'waiting-session');
      const jobId = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'ask: reopen', 10),
      );
      store.scheduleAvailable(1000, 1, 60_000);
      store.advanceStep(jobId, 1001);
      expect(store.statusForJob(USER_ID, jobId)?.status).toBe('WAITING_INPUT');
      expect(
        count(
          store,
          "SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt'",
        ),
      ).toBe(1);
      store.close();

      store = new ControllerStore(new DatabaseSync(path), { now: () => 2000 });
      stores.push(store);
      runner = new DemoRunner(store, testConfig(), {
        clock: { now: () => 2000 },
        sleep: () => Promise.resolve(),
      });
      runner.tick();
      runner.tick();
      runner.tick();
      expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
        status: 'WAITING_INPUT',
        checkpoint: 1,
      });
      expect(
        count(
          store,
          "SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt'",
        ),
      ).toBe(1);
      expect(
        count(
          store,
          "SELECT COUNT(*) AS count FROM outbox WHERE kind='prompt' AND status='PENDING'",
        ),
      ).toBe(1);
    } finally {
      await runner?.stop();
      closeReopenedStores(stores);
      await removeDatabaseArtifacts(path);
    }
  });

  it('persists QUEUED Jobs, selected binding, processed updates, and poll offset', async () => {
    const path = artifactsPath('store-input-reopen');
    const stores: ControllerStore[] = [];
    try {
      let store = new ControllerStore(new DatabaseSync(path), {
        now: () => 1000,
      });
      stores.push(store);
      const router = new TelegramRouter(store, testConfig());
      router.handle(makeUpdate(20, '/new persisted-binding'));
      router.handle(makeUpdate(21, '/queue persisted-queued'));
      const queued = store.database.prepare('SELECT id FROM jobs').get() as {
        id: string;
      };
      expect(store.getOffset()).toBe(22);
      store.close();

      store = new ControllerStore(new DatabaseSync(path), { now: () => 2000 });
      stores.push(store);
      expect(store.selectedSession(USER_ID, CHAT_ID)?.name).toBe(
        'persisted-binding',
      );
      expect(store.statusForJob(USER_ID, queued.id)).toMatchObject({
        status: 'QUEUED',
        input: 'persisted-queued',
        sequence: 1,
      });
      expect(store.isUpdateProcessed(20)).toBe(true);
      expect(store.isUpdateProcessed(21)).toBe(true);
      expect(store.isUpdateProcessed(22)).toBe(false);
      expect(store.getOffset()).toBe(22);
    } finally {
      closeReopenedStores(stores);
      await removeDatabaseArtifacts(path);
    }
  });

  it('expires overdue work before scheduling the next queued Job after restart', async () => {
    const path = artifactsPath('store-expire-reopen');
    const stores: ControllerStore[] = [];
    let runner: DemoRunner | undefined;
    try {
      let store = new ControllerStore(new DatabaseSync(path), {
        now: () => 1000,
      });
      stores.push(store);
      createSession(store, 'deadline-session');
      const overdue = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'ask: overdue', 10),
      );
      const next = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'run-next', 10),
      );
      store.scheduleAvailable(1000, 1, 1000);
      store.advanceStep(overdue, 1001);
      store.transaction(() =>
        store.steerJob(USER_ID, overdue, 'late input', 10, CHAT_ID),
      );
      expect(store.statusForJob(USER_ID, overdue)).toMatchObject({
        status: 'WAITING_INPUT',
        deadlineAt: 2000,
        pendingSteering: 1,
      });
      store.close();

      store = new ControllerStore(new DatabaseSync(path), { now: () => 3000 });
      stores.push(store);
      runner = new DemoRunner(store, testConfig({ JOB_TIMEOUT_MS: '1000' }), {
        clock: { now: () => 3000 },
        sleep: (_milliseconds, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
      });
      runner.tick();
      expect(store.statusForJob(USER_ID, overdue)).toMatchObject({
        status: 'FAILED',
        failureCode: 'TIMEOUT',
        pendingSteering: 0,
        notAppliedSteering: 1,
      });
      expect(store.statusForJob(USER_ID, next)).toMatchObject({
        status: 'RUNNING',
        checkpoint: 0,
      });
      expect(count(store, 'SELECT COUNT(*) AS count FROM jobs')).toBe(2);
    } finally {
      await runner?.stop();
      closeReopenedStores(stores);
      await removeDatabaseArtifacts(path);
    }
  });

  it('reopens delivered and delayed PENDING outbox rows without resending delivery', async () => {
    const path = artifactsPath('store-outbox-reopen');
    const stores: ControllerStore[] = [];
    try {
      let store = new ControllerStore(new DatabaseSync(path), {
        now: () => 1000,
      });
      stores.push(store);
      createSession(store, 'outbox-session');
      store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'outbox-job', 10),
      );
      const due = store.dueOutbox(1000);
      const reply = due.find((item) => item.kind === 'reply');
      const ack = due.find((item) => item.kind === 'ack');
      if (reply === undefined || ack === undefined)
        throw new Error('Expected reply and acknowledgement outbox rows.');
      store.deliverOutbox(reply.id, Number(CHAT_ID), 555, 1100);
      store.retryOutbox(ack.id, 5000);
      store.close();

      store = new ControllerStore(new DatabaseSync(path), { now: () => 2000 });
      stores.push(store);
      expect(store.dueOutbox(4000).map((item) => item.id)).toEqual([]);
      expect(store.dueOutbox(5000).map((item) => item.id)).toEqual([ack.id]);
      expect(
        store.database
          .prepare('SELECT status, attempts FROM outbox WHERE id=?')
          .get(reply.id),
      ).toEqual({ status: 'DELIVERED', attempts: 1 });
      expect(
        store.database
          .prepare(
            'SELECT status, attempts, next_attempt_at FROM outbox WHERE id=?',
          )
          .get(ack.id),
      ).toEqual({ status: 'PENDING', attempts: 1, next_attempt_at: 5000 });
    } finally {
      closeReopenedStores(stores);
      await removeDatabaseArtifacts(path);
    }
  });
});
