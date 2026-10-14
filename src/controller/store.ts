import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import type {
  JobRecord,
  JobStatus,
  OutboxKind,
  OutboxRecord,
  PromptRecord,
  SessionRecord,
} from './types.js';

const SCHEMA_VERSION = 1;
const MAX_OUTBOX_UNITS = 3500;
const activeJobStatuses = ['RUNNING', 'WAITING_INPUT'] as const;
const terminalStatuses = ['COMPLETED', 'FAILED'] as const;

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export class ControllerStore {
  readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly id: (kind: string) => string;
  private closed = false;

  constructor(
    database: DatabaseSync,
    options: {
      readonly now?: () => number;
      readonly id?: (kind: string) => string;
    } = {},
  ) {
    this.database = database;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? ((kind) => `${kind}_${randomUUID()}`);
    try {
      this.validateExistingSchema();
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('PRAGMA busy_timeout = 5000');
      this.initializeSchema();
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
  }

  transaction<T>(callback: () => T): T {
    this.assertOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        throw new TypeError('SQLite transaction callback must be synchronous');
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original transaction error is authoritative.
      }
      throw error;
    }
  }

  savepoint<T>(callback: () => T): T {
    this.database.exec('SAVEPOINT route_business');
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        throw new TypeError('SQLite savepoint callback must be synchronous');
      }
      this.database.exec('RELEASE route_business');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK TO route_business');
      this.database.exec('RELEASE route_business');
      throw error;
    }
  }

  getOffset(): number {
    const row = this.database
      .prepare("SELECT value FROM meta WHERE key = 'next_poll_offset'")
      .get() as { value?: unknown } | undefined;
    if (row === undefined) return 0;
    const offset = Number(row.value);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new TypeError('Invalid SQLite poll offset.');
    return offset;
  }

  isUpdateProcessed(updateId: number): boolean {
    return (
      this.database
        .prepare('SELECT 1 AS found FROM processed_updates WHERE update_id = ?')
        .get(updateId) !== undefined
    );
  }

  recordUpdate(updateId: number): void {
    this.database
      .prepare(
        'INSERT INTO processed_updates(update_id, processed_at) VALUES (?, ?)',
      )
      .run(updateId, this.now());
    this.database
      .prepare(
        "UPDATE meta SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'next_poll_offset'",
      )
      .run(updateId + 1);
  }

  reply(chatId: string, body: string, sessionId: string | null = null): void {
    this.enqueue(sessionId, null, 'reply', body, undefined, chatId);
  }

  createSession(ownerId: string, chatId: string, name: string): SessionRecord {
    const now = this.now();
    const session: SessionRecord = {
      id: this.id('ses'),
      ownerId,
      name,
      createdAt: now,
      nextSequence: 1,
    };
    this.database
      .prepare(
        'INSERT INTO sessions(id, owner_id, name, created_at, next_sequence) VALUES (?, ?, ?, ?, 1)',
      )
      .run(session.id, ownerId, name, now);
    this.database
      .prepare(
        `INSERT INTO bindings(user_id, chat_id, session_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, chat_id) DO UPDATE SET session_id=excluded.session_id`,
      )
      .run(ownerId, chatId, session.id);
    this.enqueue(
      session.id,
      null,
      'reply',
      `Session created and selected: ${name} (${session.id}).`,
      undefined,
      chatId,
    );
    return session;
  }

  listSessions(ownerId: string): readonly SessionRecord[] {
    const rows = this.database
      .prepare(
        'SELECT id, owner_id, name, created_at, next_sequence FROM sessions WHERE owner_id = ? ORDER BY created_at, id',
      )
      .all(ownerId) as Record<string, unknown>[];
    return rows.map((row) => mapSession(row));
  }

  selectedSession(ownerId: string, chatId: string): SessionRecord | null {
    const row = this.database
      .prepare(
        `SELECT s.id, s.owner_id, s.name, s.created_at, s.next_sequence
         FROM bindings b JOIN sessions s ON s.id = b.session_id
         WHERE b.user_id = ? AND b.chat_id = ? AND s.owner_id = ?`,
      )
      .get(ownerId, chatId, ownerId) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapSession(row);
  }

  useSession(
    ownerId: string,
    chatId: string,
    sessionId: string,
  ): SessionRecord {
    const row = this.database
      .prepare(
        'SELECT id, owner_id, name, created_at, next_sequence FROM sessions WHERE id = ? AND owner_id = ?',
      )
      .get(sessionId, ownerId) as Record<string, unknown> | undefined;
    if (row === undefined)
      throw new DomainError('NOT_FOUND', 'Session not found.');
    this.database
      .prepare(
        `INSERT INTO bindings(user_id, chat_id, session_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, chat_id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(ownerId, chatId, sessionId);
    const session = mapSession(row);
    this.enqueue(
      session.id,
      null,
      'reply',
      `Selected session: ${session.name} (${session.id}).`,
      undefined,
      chatId,
    );
    return session;
  }

  queueJob(
    ownerId: string,
    chatId: string,
    content: string,
    maxPendingJobs: number,
  ): string {
    const session = this.selectedSession(ownerId, chatId);
    if (session === null) {
      throw new DomainError(
        'NO_SESSION',
        'Select a session with /new or /use first.',
      );
    }
    const pending = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_INPUT')",
      )
      .get() as { count: unknown };
    if (asInteger(pending.count, 'pending jobs') >= maxPendingJobs) {
      throw new DomainError(
        'JOB_LIMIT',
        'The pending job limit has been reached.',
      );
    }
    const sequence = this.allocateSequence(session.id);
    const jobId = this.id('job');
    const messageId = this.id('msg');
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO jobs(id, session_id, owner_id, chat_id, sequence, input, status, checkpoint,
                          started_at, deadline_at, failure_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(jobId, session.id, ownerId, chatId, sequence, content, now, now);
    this.database
      .prepare(
        `INSERT INTO messages(id, session_id, job_id, kind, sequence, content, received_at,
                              applied_at, steering_state)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, NULL, NULL)`,
      )
      .run(messageId, session.id, jobId, sequence, content, now);
    this.enqueue(
      session.id,
      jobId,
      'ack',
      `Queued job ${jobId}.`,
      undefined,
      chatId,
    );
    return jobId;
  }

  steerJob(
    ownerId: string,
    jobId: string,
    content: string,
    maxPendingSteering: number,
    chatId: string,
  ): string {
    const job = this.getJobForOwner(ownerId, jobId);
    if (job === null) throw new DomainError('NOT_FOUND', 'Job not found.');
    if (
      terminalStatuses.includes(job.status as (typeof terminalStatuses)[number])
    ) {
      throw new DomainError('TERMINAL', 'That job has already finished.');
    }
    const pending = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE job_id = ? AND kind = 'steering' AND steering_state = 'pending'",
      )
      .get(jobId) as { count: unknown };
    if (asInteger(pending.count, 'pending steering') >= maxPendingSteering) {
      throw new DomainError(
        'STEERING_LIMIT',
        'The pending steering limit has been reached.',
      );
    }
    const sequence = this.allocateSequence(job.sessionId);
    const messageId = this.id('msg');
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO messages(id, session_id, job_id, kind, sequence, content, received_at,
                              applied_at, steering_state)
         VALUES (?, ?, ?, 'steering', ?, ?, ?, NULL, 'pending')`,
      )
      .run(messageId, job.sessionId, jobId, sequence, content, now);
    this.enqueue(
      job.sessionId,
      jobId,
      'ack',
      `Steering saved for job ${jobId}; it is not applied yet.`,
      undefined,
      chatId,
    );
    return messageId;
  }

  findPrompt(chatId: string, messageId: number): PromptRecord | null {
    const row = this.database
      .prepare(
        'SELECT job_id, owner_id, active FROM prompt_bindings WHERE chat_id = ? AND message_id = ?',
      )
      .get(chatId, messageId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      jobId: asString(row['job_id'], 'prompt job'),
      ownerId: asString(row['owner_id'], 'prompt owner'),
      active: asInteger(row['active'], 'prompt active') === 1,
    };
  }

  steerPrompt(
    ownerId: string,
    chatId: string,
    messageId: number,
    content: string,
    maxPendingSteering: number,
  ): void {
    const prompt = this.findPrompt(chatId, messageId);
    if (prompt === null || prompt.ownerId !== ownerId || !prompt.active) {
      throw new DomainError(
        'STALE_PROMPT',
        'That question is no longer active.',
      );
    }
    this.steerJob(ownerId, prompt.jobId, content, maxPendingSteering, chatId);
  }

  statusForJob(ownerId: string, jobId: string): JobRecord | null {
    const row = this.jobRow(
      `SELECT j.*, s.name AS session_name,
         (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='pending') AS pending_steering,
         (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='not_applied') AS not_applied_steering,
         (SELECT COUNT(*) FROM outbox o WHERE o.job_id=j.id AND o.status='FAILED') AS failed_deliveries
       FROM jobs j JOIN sessions s ON s.id=j.session_id WHERE j.id=? AND j.owner_id=?`,
      jobId,
      ownerId,
    );
    return row === null ? null : this.mapJob(row);
  }

  statusForSession(
    ownerId: string,
    chatId: string,
    terminalLimit = 10,
  ): readonly JobRecord[] | null {
    const session = this.selectedSession(ownerId, chatId);
    if (session === null) return null;
    const rows = this.database
      .prepare(
        `SELECT j.*, s.name AS session_name,
         (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='pending') AS pending_steering,
         (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='not_applied') AS not_applied_steering,
         (SELECT COUNT(*) FROM outbox o WHERE o.job_id=j.id AND o.status='FAILED') AS failed_deliveries
         FROM jobs j JOIN sessions s ON s.id=j.session_id
         WHERE j.session_id=? AND (
           j.status IN ('QUEUED','RUNNING','WAITING_INPUT') OR
           j.id IN (SELECT recent.id FROM jobs recent
                    WHERE recent.session_id=? AND recent.status IN ('COMPLETED','FAILED')
                    ORDER BY recent.created_at DESC LIMIT ?)
         )
         ORDER BY CASE WHEN j.status IN ('QUEUED','RUNNING','WAITING_INPUT') THEN 0 ELSE 1 END,
                  j.sequence`,
      )
      .all(session.id, session.id, terminalLimit) as Record<string, unknown>[];
    return rows.map((row) => this.mapJob(row));
  }

  expireDueJobs(now: number): number {
    return this.transaction(() => {
      const due = this.database
        .prepare(
          "SELECT id FROM jobs WHERE status IN ('RUNNING','WAITING_INPUT') AND deadline_at <= ? ORDER BY deadline_at",
        )
        .all(now) as { id: unknown }[];
      for (const row of due)
        this.failJob(asString(row.id, 'job id'), 'TIMEOUT', now);
      return due.length;
    });
  }

  assertConcurrencyLimit(limit: number): void {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='RUNNING'")
      .get() as { count: unknown };
    if (asInteger(row.count, 'running jobs') > limit) {
      throw new Error(
        'Persisted RUNNING jobs exceed JOB_CONCURRENCY; refusing startup.',
      );
    }
  }

  scheduleAvailable(
    now: number,
    concurrency: number,
    timeoutMs: number,
  ): readonly string[] {
    return this.transaction(() => {
      let running = this.countRunning();
      if (running > concurrency) {
        throw new Error('Persisted RUNNING jobs exceed JOB_CONCURRENCY.');
      }
      while (running < concurrency) {
        const waiting = this.database
          .prepare(
            `SELECT j.id FROM jobs j WHERE j.status='WAITING_INPUT'
             AND EXISTS (SELECT 1 FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='pending')
             ORDER BY j.deadline_at, j.sequence LIMIT 1`,
          )
          .get() as { id?: unknown } | undefined;
        if (waiting?.id !== undefined) {
          this.database
            .prepare(
              "UPDATE jobs SET status='RUNNING', updated_at=? WHERE id=? AND status='WAITING_INPUT'",
            )
            .run(now, asString(waiting.id, 'job id'));
          running += 1;
          continue;
        }
        const queued = this.database
          .prepare(
            `SELECT j.id FROM jobs j WHERE j.status='QUEUED'
             AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.session_id=j.session_id AND active.status IN ('RUNNING','WAITING_INPUT'))
             AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.session_id=j.session_id AND earlier.status='QUEUED' AND earlier.sequence<j.sequence)
             ORDER BY j.created_at, j.sequence LIMIT 1`,
          )
          .get() as { id?: unknown } | undefined;
        if (queued?.id === undefined) break;
        this.database
          .prepare(
            `UPDATE jobs SET status='RUNNING', started_at=COALESCE(started_at, ?),
             deadline_at=COALESCE(deadline_at, ?), updated_at=? WHERE id=? AND status='QUEUED'`,
          )
          .run(now, now + timeoutMs, now, asString(queued.id, 'job id'));
        running += 1;
      }
      return this.database
        .prepare(
          "SELECT id FROM jobs WHERE status='RUNNING' ORDER BY started_at, sequence",
        )
        .all()
        .map((row) => asString((row as { id: unknown }).id, 'job id'));
    });
  }

  getRunningJob(jobId: string): JobRecord | null {
    const job = this.statusForAnyJob(jobId);
    return job?.status === 'RUNNING' ? job : null;
  }

  advanceStep(jobId: string, now: number): JobRecord | null {
    return this.transaction(() => {
      const job = this.statusForAnyJob(jobId);
      if (job === null || job.status !== 'RUNNING') return job;
      if (job.deadlineAt !== null && now >= job.deadlineAt) {
        this.failJob(jobId, 'TIMEOUT', now);
        return this.statusForAnyJob(jobId);
      }
      if (job.input.startsWith('fail:') && job.checkpoint === 0) {
        this.failJob(jobId, 'DEMO_FAILURE', now);
        return this.statusForAnyJob(jobId);
      }
      this.applyPendingSteering(jobId, now);
      const checkpoint = job.checkpoint + 1;
      if (job.input.startsWith('ask:') && checkpoint === 1) {
        this.database
          .prepare(
            "UPDATE jobs SET checkpoint=?, status='WAITING_INPUT', updated_at=? WHERE id=?",
          )
          .run(checkpoint, now, jobId);
        const fresh = this.statusForAnyJob(jobId);
        if (fresh === null)
          throw new Error('Job disappeared during safe point.');
        const prefix = jobPrefix(fresh);
        this.enqueue(
          fresh.sessionId,
          fresh.id,
          'prompt',
          'Please provide the missing input by replying here or with /steer.',
          prefix,
        );
        return this.statusForAnyJob(jobId);
      }
      if (checkpoint >= 3) {
        this.database
          .prepare(
            "UPDATE jobs SET checkpoint=3, status='COMPLETED', updated_at=? WHERE id=?",
          )
          .run(now, jobId);
        this.closePrompts(jobId);
        const fresh = this.statusForAnyJob(jobId);
        if (fresh === null)
          throw new Error('Job disappeared during completion.');
        const steers =
          fresh.appliedSteering.length === 0
            ? '(none)'
            : fresh.appliedSteering.map((text) => `- ${text}`).join('\n');
        this.enqueue(
          fresh.sessionId,
          fresh.id,
          'completed',
          `Completed. Original input: ${fresh.input}\nApplied steering:\n${steers}`,
        );
        return this.statusForAnyJob(jobId);
      }
      this.database
        .prepare('UPDATE jobs SET checkpoint=?, updated_at=? WHERE id=?')
        .run(checkpoint, now, jobId);
      return this.statusForAnyJob(jobId);
    });
  }

  dueOutbox(now: number, limit = 20): readonly OutboxRecord[] {
    const rows = this.database
      .prepare(
        `SELECT o.id, o.session_id, o.job_id, o.kind, o.text, o.attempts, o.chat_id
         FROM outbox o WHERE o.status='PENDING' AND o.next_attempt_at<=?
         AND NOT EXISTS (
           SELECT 1 FROM outbox earlier
           WHERE earlier.batch_id=o.batch_id AND earlier.chunk_index<o.chunk_index
             AND earlier.status='PENDING'
         )
         ORDER BY o.created_at, o.rowid LIMIT ?`,
      )
      .all(now, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row['id'], 'outbox id'),
      sessionId:
        row['session_id'] === null
          ? null
          : asString(row['session_id'], 'session id'),
      jobId: row['job_id'] === null ? null : asString(row['job_id'], 'job id'),
      kind: asString(row['kind'], 'outbox kind') as OutboxKind,
      text: asString(row['text'], 'outbox text'),
      attempts: asInteger(row['attempts'], 'outbox attempts'),
      chatId: asString(row['chat_id'], 'chat id'),
    }));
  }

  deliverOutbox(
    outboxId: string,
    chatId: number,
    messageId: number,
    now: number,
  ): void {
    this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM outbox WHERE id = ? AND status = 'PENDING'")
        .get(outboxId) as Record<string, unknown> | undefined;
      if (row === undefined) return;
      this.database
        .prepare(
          "UPDATE outbox SET status='DELIVERED', attempts=attempts+1, delivered_at=? WHERE id=?",
        )
        .run(now, outboxId);
      if (row['kind'] !== 'prompt' || row['job_id'] === null) return;
      const jobId = asString(row['job_id'], 'job id');
      const jobStatus = this.database
        .prepare('SELECT status, owner_id FROM jobs WHERE id=?')
        .get(jobId) as { status?: unknown; owner_id?: unknown } | undefined;
      if (jobStatus === undefined) return;
      const active = activeJobStatuses.includes(
        asString(
          jobStatus.status,
          'job status',
        ) as (typeof activeJobStatuses)[number],
      );
      this.database
        .prepare(
          `INSERT INTO prompt_bindings(chat_id, message_id, job_id, owner_id, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, message_id) DO UPDATE SET job_id=excluded.job_id,
             owner_id=excluded.owner_id, active=excluded.active`,
        )
        .run(
          String(chatId),
          messageId,
          jobId,
          asString(jobStatus.owner_id, 'job owner'),
          active ? 1 : 0,
          now,
        );
    });
  }

  retryOutbox(outboxId: string, nextAttemptAt: number): void {
    this.database
      .prepare(
        "UPDATE outbox SET attempts=attempts+1, next_attempt_at=? WHERE id=? AND status='PENDING'",
      )
      .run(nextAttemptAt, outboxId);
  }

  failOutbox(outboxId: string): void {
    this.database
      .prepare(
        "UPDATE outbox SET status='FAILED', attempts=attempts+1 WHERE id=? AND status='PENDING'",
      )
      .run(outboxId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private validateExistingSchema(): void {
    const versionRow = this.database.prepare('PRAGMA user_version').get() as {
      user_version?: unknown;
    };
    const version = asInteger(versionRow.user_version, 'schema version');
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new Error(
        `Unsupported controller database schema version ${String(version)}.`,
      );
    }
    if (version === 0) {
      const existing = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { count: unknown };
      if (asInteger(existing.count, 'existing tables') !== 0) {
        throw new Error(
          'Unversioned database is not empty; refusing to modify it.',
        );
      }
      return;
    }
    const required = new Set([
      'meta',
      'processed_updates',
      'sessions',
      'bindings',
      'jobs',
      'messages',
      'outbox',
      'prompt_bindings',
    ]);
    const tables = this.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: unknown }[];
    for (const table of tables)
      required.delete(asString(table.name, 'table name'));
    if (required.size > 0)
      throw new Error('Controller database schema is incomplete.');
    const offset = this.database
      .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
      .get();
    if (offset === undefined)
      throw new Error('Controller database metadata is incomplete.');
  }

  private initializeSchema(): void {
    const versionRow = this.database.prepare('PRAGMA user_version').get() as {
      user_version?: unknown;
    };
    const version = asInteger(versionRow.user_version, 'schema version');
    const existing = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: unknown };
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new Error(
        `Unsupported controller database schema version ${String(version)}.`,
      );
    }
    if (version === SCHEMA_VERSION) return;
    if (asInteger(existing.count, 'existing tables') !== 0) {
      throw new Error(
        'Unversioned database is not empty; refusing to modify it.',
      );
    }
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES ('next_poll_offset', '0');
      CREATE TABLE processed_updates(
        update_id INTEGER PRIMARY KEY, processed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE sessions(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
        UNIQUE(id, owner_id)
      ) STRICT;
      CREATE TABLE bindings(
        user_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT NOT NULL,
        PRIMARY KEY(user_id, chat_id),
        FOREIGN KEY(session_id, user_id) REFERENCES sessions(id, owner_id)
      ) STRICT;
      CREATE TABLE jobs(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        chat_id TEXT NOT NULL, sequence INTEGER NOT NULL, input TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_INPUT','COMPLETED','FAILED')),
        checkpoint INTEGER NOT NULL CHECK(checkpoint BETWEEN 0 AND 3),
        started_at INTEGER, deadline_at INTEGER, failure_code TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence), UNIQUE(id, owner_id), UNIQUE(id, session_id),
        FOREIGN KEY(session_id, owner_id) REFERENCES sessions(id, owner_id)
      ) STRICT;
      CREATE UNIQUE INDEX one_active_job_per_session ON jobs(session_id)
        WHERE status IN ('RUNNING','WAITING_INPUT');
      CREATE INDEX jobs_schedule ON jobs(status, created_at, sequence);
      CREATE TABLE messages(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, job_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('queued','steering')),
        sequence INTEGER NOT NULL, content TEXT NOT NULL, received_at INTEGER NOT NULL,
        applied_at INTEGER, steering_state TEXT CHECK(steering_state IN ('pending','applied','not_applied')),
        UNIQUE(session_id, sequence),
        FOREIGN KEY(job_id, session_id) REFERENCES jobs(id, session_id),
        CHECK((kind='queued' AND steering_state IS NULL) OR
              (kind='steering' AND steering_state IS NOT NULL))
      ) STRICT;
      CREATE INDEX messages_pending ON messages(job_id, steering_state, sequence);
      CREATE TABLE outbox(
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, session_id TEXT, job_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('reply','ack','prompt','completed','failed')),
        chunk_index INTEGER NOT NULL, text TEXT NOT NULL CHECK(length(text) <= 3500),
        chat_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','DELIVERED','FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, delivered_at INTEGER,
        UNIQUE(batch_id, chunk_index),
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(job_id, session_id) REFERENCES jobs(id, session_id)
      ) STRICT;
      CREATE INDEX outbox_due ON outbox(status, next_attempt_at, created_at);
      CREATE INDEX outbox_job_failure ON outbox(job_id, status);
      CREATE TABLE prompt_bindings(
        chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, job_id TEXT NOT NULL,
        owner_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
        created_at INTEGER NOT NULL, PRIMARY KEY(chat_id, message_id),
        FOREIGN KEY(job_id, owner_id) REFERENCES jobs(id, owner_id)
      ) STRICT;
      PRAGMA user_version = ${String(SCHEMA_VERSION)};
      COMMIT;
    `);
  }

  private allocateSequence(sessionId: string): number {
    const row = this.database
      .prepare('SELECT next_sequence FROM sessions WHERE id=?')
      .get(sessionId) as { next_sequence: unknown } | undefined;
    if (row === undefined)
      throw new DomainError('NOT_FOUND', 'Session not found.');
    const sequence = asInteger(row.next_sequence, 'session sequence');
    this.database
      .prepare('UPDATE sessions SET next_sequence=? WHERE id=?')
      .run(sequence + 1, sessionId);
    return sequence;
  }

  private enqueue(
    sessionId: string | null,
    jobId: string | null,
    kind: OutboxKind,
    body: string,
    prefix?: string,
    chatId?: string,
  ): void {
    const row =
      sessionId === null
        ? undefined
        : (this.database
            .prepare('SELECT owner_id, name FROM sessions WHERE id=?')
            .get(sessionId) as
            { owner_id?: unknown; name?: unknown } | undefined);
    if (sessionId !== null && row === undefined)
      throw new Error('Outbox session does not exist.');
    const target =
      chatId === undefined
        ? jobId === null
          ? row === undefined
            ? undefined
            : this.database
                .prepare(
                  'SELECT chat_id FROM bindings WHERE user_id=? AND session_id=? ORDER BY chat_id LIMIT 1',
                )
                .get(asString(row.owner_id, 'session owner'), sessionId)
          : this.database
              .prepare('SELECT chat_id FROM jobs WHERE id=?')
              .get(jobId)
        : { chat_id: chatId };
    const deliveryChatId =
      target === undefined
        ? ''
        : asString((target as { chat_id?: unknown }).chat_id, 'chat id');
    const header =
      prefix ??
      (sessionId === null
        ? ''
        : `Session ${String(row?.name)} (${sessionId})${jobId === null ? '' : ` | Job ${jobId}`}\n`);
    const parts = splitMessage(header, body);
    const batchId = this.id('batch');
    const now = this.now();
    for (const [index, text] of parts.entries()) {
      this.database
        .prepare(
          `INSERT INTO outbox(id, batch_id, session_id, job_id, kind, chunk_index, text, chat_id,
                              status, attempts, next_attempt_at, created_at, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, NULL)`,
        )
        .run(
          this.id('out'),
          batchId,
          sessionId,
          jobId,
          kind,
          index,
          text,
          deliveryChatId,
          now,
          now,
        );
    }
  }

  private getJobForOwner(ownerId: string, jobId: string): JobRecord | null {
    const row = this.jobRow(
      `SELECT j.*, s.name AS session_name,
       (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='pending') AS pending_steering,
       (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='not_applied') AS not_applied_steering,
       (SELECT COUNT(*) FROM outbox o WHERE o.job_id=j.id AND o.status='FAILED') AS failed_deliveries
       FROM jobs j JOIN sessions s ON s.id=j.session_id WHERE j.id=? AND j.owner_id=?`,
      jobId,
      ownerId,
    );
    return row === null ? null : this.mapJob(row);
  }

  private statusForAnyJob(jobId: string): JobRecord | null {
    const row = this.jobRow(
      `SELECT j.*, s.name AS session_name,
       (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='pending') AS pending_steering,
       (SELECT COUNT(*) FROM messages m WHERE m.job_id=j.id AND m.kind='steering' AND m.steering_state='not_applied') AS not_applied_steering,
       (SELECT COUNT(*) FROM outbox o WHERE o.job_id=j.id AND o.status='FAILED') AS failed_deliveries
       FROM jobs j JOIN sessions s ON s.id=j.session_id WHERE j.id=?`,
      jobId,
    );
    return row === null ? null : this.mapJob(row);
  }

  private jobRow(
    sql: string,
    ...params: (string | number)[]
  ): Record<string, unknown> | null {
    const row = this.database.prepare(sql).get(...params) as
      Record<string, unknown> | undefined;
    return row ?? null;
  }

  private mapJob(row: Record<string, unknown>): JobRecord {
    const steeringRows = this.database
      .prepare(
        "SELECT content FROM messages WHERE job_id=? AND kind='steering' AND steering_state='applied' ORDER BY sequence",
      )
      .all(asString(row['id'], 'job id')) as { content: unknown }[];
    return {
      id: asString(row['id'], 'job id'),
      sessionId: asString(row['session_id'], 'session id'),
      sessionName: asString(row['session_name'], 'session name'),
      ownerId: asString(row['owner_id'], 'owner id'),
      sequence: asInteger(row['sequence'], 'job sequence'),
      input: asString(row['input'], 'job input'),
      status: asString(row['status'], 'job status') as JobStatus,
      checkpoint: asInteger(row['checkpoint'], 'checkpoint'),
      startedAt:
        row['started_at'] === null
          ? null
          : asInteger(row['started_at'], 'started at'),
      deadlineAt:
        row['deadline_at'] === null
          ? null
          : asInteger(row['deadline_at'], 'deadline'),
      failureCode:
        row['failure_code'] === null
          ? null
          : asString(row['failure_code'], 'failure code'),
      createdAt: asInteger(row['created_at'], 'created at'),
      updatedAt: asInteger(row['updated_at'], 'updated at'),
      appliedSteering: steeringRows.map((entry) =>
        asString(entry.content, 'steering content'),
      ),
      pendingSteering: asInteger(
        row['pending_steering'] ?? 0,
        'pending steering',
      ),
      notAppliedSteering: asInteger(
        row['not_applied_steering'] ?? 0,
        'not applied steering',
      ),
      failedDeliveries: asInteger(
        row['failed_deliveries'] ?? 0,
        'failed deliveries',
      ),
    };
  }

  private applyPendingSteering(jobId: string, now: number): void {
    this.database
      .prepare(
        "UPDATE messages SET steering_state='applied', applied_at=? WHERE job_id=? AND kind='steering' AND steering_state='pending'",
      )
      .run(now, jobId);
  }

  private failJob(jobId: string, failureCode: string, now: number): void {
    const row = this.database
      .prepare('SELECT session_id, status FROM jobs WHERE id=?')
      .get(jobId) as { session_id?: unknown; status?: unknown } | undefined;
    if (
      row === undefined ||
      terminalStatuses.includes(
        asString(row.status, 'job status') as (typeof terminalStatuses)[number],
      )
    )
      return;
    this.database
      .prepare(
        "UPDATE messages SET steering_state='not_applied' WHERE job_id=? AND kind='steering' AND steering_state='pending'",
      )
      .run(jobId);
    this.database
      .prepare(
        "UPDATE jobs SET status='FAILED', failure_code=?, updated_at=? WHERE id=?",
      )
      .run(failureCode, now, jobId);
    this.closePrompts(jobId);
    this.enqueue(
      asString(row.session_id, 'session id'),
      jobId,
      'failed',
      `Job failed (${failureCode}).`,
    );
  }

  private closePrompts(jobId: string): void {
    this.database
      .prepare('UPDATE prompt_bindings SET active=0 WHERE job_id=?')
      .run(jobId);
  }

  private countRunning(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='RUNNING'")
      .get() as { count: unknown };
    return asInteger(row.count, 'running count');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Controller store is closed.');
  }
}

export async function restrictDatabaseFile(path: string): Promise<void> {
  if (path !== ':memory:') await chmod(path, 0o600);
}

export function splitMessage(prefix: string, body: string): readonly string[] {
  if (prefix.length > MAX_OUTBOX_UNITS) {
    throw new Error('Outbox prefix exceeds the Telegram message size limit.');
  }
  const parts: string[] = [];
  let current = prefix;
  let length = prefix.length;
  for (const character of body) {
    if (length + character.length > MAX_OUTBOX_UNITS) {
      parts.push(current);
      current = prefix;
      length = prefix.length;
    }
    current += character;
    length += character.length;
  }
  if (current.length > prefix.length || parts.length === 0) parts.push(current);
  return parts;
}

function jobPrefix(job: JobRecord): string {
  return `Session ${job.sessionName} (${job.sessionId}) | Job ${job.id}\n`;
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: asString(row['id'], 'session id'),
    ownerId: asString(row['owner_id'], 'owner id'),
    name: asString(row['name'], 'session name'),
    createdAt: asInteger(row['created_at'], 'session created at'),
    nextSequence: asInteger(row['next_sequence'], 'session sequence'),
  };
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid SQLite ${name}.`);
  return value;
}

function asInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`Invalid SQLite ${name}.`);
  }
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
