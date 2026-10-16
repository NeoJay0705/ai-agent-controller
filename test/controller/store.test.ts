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

function downgradeToV2(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE trial_usage_events;
    DROP TABLE trial_usage_operations;
    DROP TABLE command_menu_sync;
    DROP TABLE command_dialogs;
    DROP TABLE trial_invites;
    DROP TABLE trial_events;
    DROP TABLE trial_users;
    ALTER TABLE outbox DROP COLUMN delivery_class;
    PRAGMA user_version = 2;
  `);
}

function downgradeToV1(database: DatabaseSync): void {
  downgradeToV2(database);
  database.exec(`
    DROP TABLE outbox_cancellations;
    DROP TABLE pi_sessions;
    DROP TABLE session_facts;
    DROP TABLE flow_runs;
    ALTER TABLE outbox DROP COLUMN prompt_generation;
    ALTER TABLE prompt_bindings DROP COLUMN generation;
    PRAGMA user_version = 1;
  `);
}

function createV1Fixture(path: string, offset: string | null): void {
  const initial = new ControllerStore(new DatabaseSync(path));
  initial.close();
  const database = new DatabaseSync(path);
  try {
    downgradeToV1(database);
    if (offset === null) {
      database.prepare("DELETE FROM meta WHERE key='next_poll_offset'").run();
    } else {
      database
        .prepare("UPDATE meta SET value=? WHERE key='next_poll_offset'")
        .run(offset);
    }
  } finally {
    database.close();
  }
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
      const router = new TelegramRouter(store, testConfig(), {
        readyAtSec: () => 0,
      });
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

  it('migrates a synthetic schema-v1 database to v2 without rewriting existing rows', async () => {
    const path = artifactsPath('store-v1-migration');
    const database = new DatabaseSync(path);
    try {
      let store = new ControllerStore(database, { now: () => 1000 });
      const sessionId = createSession(store, 'migration-session');
      const jobId = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'legacy job', 10),
      );
      store.transaction(() => {
        store.enqueueJobNotification(jobId, 'prompt', 'legacy prompt', 0);
        store.database
          .prepare("UPDATE jobs SET status='WAITING_INPUT' WHERE id=?")
          .run(jobId);
      });
      const prompt = store
        .dueOutbox(1000)
        .find((item) => item.kind === 'prompt');
      if (prompt === undefined) throw new Error('Expected a legacy prompt.');
      store.deliverOutbox(prompt.id, Number(CHAT_ID), 88001, 1001);
      store.recordUpdate(55);

      downgradeToV1(database);
      database
        .prepare("UPDATE meta SET value='0' WHERE key='next_poll_offset'")
        .run();
      database
        .prepare(
          "UPDATE meta SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key='next_poll_offset'",
        )
        .run(56);
      expect(
        database
          .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
          .get(),
      ).toEqual({ value: '56.0' });
      store = new ControllerStore(database, { now: () => 2000 });

      expect(
        (
          database.prepare('PRAGMA user_version').get() as {
            user_version: number;
          }
        ).user_version,
      ).toBe(3);
      expect(store.getOffset()).toBe(56);
      expect(
        database
          .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
          .get(),
      ).toEqual({ value: '56' });
      expect(store.isUpdateProcessed(55)).toBe(true);
      expect(store.statusForJob(USER_ID, jobId)).toMatchObject({
        sessionId,
        input: 'legacy job',
        status: 'WAITING_INPUT',
      });
      expect(store.findPrompt(CHAT_ID, 88001)).toMatchObject({
        jobId,
        active: true,
        generation: 0,
      });
      expect(
        database
          .prepare('SELECT status, prompt_generation FROM outbox WHERE id=?')
          .get(prompt.id),
      ).toEqual({ status: 'DELIVERED', prompt_generation: null });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
      ).toEqual({ count: 3 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE job_id=?')
          .get(jobId),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM bindings WHERE session_id=?')
          .get(sessionId),
      ).toEqual({ count: 1 });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM flow_runs').get(),
      ).toEqual({ count: 0 });
    } finally {
      try {
        database.close();
      } catch {
        // A failed migration closes its connection before the assertion.
      }
      await removeDatabaseArtifacts(path);
    }
  });

  it('preserves a canonical schema-v1 offset string during migration', async () => {
    const path = artifactsPath('store-v1-canonical-offset');
    try {
      createV1Fixture(path, '0007');
      const store = new ControllerStore(new DatabaseSync(path));
      try {
        expect(store.getOffset()).toBe(7);
        expect(
          store.database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toEqual({ value: '0007' });
      } finally {
        store.close();
      }
    } finally {
      await removeDatabaseArtifacts(path);
    }
  });

  it('migrates a zero-valued legacy decimal without changing its value', async () => {
    const path = artifactsPath('store-v1-zero-legacy-offset');
    try {
      createV1Fixture(path, '0.000');
      const store = new ControllerStore(new DatabaseSync(path));
      try {
        expect(store.getOffset()).toBe(0);
        expect(
          store.database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toEqual({ value: '0' });
        expect(
          store.database.prepare('PRAGMA user_version').get(),
        ).toMatchObject({ user_version: 3 });
      } finally {
        store.close();
      }
    } finally {
      await removeDatabaseArtifacts(path);
    }
  });

  it('migrates the exact MAX_SAFE_INTEGER legacy boundary without changing its value', async () => {
    const path = artifactsPath('store-v1-max-safe-offset');
    const offset = `${String(Number.MAX_SAFE_INTEGER)}.0`;
    try {
      createV1Fixture(path, offset);
      const store = new ControllerStore(new DatabaseSync(path));
      try {
        expect(store.getOffset()).toBe(Number.MAX_SAFE_INTEGER);
        expect(
          store.database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toEqual({ value: String(Number.MAX_SAFE_INTEGER) });
        expect(
          store.database.prepare('PRAGMA user_version').get(),
        ).toMatchObject({ user_version: 3 });
      } finally {
        store.close();
      }
    } finally {
      await removeDatabaseArtifacts(path);
    }
  });

  it.each([
    '9007199254740992',
    '-1',
    '+1',
    ' 1',
    '1 ',
    '',
    'NaN',
    'Infinity',
    '1e3',
    '1.5',
    '1.00000000000000001',
    '9007199254740992.0',
    '1\n',
    '1\r',
    '1\r\n',
    '1\u2028',
    '1\u2029',
    '1.0\n',
    '1.0\r',
    '1.0\r\n',
    '1.0\u2028',
    '1.0\u2029',
  ])(
    'rejects invalid schema-v1 poll metadata %j without changing it',
    async (offset) => {
      const path = artifactsPath('store-v1-invalid-offset');
      try {
        createV1Fixture(path, offset);
        expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
          'Controller database metadata is incomplete.',
        );
        const database = new DatabaseSync(path);
        try {
          expect(
            database
              .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
              .get(),
          ).toEqual({ value: offset });
          expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
            user_version: 1,
          });
        } finally {
          database.close();
        }
      } finally {
        await removeDatabaseArtifacts(path);
      }
    },
  );

  it('rejects missing schema-v1 poll metadata without changing the schema version', async () => {
    const path = artifactsPath('store-v1-missing-offset');
    try {
      createV1Fixture(path, null);
      expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
        'Controller database metadata is incomplete.',
      );
      const database = new DatabaseSync(path);
      try {
        expect(
          database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toBeUndefined();
        expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
          user_version: 1,
        });
      } finally {
        database.close();
      }
    } finally {
      await removeDatabaseArtifacts(path);
    }
  });

  it.each(['1\n', '1\r', '1\r\n', '1\u2028', '1\u2029'])(
    'rejects schema-v2 poll metadata ending in a line terminator %j without changing it',
    async (offset) => {
      const path = artifactsPath('store-v2-line-terminated-offset');
      const initialized = new ControllerStore(new DatabaseSync(path));
      downgradeToV2(initialized.database);
      initialized.database
        .prepare("UPDATE meta SET value=? WHERE key='next_poll_offset'")
        .run(offset);
      initialized.close();
      try {
        expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
          'Controller database metadata is incomplete.',
        );
        const database = new DatabaseSync(path);
        try {
          expect(
            database
              .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
              .get(),
          ).toEqual({ value: offset });
          expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
            user_version: 2,
          });
        } finally {
          database.close();
        }
      } finally {
        await removeDatabaseArtifacts(path);
      }
    },
  );

  it('keeps schema-v2 poll metadata validation strict for legacy decimal strings', async () => {
    const path = artifactsPath('store-v2-decimal-offset');
    const initialized = new ControllerStore(new DatabaseSync(path));
    downgradeToV2(initialized.database);
    initialized.database
      .prepare("UPDATE meta SET value='1.0' WHERE key='next_poll_offset'")
      .run();
    initialized.close();
    try {
      expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
        'Controller database metadata is incomplete.',
      );
      const database = new DatabaseSync(path);
      try {
        expect(
          database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toEqual({ value: '1.0' });
        expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
          user_version: 2,
        });
      } finally {
        database.close();
      }
    } finally {
      await removeDatabaseArtifacts(path);
    }
  });

  it('rolls back the legacy offset and all v1-to-v2 DDL after a schema conflict', async () => {
    const path = artifactsPath('store-v1-migration-rollback');
    try {
      createV1Fixture(path, '56.0');
      const raw = new DatabaseSync(path);
      raw
        .prepare(
          'INSERT INTO sessions(id, owner_id, name, created_at, next_sequence) VALUES (?, ?, ?, ?, ?)',
        )
        .run('rollback-session', USER_ID, 'rollback', 1, 1);
      raw.exec('CREATE TABLE flow_runs(conflicting INTEGER) STRICT');
      raw.close();

      expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
        'Controller database migration failed.',
      );
      const database = new DatabaseSync(path);
      try {
        expect(
          database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toEqual({ value: '56.0' });
        expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
          user_version: 1,
        });
        expect(database.prepare('SELECT id FROM sessions').all()).toEqual([
          { id: 'rollback-session' },
        ]);
        expect(
          database.prepare('PRAGMA table_info(outbox)').all(),
        ).not.toContainEqual(
          expect.objectContaining({ name: 'prompt_generation' }),
        );
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='session_facts'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
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
