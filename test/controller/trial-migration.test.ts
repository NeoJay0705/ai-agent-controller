import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { ControllerStore } from '../../src/controller/store.js';
import { artifactsPath, ensureArtifactsDirectory } from './helpers.js';

function removeV3Schema(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE trial_usage_events;
    DROP TABLE trial_usage_operations;
    DROP TABLE command_menu_sync;
    DROP TABLE command_dialogs;
    DROP TABLE trial_invites;
    DROP TABLE trial_events;
    DROP TABLE trial_users;
    ALTER TABLE outbox DROP COLUMN delivery_class;
  `);
}

describe('schema v3 trial migration', () => {
  it('rolls back a v0 migration when late trial DDL fails', async () => {
    await ensureArtifactsDirectory();
    const path = artifactsPath('controlled-trial-v0-migration-rollback');
    const originalExec = Object.getOwnPropertyDescriptor(
      DatabaseSync.prototype,
      'exec',
    )?.value as (this: DatabaseSync, sql: string) => void;
    const spy = vi
      .spyOn(DatabaseSync.prototype, 'exec')
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (/CREATE TABLE\s+trial_users/i.test(sql))
          throw new Error('synthetic trial_users DDL failure');
        originalExec.call(this, sql);
      });
    try {
      expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
        'Controller database migration failed.',
      );
    } finally {
      spy.mockRestore();
    }
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 0,
      });
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      raw.close();
    }

    const normal = new ControllerStore(new DatabaseSync(':memory:'));
    try {
      expect(normal.database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 3,
      });
    } finally {
      normal.close();
    }
  });
  it('initializes v3 tables and outbox delivery classification', () => {
    const store = new ControllerStore(new DatabaseSync(':memory:'));
    try {
      expect(store.database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 3,
      });
      expect(
        store.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='trial_users'",
          )
          .get(),
      ).toEqual({ name: 'trial_users' });
      expect(
        store.database.prepare('PRAGMA table_info(outbox)').all(),
      ).toContainEqual(expect.objectContaining({ name: 'delivery_class' }));
      store.transaction(() => {
        store.reply('synthetic-chat', 'business');
        store.replyControl('synthetic-chat', 'control');
      });
      expect(
        store.database
          .prepare('SELECT text,delivery_class FROM outbox ORDER BY rowid')
          .all(),
      ).toEqual([
        { text: 'business', delivery_class: 'business' },
        { text: 'control', delivery_class: 'control' },
      ]);
    } finally {
      store.close();
    }
  });

  it('rejects a non-canonical v3 poll offset', () => {
    const database = new DatabaseSync(':memory:');
    new ControllerStore(database);
    database
      .prepare("UPDATE meta SET value='1.0' WHERE key='next_poll_offset'")
      .run();
    expect(() => new ControllerStore(database)).toThrow(
      /metadata is incomplete/i,
    );
    try {
      database.close();
    } catch {
      /* Validation closes the database connection. */
    }
  });

  it('rolls back a late v2-to-v3 DDL collision without changing rows, offset, or foreign keys', async () => {
    await ensureArtifactsDirectory();
    const path = artifactsPath('controlled-trial-migration-rollback');
    let database = new DatabaseSync(path);
    const initialized = new ControllerStore(database);
    initialized.transaction(() => {
      initialized.createSession('owner', 'chat', 'legacy-session');
      initialized.queueJob('owner', 'chat', 'legacy-job', 10);
      initialized.database
        .prepare("UPDATE meta SET value='73' WHERE key='next_poll_offset'")
        .run();
    });
    initialized.close();

    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF');
    removeV3Schema(database);
    database.exec(
      'CREATE TABLE trial_users(legacy INTEGER); PRAGMA user_version=2;',
    );
    database.close();

    expect(() => new ControllerStore(new DatabaseSync(path))).toThrow(
      'Controller database migration failed.',
    );
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 2,
      });
      expect(
        raw
          .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
          .get(),
      ).toEqual({ value: '73' });
      expect(
        raw.prepare('SELECT id,input,status FROM jobs').all(),
      ).toMatchObject([{ input: 'legacy-job', status: 'QUEUED' }]);
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_new'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='trial_usage_operations'",
          )
          .get(),
      ).toBeUndefined();
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(raw.prepare('PRAGMA table_info(outbox)').all()).not.toContainEqual(
        expect.objectContaining({ name: 'delivery_class' }),
      );
    } finally {
      raw.close();
    }
  });

  it('migrates v2 Flow rows, facts, and Pi mapping without changing values or foreign keys', () => {
    const database = new DatabaseSync(':memory:');
    new ControllerStore(database);
    database.exec('PRAGMA foreign_keys=OFF');
    database.exec(`
      INSERT INTO sessions VALUES ('s','u','n',1,2);
      INSERT INTO jobs(id,session_id,owner_id,chat_id,sequence,input,status,checkpoint,created_at,updated_at)
        VALUES ('j','s','u','c',1,'x','QUEUED',0,1,1);
      INSERT INTO flow_runs VALUES ('j','{}','flow','node','{}',1,2,3,NULL,NULL);
      INSERT INTO session_facts VALUES ('s','u','name','"A"','{}','f1','b1',2,'user_confirmed');
      INSERT INTO pi_sessions VALUES ('s','pi-id','/synthetic/session.json');
    `);
    removeV3Schema(database);
    database.exec('PRAGMA user_version=2; PRAGMA foreign_keys=ON');
    const store = new ControllerStore(database);
    try {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 3,
      });
      expect(database.prepare('SELECT * FROM flow_runs').get()).toEqual({
        job_id: 'j',
        bundle_json: '{}',
        flow_id: 'flow',
        node_id: 'node',
        state_json: '{}',
        revision: 1,
        transitions: 2,
        prompt_generation: 3,
        wait_deadline: null,
        job_deadline: null,
      });
      expect(
        database.prepare('SELECT * FROM session_facts').get(),
      ).toMatchObject({
        session_id: 's',
        owner_id: 'u',
        kind: 'name',
        value_json: '"A"',
      });
      expect(database.prepare('SELECT * FROM pi_sessions').get()).toEqual({
        session_id: 's',
        pi_session_id: 'pi-id',
        file_path: '/synthetic/session.json',
      });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it.each([
    { table: 'outbox', column: 'prompt_generation' },
    { table: 'trial_users', column: 'tokens_used' },
  ])(
    'rejects v3 schema missing $table.$column on reopen',
    ({ table, column }) => {
      const target = new DatabaseSync(':memory:');
      const initialized = new ControllerStore(target);
      target.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      expect(() => new ControllerStore(target)).toThrow(
        'Controller database schema is incomplete.',
      );
      try {
        initialized.close();
      } catch {
        /* Validation closes the connection. */
      }
    },
  );

  it('preserves the base and v2 outbox columns when validating v3', () => {
    const store = new ControllerStore(new DatabaseSync(':memory:'));
    try {
      store.database.exec('ALTER TABLE outbox DROP COLUMN prompt_generation');
      expect(() => new ControllerStore(store.database)).toThrow(
        'Controller database schema is incomplete.',
      );
    } finally {
      try {
        store.close();
      } catch {
        /* constructor validation closes it */
      }
    }
  });

  it('enforces cancellation status and per-session active-job uniqueness', () => {
    const store = new ControllerStore(new DatabaseSync(':memory:'));
    try {
      store.database
        .prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
        .run('s', 'u', 'n', 1, 1);
      store.database
        .prepare(
          'INSERT INTO jobs(id,session_id,owner_id,chat_id,sequence,input,status,checkpoint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run('j', 's', 'u', 'c', 1, 'x', 'CANCELLING', 0, 1, 1);
      expect(() =>
        store.database
          .prepare(
            'INSERT INTO jobs(id,session_id,owner_id,chat_id,sequence,input,status,checkpoint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .run('j2', 's', 'u', 'c', 2, 'x', 'RUNNING', 0, 1, 1),
      ).toThrow();
      expect(() =>
        store.database
          .prepare('UPDATE jobs SET status=? WHERE id=?')
          .run('INVALID', 'j'),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});
