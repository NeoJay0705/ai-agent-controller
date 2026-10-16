import {
  createHash,
  randomBytes as cryptoRandomBytes,
  randomUUID,
} from 'node:crypto';

import { DomainError, type ControllerStore } from './store.js';
import type { TrialPolicy } from './trial-policy.js';

type Access =
  | { readonly role: 'owner' }
  | { readonly role: 'guest' }
  | { readonly role: 'denied'; readonly reason: string };
type DialogCommand =
  'new' | 'use' | 'queue' | 'steer' | 'cancel' | 'allow' | 'revoke' | 'invite';
type MenuRole = 'default' | 'guest' | 'owner';

export interface TrialStoreOptions {
  readonly now?: () => number;
  readonly id?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface TrialGuestRecord {
  readonly userId: string;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly jobsUsed: number;
  readonly messagesUsed: number;
  readonly tokensUsed: number;
  readonly usageUncertain: boolean;
}

export interface TrialMenuRecord {
  readonly chatId: string;
  readonly role: MenuRole;
  readonly generation: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

export class TrialStore {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly randomBytes: (size: number) => Buffer;

  constructor(
    private readonly store: ControllerStore,
    private readonly ownerId: string,
    private readonly policy: TrialPolicy,
    options: TrialStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  access(userId: string): Access {
    if (userId === this.ownerId) return { role: 'owner' };
    if (!isUserId(userId)) return { role: 'denied', reason: 'INVALID_USER' };
    const row = this.store.database
      .prepare('SELECT revoked_at, expires_at FROM trial_users WHERE user_id=?')
      .get(userId) as
      { revoked_at?: unknown; expires_at?: unknown } | undefined;
    if (row === undefined) return { role: 'denied', reason: 'NOT_REGISTERED' };
    if (row.revoked_at !== null)
      return { role: 'denied', reason: 'ACCESS_REVOKED' };
    const expires = safeInteger(row.expires_at, 'trial expiry');
    if (!Number.isSafeInteger(this.now()))
      throw new DomainError('CLOCK_INVALID', 'The trial clock is unavailable.');
    return this.now() < expires
      ? { role: 'guest' }
      : { role: 'denied', reason: 'TRIAL_EXPIRED' };
  }

  grant(userId: string, durationMs: number, chatId?: string): void {
    requireUser(userId);
    if (userId === this.ownerId)
      throw new DomainError('OWNER_PROTECTED', 'The owner cannot be changed.');
    requirePositive(durationMs, 'INVALID_DURATION');
    const now = this.timestamp();
    const expires = safeAdd(now, durationMs, 'INVALID_DURATION');
    if (chatId !== undefined) requireChat(chatId);
    const existing = this.userRow(userId);
    this.store.database
      .prepare(
        `
      INSERT INTO trial_users(user_id,chat_id,expires_at,revoked_at,jobs_used,messages_used,tokens_used,usage_uncertain)
      VALUES(?,?,?,NULL,0,0,0,0)
      ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at, revoked_at=NULL,
        chat_id=CASE WHEN ? IS NULL THEN trial_users.chat_id ELSE excluded.chat_id END
    `,
      )
      .run(
        userId,
        chatId ?? existing?.chatId ?? userId,
        expires,
        chatId ?? null,
      );
    this.queueMenu(chatId ?? existing?.chatId ?? userId, 'guest');
  }

  revoke(userId: string): boolean {
    requireUser(userId);
    if (userId === this.ownerId)
      throw new DomainError('OWNER_PROTECTED', 'The owner cannot be changed.');
    const row = this.userRow(userId);
    if (row === null)
      throw new DomainError('NOT_FOUND', 'Trial user not found.');
    if (row.revokedAt !== null) return false;
    this.revokeActive(userId, row.chatId, 'ACCESS_REVOKED');
    return true;
  }

  expireTrials(): string[] {
    const now = this.timestamp();
    const rows = this.store.database
      .prepare(
        'SELECT user_id,chat_id FROM trial_users WHERE revoked_at IS NULL AND expires_at<=? ORDER BY user_id',
      )
      .all(now) as Record<string, unknown>[];
    const expired: string[] = [];
    for (const row of rows) {
      const userId = safeString(row.user_id, 'trial user');
      this.revokeActive(
        userId,
        nullableString(row.chat_id, 'trial chat'),
        'TRIAL_EXPIRED',
      );
      expired.push(userId);
    }
    return expired;
  }

  listGuests(): TrialGuestRecord[] {
    const rows = this.store.database
      .prepare(
        'SELECT user_id,expires_at,revoked_at,jobs_used,messages_used,tokens_used,usage_uncertain FROM trial_users ORDER BY user_id',
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      userId: safeString(row.user_id, 'trial user'),
      expiresAt: safeInteger(row.expires_at, 'trial expiry'),
      revokedAt:
        row.revoked_at === null
          ? null
          : safeInteger(row.revoked_at, 'revocation time'),
      jobsUsed: safeInteger(row.jobs_used, 'job counter'),
      messagesUsed: safeInteger(row.messages_used, 'message counter'),
      tokensUsed: safeInteger(row.tokens_used, 'token counter'),
      usageUncertain: safeBoolean(row.usage_uncertain, 'usage uncertainty'),
    }));
  }

