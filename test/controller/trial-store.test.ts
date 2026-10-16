import { describe, expect, it } from 'vitest';

import { DEFAULT_TRIAL_POLICY } from '../../src/controller/trial-policy.js';
import { TrialStore } from '../../src/controller/trial-store.js';
import { memoryStore, USER_ID } from './helpers.js';

const OWNER = USER_ID;
const GUEST = '616161';
const CHAT = '717171';
const policy = { ...DEFAULT_TRIAL_POLICY };

function setup() {
  let now = 1_000;
  let sequence = 0;
  let randomSequence = 0;
  const store = memoryStore({
    now: () => now,
    id: (kind) => `${kind}_${String(++sequence)}`,
  });
  const trial = new TrialStore(store, OWNER, policy, {
    now: () => now,
    id: () => `usage_${String(++sequence)}`,
    randomBytes: () => Buffer.alloc(32, ++randomSequence),
  });
  return {
    store,
    trial,
    setNow: (value: number) => {
      now = value;
    },
    getNow: () => now,
  };
}

function expectCode(callback: () => unknown, code: string) {
  try {
    callback();
    throw new Error(`Expected DomainError ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function grant(
  trial: TrialStore,
  userId = GUEST,
  duration = 10_000,
  chatId = CHAT,
) {
  trial.grant(userId, duration, chatId);
}

function runningJob(
  store: ReturnType<typeof memoryStore>,
  userId: string,
  chatId: string,
) {
  const sessionId = store.transaction(
    () => store.createSession(userId, chatId, 'test').id,
  );
  store.transaction(() => store.queueJob(userId, chatId, 'hello', 20));
  const jobId = store.database
    .prepare(
      'SELECT id FROM jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 1',
    )
    .get(userId) as { id: string };
  store.scheduleAvailable(1_000, 2, 10_000);
  return { sessionId, jobId: jobId.id };
}

describe('TrialStore', () => {
  it('protects owner, extends grant without resetting counters, and expires/revokes queued, waiting, and running jobs safely', () => {
    const { store, trial, setNow } = setup();
    expect(trial.access(OWNER)).toEqual({ role: 'owner' });
    expect(() => {
      trial.grant(OWNER, 100);
    }).toThrow('owner cannot');
    expect(() => trial.revoke(OWNER)).toThrow('owner cannot');
    grant(trial);
    trial.chargeMessage(GUEST, 1);
    trial.grant(GUEST, 20_000);
    expect(trial.listGuests()[0]?.messagesUsed).toBe(1);

    const first = runningJob(store, GUEST, CHAT);
    store.database
      .prepare("UPDATE jobs SET status='WAITING_INPUT' WHERE id=?")
      .run(first.jobId);
    const second = runningJob(store, GUEST, CHAT);
    store.database
      .prepare("UPDATE jobs SET status='QUEUED' WHERE id=?")
      .run(second.jobId);
    store.database
      .prepare("UPDATE outbox SET delivery_class='control' WHERE job_id=?")
      .run(first.jobId);
    expect(trial.revoke(GUEST)).toBe(true);
    expect(trial.revoke(GUEST)).toBe(false);
    expect(
      store.database
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE owner_id=? AND status IN ('CANCELLED','CANCELLING')",
        )
        .get(GUEST),
    ).toMatchObject({ n: 2 });
    expect(
      store.database
        .prepare(
          "SELECT COUNT(*) AS n FROM outbox WHERE delivery_class='control' AND job_id=? AND status='PENDING'",
        )
        .get(first.jobId),
    ).toMatchObject({ n: 2 });
    expect(trial.access(GUEST).role).toBe('denied');
    trial.grant(GUEST, 10_000);
    const expiring = runningJob(store, GUEST, CHAT);
    store.database
      .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
      .run(expiring.jobId);
    setNow(22_000);
    expect(trial.expireTrials()).toEqual([GUEST]);
    expect(
      store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(expiring.jobId),
    ).toMatchObject({ status: 'CANCELLING' });
    store.close();
  });

  it('cancels every guest job state without affecting another owner', () => {
    const { store, trial } = setup();
    grant(trial, GUEST, 100_000);
    const states = ['QUEUED', 'WAITING_INPUT', 'RUNNING'] as const;
    const ids = states.map((state, index) => {
      const chat = String(800_000 + index);
      store.transaction(() =>
        store.createSession(GUEST, chat, `guest-${String(index)}`),
      );
      const jobId = store.transaction(() =>
        store.queueJob(GUEST, chat, 'job', 20),
      );
      store.database
        .prepare('UPDATE jobs SET status=? WHERE id=?')
        .run(state, jobId);
      return jobId;
    });
    const otherChat = '888888';
    store.transaction(() => store.createSession('999999', otherChat, 'other'));
    const otherJob = store.transaction(() =>
      store.queueJob('999999', otherChat, 'other', 20),
    );
    expect(trial.revoke(GUEST)).toBe(true);
    expect(
      store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(ids[0] as string),
    ).toMatchObject({ status: 'CANCELLED' });
    expect(
      store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(ids[1] as string),
    ).toMatchObject({ status: 'CANCELLED' });
    expect(
      store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(ids[2] as string),
    ).toMatchObject({ status: 'CANCELLING' });
    expect(
      store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(otherJob),
    ).toMatchObject({ status: 'QUEUED' });
    store.close();
  });

  it('redeems invite once and rolls back use when caller transaction fails', () => {
    const { store, trial, setNow } = setup();
    const invite = store.transaction(() => trial.createInvite());
    expect(() =>
      store.transaction(() => {
        trial.redeemInvite(GUEST, CHAT, invite.token);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    store.transaction(() => {
      trial.redeemInvite(GUEST, CHAT, invite.token);
    });
    expect(trial.access(GUEST).role).toBe('guest');
    expectCode(() => {
      store.transaction(() => {
        trial.redeemInvite('818181', '919191', invite.token);
      });
    }, 'INVITE_INVALID');
    const oldInvite = store.transaction(() => trial.createInvite(1));
    setNow(1_002);
    expectCode(() => {
      store.transaction(() => {
        trial.redeemInvite('828282', '929292', oldInvite.token);
      });
    }, 'INVITE_INVALID');
    expect(trial.access('828282').role).toBe('denied');
    expectCode(() => {
      store.transaction(() => {
        trial.redeemInvite(GUEST, CHAT, 'A'.repeat(43));
      });
    }, 'INVITE_INVALID');
    store.close();
  });

  it('enforces message/control/job quotas, rolling windows, duplicate updates and transaction rollback', () => {
    const { store, trial, setNow, getNow } = setup();
    grant(trial, GUEST, 100_000);
    trial.chargeMessage(GUEST, 5);
    trial.chargeMessage(GUEST, 5);
    expect(trial.listGuests()[0]?.messagesUsed).toBe(1);
    expect(() => {
      trial.chargeMessage(GUEST, 6);
    }).not.toThrow();
    const limited = new TrialStore(
      store,
      OWNER,
      {
        ...policy,
        maxMessagesPerWindow: 2,
        controlMaxPerMinute: 1,
        jobWindowMs: 1_000,
        maxJobsPerWindow: 1,
      },
      { now: getNow },
    );
    expectCode(() => {
      limited.chargeMessage(GUEST, 7);
    }, 'QUOTA_MESSAGE_RATE');
    limited.chargeMessage(GUEST, 10, 'control');
    expectCode(() => {
      limited.chargeMessage(GUEST, 11, 'control');
    }, 'QUOTA_CONTROL_RATE');
    limited.chargeJob(GUEST, 20);
    limited.chargeJob(GUEST, 20);
    expectCode(() => {
      limited.chargeJob(GUEST, 21);
    }, 'QUOTA_JOB_RATE');
    expect(trial.listGuests()[0]?.jobsUsed).toBe(1);
    setNow(62_000);
    expect(() => {
      limited.chargeMessage(GUEST, 22);
    }).not.toThrow();
    expect(() =>
      store.transaction(() => {
        limited.chargeJob(GUEST, 23);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(trial.listGuests()[0]?.jobsUsed).toBe(1);
    store.close();
  });

  it('counts CANCELLING jobs and sessions toward their limits', () => {
    const { store, trial, getNow } = setup();
    grant(trial);
    const { jobId } = runningJob(store, GUEST, CHAT);
    store.database
      .prepare("UPDATE jobs SET status='CANCELLING' WHERE id=?")
      .run(jobId);
    const restricted = new TrialStore(
      store,
      OWNER,
      {
        ...policy,
        maxPendingJobs: 1,
        maxSessions: 1,
      },
      { now: getNow },
    );
    expectCode(() => {
      restricted.chargeJob(GUEST, 80);
    }, 'QUOTA_PENDING_JOBS');
    expectCode(() => {
      restricted.assertCanCreateSession(GUEST);
    }, 'QUOTA_SESSION_LIMIT');
    restricted.assertCanCreateSession(OWNER);
    store.close();
  });

  it('tracks usage across sessions, accepts last over-limit response, deduplicates sequences and blocks uncertain usage', () => {
    const { store, trial } = setup();
    grant(trial);
    const first = runningJob(store, GUEST, CHAT);
    const op = trial.beginUsage(GUEST, first.sessionId, first.jobId);
    expect(op?.remainingTokens).toBe(policy.sessionTokenLimit);
    const operationId = op?.operationId as string;
    trial.recordUsage(operationId, 0, policy.sessionTokenLimit + 10);
    trial.recordUsage(operationId, 0, policy.sessionTokenLimit + 10);
    expectCode(() => {
      trial.recordUsage(operationId, 0, 1);
    }, 'USAGE_EVENT_CONFLICT');
    trial.finishUsage(operationId, true);
    const secondSession = store.transaction(
      () => store.createSession(GUEST, '727272', 'second').id,
    );
    store.transaction(() => store.queueJob(GUEST, '727272', 'again', 20));
    const secondJob = store.database
      .prepare('SELECT id FROM jobs WHERE session_id=?')
      .get(secondSession) as { id: string };
    store.database
      .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
      .run(secondJob.id);
    const userLimited = new TrialStore(
      store,
      OWNER,
      {
        ...policy,
        userTokenLimit: policy.sessionTokenLimit,
      },
      { now: () => 1_000 },
    );
    expectCode(
      () => userLimited.beginUsage(GUEST, secondSession, secondJob.id),
      'QUOTA_TOKEN_LIMIT',
    );
    store.close();
  });

  it('marks incomplete and recovered usage uncertain, and enforces pending operations across sessions', () => {
    const { store, trial } = setup();
    grant(trial);
    const a = runningJob(store, GUEST, CHAT);
    const pending = trial.beginUsage(GUEST, a.sessionId, a.jobId);
    expect(pending).not.toBeNull();
    const otherSession = store.transaction(
      () => store.createSession(GUEST, '737373', 'other').id,
    );
    store.transaction(() => store.queueJob(GUEST, '737373', 'again', 20));
    const other = store.database
      .prepare('SELECT id FROM jobs WHERE session_id=?')
      .get(otherSession) as { id: string };
    store.database
      .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
      .run(other.id);
    expectCode(
      () => trial.beginUsage(GUEST, otherSession, other.id),
      'QUOTA_USAGE_UNKNOWN',
    );
    expect(trial.recoverPendingUsage()).toBe(1);
    expectCode(
      () => trial.beginUsage(GUEST, otherSession, other.id),
      'QUOTA_USAGE_UNKNOWN',
    );
    expect(trial.listGuests()[0]?.usageUncertain).toBe(true);
    store.close();
  });

  it('expires and clears dialogs with revisioned updates', () => {
    const { store, trial, setNow } = setup();
    trial.setDialog(GUEST, CHAT, 'queue');
    expect(trial.getDialog(GUEST, CHAT)).toMatchObject({
      command: 'queue',
      revision: 0,
    });
    trial.setDialog(GUEST, CHAT, 'cancel');
    expect(trial.getDialog(GUEST, CHAT)).toMatchObject({ revision: 1 });
    setNow(301_000);
    expect(trial.getDialog(GUEST, CHAT)).toBeNull();
    trial.setDialog(GUEST, CHAT, 'new');
    trial.clearDialog(GUEST, CHAT);
    trial.setDialog(GUEST, CHAT, 'invite');
    trial.clearAllDialogs();
    expect(trial.getDialog(GUEST, CHAT)).toBeNull();
    store.close();
  });

  it('uses menu generation CAS for completion and retries', () => {
    const { store, trial } = setup();
    trial.queueMenu(CHAT, 'guest');
    const old = trial.dueMenus()[0];
    expect(old).toBeDefined();
    trial.queueMenu(CHAT, 'default');
    expect(trial.completeMenu(CHAT, old?.generation as number)).toBe(false);
    const current = trial.dueMenus()[0];
    expect(current).toMatchObject({
      role: 'default',
      generation: 1,
      attempts: 0,
    });
    expect(trial.retryMenu(CHAT, current?.generation as number, 2_000)).toBe(
      true,
    );
    expect(trial.dueMenus(1_000)).toEqual([]);
    expect(trial.completeMenu(CHAT, current?.generation as number)).toBe(true);
    store.close();
  });
});
