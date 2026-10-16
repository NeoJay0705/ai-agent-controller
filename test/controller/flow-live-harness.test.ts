import { describe, expect, it } from 'vitest';
import { lstat } from 'node:fs/promises';

import {
  LiveHarnessError,
  MockTelegramTransport,
  liveGateEnabled,
  RealRuntimeBudget,
  parseAgentNodeBudget,
  validateLiveArtifactPath,
  createLiveHarness,
  MAX_STAGE_MS,
  waitForStage,
  SYNTHETIC_USER_ID,
  SYNTHETIC_CHAT_ID,
} from './flow-live-harness.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { AgentRuntime } from '../../src/flow/types.js';
import { resolve } from 'node:path';

const SAFE_ROOT = resolve(process.cwd(), '.test-artifacts/pi-flow/live-model');

describe('live-model test safety helpers (offline only)', () => {
  it('accepts the default and bounded Agent Node budgets with a hard cap of twenty', () => {
    expect(parseAgentNodeBudget(undefined)).toBe(12);
    expect(parseAgentNodeBudget('1')).toBe(1);
    expect(parseAgentNodeBudget('20')).toBe(20);
    for (const value of ['0', '21', '1.5', '-1', 'abc']) {
      expect(() => parseAgentNodeBudget(value)).toThrow(
        expect.objectContaining({ code: 'AGENT_NODE_BUDGET_INVALID' }),
      );
    }
  });

  it('allows only explicit artifact directories below the repository live-model root', () => {
    expect(validateLiveArtifactPath(undefined)).toBeUndefined();
    expect(validateLiveArtifactPath(`${SAFE_ROOT}/runs`)).toBe(
      `${SAFE_ROOT}/runs`,
    );
    for (const path of [
      SAFE_ROOT,
      `${SAFE_ROOT}/../outside`,
      'relative/path',
    ]) {
      expect(() => validateLiveArtifactPath(path)).toThrow(
        expect.objectContaining({ code: 'ARTIFACT_PATH_INVALID' }),
      );
    }
  });

  it('accepts only synthetic Telegram Bot API endpoints and records business messages', async () => {
    const telegram = new MockTelegramTransport();
    const updates = new AbortController();
    const empty = await telegram.fetcher(
      `https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getUpdates`,
      { method: 'POST', body: '{}', signal: updates.signal },
    );
    const emptyEnvelope = (await empty.json()) as { result: unknown };
    expect(emptyEnvelope.result).toEqual([]);
    telegram.push('/new offline');
    const result = await telegram.fetcher(
      `https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getUpdates`,
      { method: 'POST', body: '{}', signal: updates.signal },
    );
    const updateEnvelope = (await result.json()) as { result: unknown[] };
    expect(updateEnvelope.result).toHaveLength(1);
    const sent = await telegram.fetcher(
      `https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/sendMessage`,
      {
        method: 'POST',
        body: JSON.stringify({ chat_id: 515151, text: 'hello' }),
      },
    );
    const sentEnvelope = (await sent.json()) as {
      ok: boolean;
      result: { message_id: number; chat: { id: number } };
    };
    expect(sentEnvelope.ok).toBe(true);
    expect(Number.isSafeInteger(sentEnvelope.result.message_id)).toBe(true);
    expect(sentEnvelope.result.chat.id).toBe(515151);
    expect(telegram.sent[0]).toMatchObject({ text: 'hello', kind: 'other' });
    const client = new TelegramClient(
      '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
      telegram.fetcher,
    );
    const signal = new AbortController().signal;
    await expect(
      client.sendMessage('424242', 'READY', signal),
    ).resolves.toMatchObject({
      chatId: Number(SYNTHETIC_USER_ID),
    });
    await expect(
      client.sendMessage('515151', 'normal chat', signal),
    ).resolves.toMatchObject({
      chatId: Number(SYNTHETIC_CHAT_ID),
    });
    await expect(
      client.sendMessage('616161', 'rejected', signal),
    ).rejects.toMatchObject({
      kind: 'network',
    });
    expect(telegram.methods).toEqual([
      'getUpdates',
      'getUpdates',
      'sendMessage',
      'sendMessage',
      'sendMessage',
      'sendMessage',
    ]);
    await expect(
      telegram.fetcher('https://example.invalid/bot/getUpdates', {
        method: 'POST',
      }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_REJECTED' });
    await expect(
      telegram.fetcher(
        'https://user:pass@api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/sendMessage',
        {
          method: 'POST',
          body: JSON.stringify({ chat_id: 515151, text: 'no' }),
        },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_REJECTED' });
    await expect(
      telegram.fetcher(
        'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/deleteWebhook',
        { method: 'POST' },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_REJECTED' });
  });

  it('settles an in-flight mock poll on abort and removes its listener', async () => {
    const telegram = new MockTelegramTransport();
    const controller = new AbortController();
    const call = telegram.fetcher(
      'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getUpdates',
      { method: 'POST', signal: controller.signal },
    );
    controller.abort();
    await call;
    expect(telegram.pendingTransportCount).toBe(0);
    telegram.stop();
    await expect(
      telegram.fetcher(
        'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getUpdates',
        { method: 'POST' },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_REJECTED' });
  });

  it('reserves a bounded counter before delegating and delegates dispose', async () => {
    const calls: string[] = [];
    // Unit-only delegate fixture. The gated scenario always uses PiCliRpcRuntime.
    const delegate = {
      run: () => {
        calls.push('run');
        return Promise.resolve({
          transition: 'ready',
          result: { suggestedFlow: null },
        });
      },
      dispose: () => {
        calls.push('dispose');
        return Promise.resolve();
      },
    } as unknown as AgentRuntime;
    const budget = new RealRuntimeBudget(delegate as never, 1, { value: 0 });
    const input = {
      controllerSessionId: 'synthetic',
      jobId: 'synthetic',
      node: {
        id: 'recommend',
        kind: 'agent',
        resultContract: 'recommendation',
      },
      definition: { id: 'intake' },
      input: '{}',
      state: {},
      historyFacts: [],
      signal: new AbortController().signal,
    } as unknown as Parameters<AgentRuntime['run']>[0];
    await budget.run(input);
    await expect(budget.run(input)).rejects.toMatchObject({
      code: 'AGENT_NODE_BUDGET_EXCEEDED',
    });
    await budget.dispose();
    expect(calls).toEqual(['run', 'dispose']);
    expect(budget.trace).toHaveLength(1);
  });

  it('wires a real offline Service and Telegram client without invoking an Agent', async () => {
    const authFile = resolve(
      process.cwd(),
      '.test-artifacts/pi-flow/live-model/offline-unused-auth.json',
    );
    await expect(lstat(authFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const harness = await createLiveHarness({ authFile });
    try {
      expect(liveGateEnabled(process.env)).toBe(false);
      harness.start();
      await waitForStage(
        'offline-ready',
        () => harness.telegram.sent.find((message) => message.kind === 'ready'),
        { maxMs: MAX_STAGE_MS },
      );
      harness.telegram.push('/new offline-session');
      const session = await waitForStage(
        'offline-session',
        () => harness.resources.store.selectedSession('424242', '515151'),
        { maxMs: MAX_STAGE_MS },
      );
      expect(session.name).toBe('offline-session');
      const cursor = harness.telegram.sent.length;
      harness.telegram.push('/status');
      await waitForStage(
        'offline-status',
        () =>
          harness.telegram.sent
            .slice(cursor)
            .find((message) =>
              message.text.includes('No jobs in the selected session.'),
            ),
        { maxMs: MAX_STAGE_MS },
      );
      expect(harness.runtime.trace).toHaveLength(0);
      expect(harness.runtime.spawnCount).toBe(0);
    } finally {
      await harness.close();
    }
    expect(harness.runtime.trace).toHaveLength(0);
    expect(harness.runtime.spawnCount).toBe(0);
    expect(
      (harness.report['cleanup'] as Record<string, unknown>)['serviceStopped'],
    ).toBe(true);
    await expect(lstat(authFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      lstat(resolve(harness.config.dataDir, 'controller.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not inspect auth settings or create runtime while the gate is disabled', () => {
    const environment = {
      PI_FLOW_LIVE_TEST: '0',
      get PI_FLOW_LIVE_AUTH_FILE(): never {
        throw new Error('Auth path must not be read while gated off.');
      },
      get PI_FLOW_LIVE_ARTIFACT_ROOT(): never {
        throw new Error('Artifact path must not be read while gated off.');
      },
    };
    expect(liveGateEnabled(environment)).toBe(false);
    expect(() => {
      if (!liveGateEnabled(environment))
        throw new LiveHarnessError('LIVE_DISABLED', 'gate');
    }).toThrow(expect.objectContaining({ code: 'LIVE_DISABLED' }));
  });
});