  createInvite(
    ttlMs = this.policy.inviteTtlMs,
    trialDurationMs = this.policy.trialDurationMs,
  ): { token: string; expiresAt: number; trialDurationMs: number } {
    requirePositive(ttlMs, 'INVITE_INVALID');
    requirePositive(trialDurationMs, 'INVITE_INVALID');
    const token = this.randomBytes(32).toString('base64url');
    const expiresAt = safeAdd(this.timestamp(), ttlMs, 'INVITE_INVALID');
    const hash = createHash('sha256').update(token).digest('hex');
    this.store.database
      .prepare(
        'INSERT INTO trial_invites(token_hash,created_by,expires_at,trial_duration_ms,used_by,used_at,revoked_at) VALUES(?,?,?,?,NULL,NULL,NULL)',
      )
      .run(hash, this.ownerId, expiresAt, trialDurationMs);
    return { token, expiresAt, trialDurationMs };
  }

  redeemInvite(userId: string, chatId: string, token: string): void {
    requireUser(userId);
    requireChat(chatId);
    if (userId === this.ownerId || this.userRow(userId) !== null)
      this.invalidInvite();
    const tokenMatch = /^[A-Za-z0-9_-]{43}$/.exec(token);
    if (tokenMatch === null || tokenMatch[0] !== token) this.invalidInvite();
    const hash = createHash('sha256').update(token).digest('hex');
    const now = this.timestamp();
    const row = this.store.database
      .prepare(
        'SELECT expires_at,trial_duration_ms,used_by,revoked_at FROM trial_invites WHERE token_hash=?',
      )
      .get(hash) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      row.used_by !== null ||
      row.revoked_at !== null ||
      safeInteger(row.expires_at, 'invite expiry') <= now
    )
      this.invalidInvite();
    const update = this.store.database
      .prepare(
        'UPDATE trial_invites SET used_by=?,used_at=? WHERE token_hash=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?',
      )
      .run(userId, now, hash, now);
    if (Number(update.changes) !== 1) this.invalidInvite();
    this.grant(
      userId,
      safeInteger(row.trial_duration_ms, 'trial duration'),
      chatId,
    );
  }

