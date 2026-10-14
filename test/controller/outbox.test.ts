import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { retryDelay } from '../../src/controller/service.js';
import { ControllerStore, splitMessage } from '../../src/controller/store.js';
import { TelegramError } from '../../src/controller/telegram.js';
import type { OutboxRecord } from '../../src/controller/types.js';
import {
  artifactsPath,
  createSession,
  ensureArtifactsDirectory,
  memoryStore,
  removeDatabaseArtifacts,
  USER_ID,
  CHAT_ID,
} from './helpers.js';

describe('durable outbox and prompt bindings', () => {
  it('chunks by UTF-16 length without splitting surrogate pairs and repeats the prefix', () => {
    const chunks = splitMessage('Session S | Job J\n', '😀'.repeat(4000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(3500);
      expect(chunk.startsWith('Session S | Job J\n')).toBe(true);
      const body = chunk.slice('Session S | Job J\n'.length);
      expect(/^(?:😀)*$/u.test(body)).toBe(true);
      if (index < chunks.length - 1) expect(body.length).toBeGreaterThan(0);
    }
  });

  it('does not deliver a later chunk while an earlier chunk is waiting for retry', () => {
    const store = memoryStore({ now: () => 100 });
    const sessionId = createSession(store);
    store.transaction(() => {
      store.reply(CHAT_ID, '😀'.repeat(4000), sessionId);
    });
    const sessionReply = store.dueOutbox(100)[0];
    store.deliverOutbox(sessionReply?.id ?? '', Number(CHAT_ID), 900, 100);
    const first = store.dueOutbox(100).find((item) => item.text.includes('😀'));
    expect(first).toBeDefined();
    store.retryOutbox(first?.id ?? '', 500);
    expect(store.dueOutbox(100)).toHaveLength(0);
    const retry = store.dueOutbox(500).find((item) => item.text.includes('😀'));
    expect(retry?.id).toBe(first?.id);
    store.deliverOutbox(retry?.id ?? '', Number(CHAT_ID), 901, 500);
    const nextChunk = store
      .dueOutbox(500)
      .find((item) => item.text.includes('😀'));
    expect(nextChunk).toBeDefined();
    expect(nextChunk?.id).not.toBe(retry?.id);
    store.close();
  });

  it('persists retry timing, marks permanent delivery failure, and reports the failure separately', () => {
    const now = 100;
    const store = memoryStore({ now: () => now });
    createSession(store);
    const jobId = store.transaction(() =>
      store.queueJob(USER_ID, CHAT_ID, 'hello', 10),
    );
    const ack = store.dueOutbox(now).find((item) => item.kind === 'ack');
    expect(ack).toBeDefined();
    store.retryOutbox(ack?.id ?? '', 600);
    expect(store.dueOutbox(599).some((item) => item.id === ack?.id)).toBe(
      false,
    );
    expect(store.dueOutbox(600).some((item) => item.id === ack?.id)).toBe(true);
    expect(retryDelay(0, new TelegramError('rate_limited', 9))).toBe(9000);
    expect(retryDelay(10, new TelegramError('transient'))).toBe(30_000);
    store.failOutbox(ack?.id ?? '');
    expect(store.statusForJob(USER_ID, jobId)?.failedDeliveries).toBe(1);
    expect(store.dueOutbox(1000).some((item) => item.id === ack?.id)).toBe(
      false,
    );
    store.close();
  });

  it('persists delivered prompt mapping across reopen, closes it on terminal state, and does not redeliver', async () => {
    await ensureArtifactsDirectory();
    const path = artifactsPath('prompt-reopen');
    let store = new ControllerStore(new DatabaseSync(path), {
      now: () => 1000,
    });
    createSession(store);
    const jobId = store.transaction(() =>
      store.queueJob(USER_ID, CHAT_ID, 'ask: input', 10),
    );
    store.scheduleAvailable(1000, 1, 60_000);
    store.advanceStep(jobId, 1100);
    const prompt = store.dueOutbox(1100).find((item) => item.kind === 'prompt');
    expect(prompt).toBeDefined();
    store.deliverOutbox(prompt?.id ?? '', Number(CHAT_ID), 7711, 1200);
    expect(store.findPrompt(CHAT_ID, 7711)).toMatchObject({
      jobId,
      ownerId: USER_ID,
      active: true,
    });
    store.close();

    store = new ControllerStore(new DatabaseSync(path), { now: () => 2000 });
    expect(store.findPrompt(CHAT_ID, 7711)).toMatchObject({
      jobId,
      active: true,
    });
    expect(store.dueOutbox(2000).some((item) => item.id === prompt?.id)).toBe(
      false,
    );
    store.transaction(() =>
      store.steerJob(USER_ID, jobId, 'answer', 10, CHAT_ID),
    );
    store.scheduleAvailable(2100, 1, 60_000);
    store.advanceStep(jobId, 2200);
    store.advanceStep(jobId, 2300);
    expect(store.statusForJob(USER_ID, jobId)?.status).toBe('COMPLETED');
    expect(store.findPrompt(CHAT_ID, 7711)).toMatchObject({
      jobId,
      active: false,
    });
    store.close();
    await removeDatabaseArtifacts(path);
  });

  it('stores bounded chunks in SQLite with one repeated session/job prefix per part', () => {
    const store = memoryStore({ now: () => 1 });
    createSession(store, 'long');
    const content = '😀'.repeat(1800);
    const jobId = store.transaction(() =>
      store.queueJob(USER_ID, CHAT_ID, content, 10),
    );
    store.scheduleAvailable(1, 1, 60_000);
    store.advanceStep(jobId, 2);
    store.advanceStep(jobId, 3);
    store.advanceStep(jobId, 4);
    const results: OutboxRecord[] = [];
    for (let messageId = 100; messageId < 110; messageId += 1) {
      const part = store.dueOutbox(5).find((item) => item.kind === 'completed');
      if (part === undefined) break;
      results.push(part);
      store.deliverOutbox(part.id, Number(CHAT_ID), messageId, 5);
    }
    expect(results.length).toBeGreaterThan(1);
    expect(
      results.every(
        (item) =>
          item.text.length <= 3500 && item.text.includes(`Job ${jobId}`),
      ),
    ).toBe(true);
    expect(
      results
        .map((item) => item.text.slice(item.text.indexOf('\n') + 1))
        .join('')
        .includes(content),
    ).toBe(true);
    store.close();
  });
});
