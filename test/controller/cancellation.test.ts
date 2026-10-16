import { describe, expect, it } from 'vitest';
import { createSession, memoryStore, USER_ID, CHAT_ID } from './helpers.js';

describe('Job cancellation primitives', () => {
  it('cancels queued and waiting jobs, hides unauthorized jobs, and is idempotent', () => {
    const store = memoryStore({ now: () => 10_000 });
    try {
      createSession(store, 'owner', USER_ID, CHAT_ID);
      const queued = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'PRIVATE INPUT', 10),
      );
      expect(() =>
        store.transaction(() =>
          store.requestCancellation('stranger', queued, USER_ID),
        ),
      ).toThrow(/Job not found/);
      expect(
        store.transaction(() =>
          store.requestCancellation(USER_ID, queued, USER_ID),
        ),
      ).toBe('CANCELLED');
      expect(
        store.transaction(() =>
          store.requestCancellation(USER_ID, queued, USER_ID),
        ),
      ).toBe('CANCELLED');
      expect(store.statusForJob(USER_ID, queued)).toMatchObject({
        status: 'CANCELLED',
        failureCode: 'USER_CANCELLED',
      });
      expect(
        store
          .dueOutbox(10_000)
          .filter(
            (row) => row.jobId === queued && row.deliveryClass === 'control',
          ).length,
      ).toBe(1);
      expect(
        store
          .dueOutbox(10_000)
          .some((row) => row.text.includes('PRIVATE INPUT')),
      ).toBe(false);
    } finally {
      store.close();
    }
  });

  it('cancels waiting prompts and pending steering atomically', () => {
    const store = memoryStore({ now: () => 15_000 });
    try {
      createSession(store, 'waiting-owner', USER_ID, CHAT_ID);
      const job = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'waiting', 10),
      );
      store.transaction(() => {
        store.database
          .prepare("UPDATE jobs SET status='WAITING_INPUT' WHERE id=?")
          .run(job);
        store.enqueueJobNotification(job, 'prompt', 'old prompt', 0);
        store.steerJob(USER_ID, job, 'pending answer', 10, CHAT_ID);
      });
      const prompt = store.database
        .prepare(
          "SELECT id FROM outbox WHERE job_id=? AND kind='prompt' AND status='PENDING'",
        )
        .get(job) as { id: string };
      expect(store.isOutboxSendable(prompt.id)).toBe(true);
      store.transaction(() => store.requestCancellation(USER_ID, job, USER_ID));
      expect(store.statusForJob(USER_ID, job)).toMatchObject({
        status: 'CANCELLED',
        pendingSteering: 0,
        notAppliedSteering: 1,
      });
      expect(store.isOutboxSendable(prompt.id)).toBe(false);
      expect(
        store.database
          .prepare('SELECT reason FROM outbox_cancellations WHERE outbox_id=?')
          .get(prompt.id),
      ).toEqual({ reason: 'JOB_TERMINAL' });
      expect(
        store
          .dueOutbox(15_000)
          .filter(
            (row) => row.jobId === job && row.deliveryClass === 'control',
          ),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('counts CANCELLING jobs in the global pending limit until finalized', () => {
    const store = memoryStore({ now: () => 20_000 });
    try {
      createSession(store, 'owner-session', USER_ID, CHAT_ID);
      const running = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'running', 10),
      );
      store.database
        .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
        .run(running);
      expect(
        store.transaction(() =>
          store.requestCancellation(USER_ID, running, USER_ID),
        ),
      ).toBe('CANCELLING');

      createSession(store, 'second-owner-session', USER_ID, '616161');
      expect(() =>
        store.transaction(() =>
          store.queueJob(USER_ID, '616161', 'blocked', 1),
        ),
      ).toThrow(/pending job limit/i);
      expect(
        store.database
          .prepare('SELECT status FROM jobs WHERE id=?')
          .get(running),
      ).toEqual({ status: 'CANCELLING' });

      store.transaction(() => store.finishCancellation(running));
      expect(
        store.transaction(() =>
          store.queueJob(USER_ID, '616161', 'accepted', 1),
        ),
      ).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('keeps running jobs cancelling until finishCancellation and preserves terminal winners', () => {
    const store = memoryStore({ now: () => 20_000 });
    try {
      createSession(store, 'owner', USER_ID, CHAT_ID);
      const job = store.transaction(() =>
        store.queueJob(USER_ID, CHAT_ID, 'request', 10),
      );
      store.database
        .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
        .run(job);
      expect(
        store.transaction(() =>
          store.requestCancellation(USER_ID, job, USER_ID, 'TRIAL_EXPIRED'),
        ),
      ).toBe('CANCELLING');
      expect(store.statusForJob(USER_ID, job)?.status).toBe('CANCELLING');
      expect(store.transaction(() => store.finishCancellation(job))).toBe(
        'CANCELLED',
      );
      expect(store.transaction(() => store.finishCancellation(job))).toBe(
        'CANCELLED',
      );
      expect(
        store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE job_id=? AND delivery_class='control'",
          )
          .get(job),
      ).toEqual({ count: 2 });
    } finally {
      store.close();
    }
  });
});