  chargeMessage(
    userId: string,
    updateId: number,
    channel: 'message' | 'control' = 'message',
  ): void {
    requireUpdateId(updateId);
    if (!(['message', 'control'] as readonly string[]).includes(channel))
      throw new DomainError(
        'INVALID_CHANNEL',
        'The message channel is invalid.',
      );
    const role = this.access(userId).role;
    if (role === 'denied')
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    if (role === 'owner' && channel === 'message') return;
    const now = this.timestamp();
    this.pruneEvents(now);
    if (this.hasEvent(userId, channel, updateId)) return;
    if (channel === 'control') {
      const count = this.countEvents(userId, 'control', now - 60_000);
      if (count >= this.policy.controlMaxPerMinute)
        throw new DomainError(
          'QUOTA_CONTROL_RATE',
          'The control command rate limit has been reached.',
        );
      this.insertEvent(userId, 'control', updateId, now);
      return;
    }
    const row = this.userRow(userId);
    if (
      role === 'guest' &&
      row !== null &&
      row.messagesUsed >= this.policy.maxMessages
    )
      throw new DomainError(
        'QUOTA_MESSAGE_TOTAL',
        'The trial message allowance has been reached.',
      );
    if (
      this.countEvents(userId, 'message', now - this.policy.messageWindowMs) >=
      this.policy.maxMessagesPerWindow
    )
      throw new DomainError(
        'QUOTA_MESSAGE_RATE',
        'The message rate limit has been reached.',
      );
    if (role === 'guest') this.increment(userId, 'messages_used');
    this.insertEvent(userId, 'message', updateId, now);
  }

  assertCanCreateSession(userId: string): void {
    const access = this.access(userId);
    if (access.role === 'denied')
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    if (access.role === 'owner') return;
    const row = this.store.database
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE owner_id=?')
      .get(userId) as { count: unknown };
    if (safeInteger(row.count, 'session count') >= this.policy.maxSessions)
      throw new DomainError(
        'QUOTA_SESSION_LIMIT',
        'The trial session limit has been reached.',
      );
  }

  chargeJob(userId: string, updateId: number): void {
    requireUpdateId(updateId);
    const role = this.access(userId).role;
    if (role === 'denied')
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    if (role === 'owner') return;
    const now = this.timestamp();
    this.pruneEvents(now);
    if (this.hasEvent(userId, 'job', updateId)) return;
    const row = this.userRow(userId);
    if (row === null)
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    if (row.jobsUsed >= this.policy.maxJobs)
      throw new DomainError(
        'QUOTA_JOB_TOTAL',
        'The trial job allowance has been reached.',
      );
    if (
      this.countEvents(userId, 'job', now - this.policy.jobWindowMs) >=
      this.policy.maxJobsPerWindow
    )
      throw new DomainError(
        'QUOTA_JOB_RATE',
        'The job rate limit has been reached.',
      );
    const pending = this.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE owner_id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT','CANCELLING')",
      )
      .get(userId) as { count: unknown };
    if (
      safeInteger(pending.count, 'pending job count') >=
      this.policy.maxPendingJobs
    )
      throw new DomainError(
        'QUOTA_PENDING_JOBS',
        'The pending job limit has been reached.',
      );
    this.increment(userId, 'jobs_used');
    this.insertEvent(userId, 'job', updateId, now);
  }

  getDialog(
    userId: string,
    chatId: string,
  ): { command: DialogCommand; expiresAt: number; revision: number } | null {
    const row = this.store.database
      .prepare(
        'SELECT command,expires_at,revision FROM command_dialogs WHERE user_id=? AND chat_id=?',
      )
      .get(userId, chatId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const expiresAt = safeInteger(row.expires_at, 'dialog expiry');
    if (expiresAt <= this.timestamp()) {
      this.clearDialog(userId, chatId);
      return null;
    }
    const command = row.command;
    if (
      typeof command !== 'string' ||
      !DIALOG_COMMANDS.has(command as DialogCommand)
    )
      return null;
    return {
      command: command as DialogCommand,
      expiresAt,
      revision: safeInteger(row.revision, 'dialog revision'),
    };
  }

  setDialog(userId: string, chatId: string, command: DialogCommand): void {
    requireChat(chatId);
    if (!DIALOG_COMMANDS.has(command))
      throw new DomainError('INVALID_DIALOG', 'The command dialog is invalid.');
    const expires = safeAdd(
      this.timestamp(),
      this.policy.commandDialogTtlMs,
      'CLOCK_INVALID',
    );
    this.store.database
      .prepare(
        `INSERT INTO command_dialogs(user_id,chat_id,command,expires_at,revision) VALUES(?,?,?,?,0)
      ON CONFLICT(user_id,chat_id) DO UPDATE SET command=excluded.command,expires_at=excluded.expires_at,revision=command_dialogs.revision+1`,
      )
      .run(userId, chatId, command, expires);
  }

  clearDialog(userId: string, chatId: string): void {
    this.store.database
      .prepare('DELETE FROM command_dialogs WHERE user_id=? AND chat_id=?')
      .run(userId, chatId);
  }
  clearAllDialogs(): void {
    this.store.database.prepare('DELETE FROM command_dialogs').run();
  }

  beginUsage(
    ownerId: string,
    sessionId: string,
    jobId: string,
  ): { operationId: string; remainingTokens: number } | null {
    const job = this.store.database
      .prepare('SELECT owner_id,session_id,status FROM jobs WHERE id=?')
      .get(jobId) as Record<string, unknown> | undefined;
    if (
      job === undefined ||
      job.owner_id !== ownerId ||
      job.session_id !== sessionId ||
      job.status !== 'RUNNING'
    )
      throw new DomainError('NOT_FOUND', 'Running job not found.');
    if (ownerId === this.ownerId) return null;
    if (this.access(ownerId).role !== 'guest')
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    const user = this.userRow(ownerId);
    if (user === null)
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    if (user.usageUncertain)
      throw new DomainError(
        'QUOTA_USAGE_UNKNOWN',
        'Token usage is uncertain. Further jobs are blocked.',
      );
    if (
      this.store.database
        .prepare(
          "SELECT 1 FROM trial_usage_operations WHERE owner_id=? AND state='pending' LIMIT 1",
        )
        .get(ownerId) !== undefined
    )
      throw new DomainError(
        'QUOTA_USAGE_UNKNOWN',
        'A previous token usage operation is unresolved.',
      );
    const sessionTokens = this.sessionTokens(sessionId);
    if (
      sessionTokens >= this.policy.sessionTokenLimit ||
      user.tokensUsed >= this.policy.userTokenLimit
    )
      throw new DomainError(
        'QUOTA_TOKEN_LIMIT',
        'The token allowance has been reached.',
      );
    const operationId = this.id();
    const now = this.timestamp();
    this.store.database
      .prepare(
        "INSERT INTO trial_usage_operations(id,owner_id,session_id,job_id,started_at,completed_at,state,total_tokens,event_count) VALUES(?,?,?, ?,?,NULL,'pending',0,0)",
      )
      .run(operationId, ownerId, sessionId, jobId, now);
    return {
      operationId,
      remainingTokens: Math.min(
        this.policy.sessionTokenLimit - sessionTokens,
        this.policy.userTokenLimit - user.tokensUsed,
      ),
    };
  }

  recordUsage(
    operationId: string,
    sequence: number,
    totalTokens: number,
  ): void {
    requireNonnegative(sequence, 'INVALID_USAGE');
    requirePositive(totalTokens, 'INVALID_USAGE');
    const row = this.store.database
      .prepare(
        'SELECT owner_id,state,total_tokens,event_count FROM trial_usage_operations WHERE id=?',
      )
      .get(operationId) as Record<string, unknown> | undefined;
    if (row === undefined || row.state !== 'pending')
      throw new DomainError(
        'USAGE_OPERATION_INVALID',
        'The usage operation is not active.',
      );
    const previous = this.store.database
      .prepare(
        'SELECT total_tokens FROM trial_usage_events WHERE operation_id=? AND sequence=?',
      )
      .get(operationId, sequence) as { total_tokens?: unknown } | undefined;
    if (previous !== undefined) {
      if (safeInteger(previous.total_tokens, 'usage tokens') === totalTokens)
        return;
      throw new DomainError(
        'USAGE_EVENT_CONFLICT',
        'The usage event conflicts with a recorded event.',
      );
    }
    const current = safeInteger(row.total_tokens, 'usage total');
    const count = safeInteger(row.event_count, 'usage event count');
    const user = this.userRow(safeString(row.owner_id, 'usage owner'));
    if (user === null)
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    const opTotal = safeAdd(current, totalTokens, 'USAGE_OVERFLOW');
    const userTotal = safeAdd(user.tokensUsed, totalTokens, 'USAGE_OVERFLOW');
    safeAdd(count, 1, 'USAGE_OVERFLOW');
    this.store.database
      .prepare(
        'INSERT INTO trial_usage_events(operation_id,sequence,total_tokens) VALUES(?,?,?)',
      )
      .run(operationId, sequence, totalTokens);
    this.store.database
      .prepare(
        'UPDATE trial_usage_operations SET total_tokens=?,event_count=event_count+1 WHERE id=?',
      )
      .run(opTotal, operationId);
    this.store.database
      .prepare('UPDATE trial_users SET tokens_used=? WHERE user_id=?')
      .run(userTotal, safeString(row.owner_id, 'usage owner'));
  }

  finishUsage(operationId: string, knownComplete: boolean): void {
    const row = this.store.database
      .prepare(
        "SELECT owner_id,event_count FROM trial_usage_operations WHERE id=? AND state='pending'",
      )
      .get(operationId) as Record<string, unknown> | undefined;
    if (row === undefined) return;
    const complete =
      knownComplete && safeInteger(row.event_count, 'usage event count') > 0;
    this.store.database
      .prepare(
        "UPDATE trial_usage_operations SET state=?,completed_at=? WHERE id=? AND state='pending'",
      )
      .run(complete ? 'complete' : 'uncertain', this.timestamp(), operationId);
    if (!complete)
      this.store.database
        .prepare('UPDATE trial_users SET usage_uncertain=1 WHERE user_id=?')
        .run(safeString(row.owner_id, 'usage owner'));
  }

  recoverPendingUsage(): number {
    const rows = this.store.database
      .prepare(
        "SELECT id,owner_id FROM trial_usage_operations WHERE state='pending'",
      )
      .all() as Record<string, unknown>[];
    const now = this.timestamp();
    for (const row of rows) {
      this.store.database
        .prepare(
          "UPDATE trial_usage_operations SET state='uncertain',completed_at=? WHERE id=? AND state='pending'",
        )
        .run(now, safeString(row.id, 'usage operation'));
      this.store.database
        .prepare('UPDATE trial_users SET usage_uncertain=1 WHERE user_id=?')
        .run(safeString(row.owner_id, 'usage owner'));
    }
    return rows.length;
  }

  queueExistingGuestMenus(): void {
    const rows = this.store.database
      .prepare(
        'SELECT user_id,chat_id FROM trial_users WHERE revoked_at IS NULL ORDER BY user_id',
      )
      .all() as Array<{ user_id: unknown; chat_id: unknown }>;
    for (const row of rows) {
      const userId = safeString(row.user_id, 'trial user');
      if (this.access(userId).role === 'guest') {
        const chatId =
          row.chat_id === null ? userId : safeString(row.chat_id, 'trial chat');
        this.queueMenu(chatId, 'guest');
      }
    }
  }

  queueMenu(chatId: string, role: MenuRole): void {
    requireChat(chatId);
    if (!MENU_ROLES.has(role))
      throw new DomainError('INVALID_MENU_ROLE', 'The menu role is invalid.');
    this.store.database
      .prepare(
        `INSERT INTO command_menu_sync(chat_id,role,generation,attempts,next_attempt_at) VALUES(?,?,0,0,?)
      ON CONFLICT(chat_id) DO UPDATE SET role=excluded.role,generation=command_menu_sync.generation+1,attempts=0,next_attempt_at=excluded.next_attempt_at`,
      )
      .run(chatId, role, this.timestamp());
  }

  dueMenus(now = this.timestamp(), limit = 20): TrialMenuRecord[] {
    requireNonnegative(now, 'INVALID_TIME');
    requirePositive(limit, 'INVALID_LIMIT');
    return (
      this.store.database
        .prepare(
          'SELECT chat_id,role,generation,attempts,next_attempt_at FROM command_menu_sync WHERE next_attempt_at<=? ORDER BY next_attempt_at,chat_id LIMIT ?',
        )
        .all(now, limit) as Record<string, unknown>[]
    ).map((r) => ({
      chatId: safeString(r.chat_id, 'menu chat'),
      role: safeMenuRole(r.role),
      generation: safeInteger(r.generation, 'menu generation'),
      attempts: safeInteger(r.attempts, 'menu attempts'),
      nextAttemptAt: safeInteger(r.next_attempt_at, 'menu time'),
    }));
  }

  completeMenu(chatId: string, generation: number): boolean {
    return (
      Number(
        this.store.database
          .prepare(
            'DELETE FROM command_menu_sync WHERE chat_id=? AND generation=?',
          )
          .run(chatId, generation).changes,
      ) === 1
    );
  }

  retryMenu(
    chatId: string,
    generation: number,
    nextAttemptAt: number,
  ): boolean {
    requireNonnegative(nextAttemptAt, 'INVALID_TIME');
    return (
      Number(
        this.store.database
          .prepare(
            'UPDATE command_menu_sync SET attempts=attempts+1,next_attempt_at=? WHERE chat_id=? AND generation=?',
          )
          .run(nextAttemptAt, chatId, generation).changes,
      ) === 1
    );
  }

  recordGuestChat(userId: string, chatId: string): void {
    requireChat(chatId);
    if (this.access(userId).role !== 'guest')
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    const row = this.userRow(userId);
    if (row === null)
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    if (row.chatId === chatId) return;
    this.store.database
      .prepare(
        'UPDATE trial_users SET chat_id=? WHERE user_id=? AND revoked_at IS NULL',
      )
      .run(chatId, userId);
    this.queueMenu(chatId, 'guest');
  }

  private revokeActive(
    userId: string,
    chatId: string | null,
    reason: 'ACCESS_REVOKED' | 'TRIAL_EXPIRED',
  ): void {
    const now = this.timestamp();
    this.store.database
      .prepare(
        'UPDATE trial_users SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
      )
      .run(now, userId);
    this.clearUserDialogs(userId);
    this.store.cancelOwnerJobs(userId, this.ownerId, reason);
    this.store.database
      .prepare(
        `UPDATE outbox SET status='FAILED' WHERE status='PENDING' AND delivery_class='business' AND (
      session_id IN (SELECT id FROM sessions WHERE owner_id=?) OR job_id IN (SELECT id FROM jobs WHERE owner_id=?))`,
      )
      .run(userId, userId);
    if (chatId !== null) this.queueMenu(chatId, 'default');
  }
  private clearUserDialogs(userId: string): void {
    this.store.database
      .prepare('DELETE FROM command_dialogs WHERE user_id=?')
      .run(userId);
  }
  private userRow(userId: string): {
    chatId: string | null;
    expiresAt: number;
    revokedAt: number | null;
    jobsUsed: number;
    messagesUsed: number;
    tokensUsed: number;
    usageUncertain: boolean;
  } | null {
    const row = this.store.database
      .prepare(
        'SELECT chat_id,expires_at,revoked_at,jobs_used,messages_used,tokens_used,usage_uncertain FROM trial_users WHERE user_id=?',
      )
      .get(userId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      chatId: nullableString(row.chat_id, 'trial chat'),
      expiresAt: safeInteger(row.expires_at, 'trial expiry'),
      revokedAt:
        row.revoked_at === null
          ? null
          : safeInteger(row.revoked_at, 'revocation time'),
      jobsUsed: safeInteger(row.jobs_used, 'job counter'),
      messagesUsed: safeInteger(row.messages_used, 'message counter'),
      tokensUsed: safeInteger(row.tokens_used, 'token counter'),
      usageUncertain: safeBoolean(row.usage_uncertain, 'usage uncertainty'),
    };
  }
  private increment(
    userId: string,
    column: 'jobs_used' | 'messages_used',
  ): void {
    const row = this.userRow(userId);
    if (row === null)
      throw new DomainError('ACCESS_DENIED', 'Access is not available.');
    const value = column === 'jobs_used' ? row.jobsUsed : row.messagesUsed;
    const next = safeAdd(value, 1, 'COUNTER_OVERFLOW');
    this.store.database
      .prepare(`UPDATE trial_users SET ${column}=? WHERE user_id=?`)
      .run(next, userId);
  }
  private insertEvent(
    userId: string,
    kind: 'job' | 'message' | 'control',
    updateId: number,
    at: number,
  ): void {
    this.store.database
      .prepare(
        'INSERT INTO trial_events(user_id,kind,update_id,at) VALUES(?,?,?,?)',
      )
      .run(userId, kind, updateId, at);
  }
  private hasEvent(userId: string, kind: string, updateId: number): boolean {
    return (
      this.store.database
        .prepare(
          'SELECT 1 FROM trial_events WHERE user_id=? AND kind=? AND update_id=?',
        )
        .get(userId, kind, updateId) !== undefined
    );
  }
  private countEvents(userId: string, kind: string, since: number): number {
    const row = this.store.database
      .prepare(
        'SELECT COUNT(*) AS count FROM trial_events WHERE user_id=? AND kind=? AND at>?',
      )
      .get(userId, kind, since) as { count: unknown };
    return safeInteger(row.count, 'event count');
  }
  private pruneEvents(now: number): void {
    const maxAge = Math.max(
      this.policy.jobWindowMs,
      this.policy.messageWindowMs,
      60_000,
    );
    this.store.database
      .prepare('DELETE FROM trial_events WHERE at<?')
      .run(now - maxAge);
  }
  private sessionTokens(sessionId: string): number {
    const row = this.store.database
      .prepare(
        'SELECT COALESCE(SUM(total_tokens),0) AS total FROM trial_usage_operations WHERE session_id=?',
      )
      .get(sessionId) as { total: unknown };
    return safeInteger(row.total, 'session token total');
  }
  private timestamp(): number {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0)
      throw new DomainError('CLOCK_INVALID', 'The trial clock is unavailable.');
    return n;
  }
  private invalidInvite(): never {
    throw new DomainError(
      'INVITE_INVALID',
      'The invite is invalid or unavailable.',
    );
  }
}

const DIALOG_COMMANDS = new Set<DialogCommand>([
  'new',
  'use',
  'queue',
  'steer',
  'cancel',
  'allow',
  'revoke',
  'invite',
]);
const MENU_ROLES = new Set<MenuRole>(['default', 'guest', 'owner']);
function isUserId(value: string): boolean {
  const match = /^(?:0|[1-9][0-9]*)$/.exec(value);
  return (
    match !== null && match[0] === value && Number.isSafeInteger(Number(value))
  );
}
function requireUser(value: string): void {
  if (!isUserId(value) || Number(value) < 1)
    throw new DomainError('INVALID_USER', 'The user ID is invalid.');
}
function requireChat(value: string): void {
  const match = /^[1-9][0-9]*$/.exec(value);
  if (
    match === null ||
    match[0] !== value ||
    !Number.isSafeInteger(Number(value))
  )
    throw new DomainError('INVALID_CHAT', 'The chat ID is invalid.');
}
function requireUpdateId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('INVALID_UPDATE', 'The update ID is invalid.');
}
function requirePositive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DomainError(code, 'The numeric value is invalid.');
}
function requireNonnegative(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError(code, 'The numeric value is invalid.');
}
function safeAdd(a: number, b: number, code: string): number {
  const n = a + b;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DomainError(code, 'A numeric limit was exceeded.');
  return n;
}
function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DomainError('STORE_INVALID', `Stored ${label} is invalid.`);
  return value;
}
function safeString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new DomainError('STORE_INVALID', `Stored ${label} is invalid.`);
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : safeString(value, label);
}
function safeBoolean(value: unknown, label: string): boolean {
  const n = safeInteger(value, label);
  if (n !== 0 && n !== 1)
    throw new DomainError('STORE_INVALID', `Stored ${label} is invalid.`);
  return n === 1;
}
function safeMenuRole(value: unknown): MenuRole {
  if (typeof value !== 'string' || !MENU_ROLES.has(value as MenuRole))
    throw new DomainError('STORE_INVALID', 'Stored menu role is invalid.');
  return value as MenuRole;
}
