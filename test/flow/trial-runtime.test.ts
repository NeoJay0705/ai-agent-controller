import { describe, expect, it } from 'vitest';

import { TrialStore } from '../../src/controller/trial-store.js';
import { DEFAULT_TRIAL_POLICY } from '../../src/controller/trial-policy.js';
import { TrialBudgetRuntime } from '../../src/flow/trial-runtime.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import type { AgentRuntime } from '../../src/flow/types.js';
import {
  memoryController,
  queueJob,
  FLOW_USER_ID,
  TEST_RUNTIME,
  TEST_LIMITS,
} from './helpers.js';

function guestFixture(inner: AgentRuntime) {
  const store = memoryController();
  const trials = new TrialStore(store, FLOW_USER_ID, DEFAULT_TRIAL_POLICY);
  store.transaction(() => {
    trials.grant('616161', 60_000, '616161');
  });
  const { jobId, sessionId } = queueJob(store, 'synthetic', {
    ownerId: '616161',
    chatId: '616161',
  });
  store.database
    .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
    .run(jobId);
  const bundle = createFlowBundle({
    runtimes: { intake: TEST_RUNTIME, mbti: TEST_RUNTIME, natal: TEST_RUNTIME },
    limits: { intake: TEST_LIMITS, mbti: TEST_LIMITS, natal: TEST_LIMITS },
  });
  const flow = bundle.flows[0];
  const node = flow?.nodes[0];
  if (flow === undefined || node === undefined)
    throw new Error('Missing fixture flow.');
  const runtime = new TrialBudgetRuntime(inner, store, trials);
  const input = {
    controllerSessionId: sessionId,
    jobId,
    node,
    definition: flow,
    input: 'x',
    state: {},
    historyFacts: [],
    signal: new AbortController().signal,
  };
  return { store, trials, jobId, runtime, input };
}

describe('TrialBudgetRuntime', () => {
  it('bypasses accounting for an Owner job', async () => {
    const store = memoryController();
    const trials = new TrialStore(store, FLOW_USER_ID, DEFAULT_TRIAL_POLICY);
    const { jobId, sessionId } = queueJob(store, 'owner work');
    store.database
      .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
      .run(jobId);
    const inner: AgentRuntime = {
      run(input) {
        expect(input.usageBudget).toBeUndefined();
        return Promise.resolve({
          transition: 'ready',
          result: { suggestedFlow: null },
        });
      },
      async dispose() {},
    };
    const runtime = new TrialBudgetRuntime(inner, store, trials);
    const flow = (
      await import('../../src/flow/definitions.js')
    ).createFlowBundle({
      runtimes: {
        intake: TEST_RUNTIME,
        mbti: TEST_RUNTIME,
        natal: TEST_RUNTIME,
      },
      limits: { intake: TEST_LIMITS, mbti: TEST_LIMITS, natal: TEST_LIMITS },
    }).flows[0];
    const node = flow?.nodes[0];
    if (flow === undefined || node === undefined)
      throw new Error('Missing fixture flow');
    await runtime.run({
      controllerSessionId: sessionId,
      jobId,
      node,
      definition: flow,
      input: 'x',
      state: {},
      historyFacts: [],
      signal: new AbortController().signal,
    });
    expect(
      store.database
        .prepare('SELECT COUNT(*) AS count FROM trial_usage_operations')
        .get(),
    ).toEqual({ count: 0 });
    await runtime.dispose();
    store.close();
  });

  it('counts the final over-limit request and blocks the next request', async () => {
    let calls = 0;
    const fixture = guestFixture({
      run(input) {
        const budget = input.usageBudget;
        if (budget === undefined) throw new Error('Missing usage budget.');
        calls += 1;
        budget.onRequestStarted(0);
        budget.onUsage(0, budget.limitTokens + 1);
        budget.onSettled(true);
        return Promise.resolve({
          transition: 'ready',
          result: { suggestedFlow: null },
        });
      },
      async dispose() {},
    });
    try {
      await fixture.runtime.run(fixture.input);
      expect(fixture.trials.listGuests()[0]?.tokensUsed).toBe(100_001);
      await expect(fixture.runtime.run(fixture.input)).rejects.toMatchObject({
        code: 'FLOW_TOKEN_LIMIT',
      });
      expect(calls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  it('blocks later jobs when usage is absent or incomplete', async () => {
    const cases: Array<{ inner: AgentRuntime; firstCode: string }> = [
      {
        inner: {
          run: () =>
            Promise.resolve({
              transition: 'ready',
              result: { suggestedFlow: null },
            }),
          async dispose() {},
        },
        firstCode: 'FLOW_USAGE_UNKNOWN',
      },
      {
        inner: {
          run(input) {
            input.usageBudget?.onRequestStarted(0);
            input.usageBudget?.onSettled(false);
            return Promise.resolve({
              transition: 'ready',
              result: { suggestedFlow: null },
            });
          },
          async dispose() {},
        },
        firstCode: 'FLOW_USAGE_UNKNOWN',
      },
      {
        inner: {
          run(input) {
            input.usageBudget?.onRequestStarted(0);
            input.usageBudget?.onSettled(false);
            return Promise.reject(
              Object.assign(new Error('cancelled'), { code: 'FLOW_ABORTED' }),
            );
          },
          async dispose() {},
        },
        firstCode: 'FLOW_ABORTED',
      },
    ];
    for (const { inner, firstCode } of cases) {
      const fixture = guestFixture(inner);
      try {
        await expect(fixture.runtime.run(fixture.input)).rejects.toMatchObject({
          code: firstCode,
        });
        expect(fixture.trials.listGuests()[0]?.usageUncertain).toBe(true);
        await expect(fixture.runtime.run(fixture.input)).rejects.toMatchObject({
          code: 'FLOW_USAGE_UNKNOWN',
        });
      } finally {
        fixture.store.close();
      }
    }
  });

  it('recovers a pending operation as uncertain and blocks further usage', async () => {
    const inner: AgentRuntime = {
      run: () =>
        Promise.resolve({
          transition: 'ready',
          result: { suggestedFlow: null },
        }),
      async dispose() {},
    };
    const fixture = guestFixture(inner);
    fixture.store.transaction(() =>
      fixture.trials.beginUsage(
        '616161',
        fixture.input.controllerSessionId,
        fixture.jobId,
      ),
    );
    expect(fixture.trials.recoverPendingUsage()).toBe(1);
    try {
      await expect(fixture.runtime.run(fixture.input)).rejects.toMatchObject({
        code: 'FLOW_USAGE_UNKNOWN',
      });
      expect(fixture.trials.listGuests()[0]?.usageUncertain).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  it('does not finalize before an inner runtime settles after usage storage fails', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = guestFixture({
      async run(input) {
        started();
        await gate;
        input.usageBudget?.onRequestStarted(0);
        input.usageBudget?.onUsage(0, 5);
        input.usageBudget?.onSettled(true);
        return { transition: 'ready', result: { suggestedFlow: null } };
      },
      async dispose() {},
    });
    fixture.store.database.exec(
      `CREATE TRIGGER reject_usage BEFORE INSERT ON trial_usage_events BEGIN SELECT RAISE(ABORT, 'synthetic usage write failure'); END;`,
    );
    let settled = false;
    const running = fixture.runtime.run(fixture.input).finally(() => {
      settled = true;
    });
    try {
      await entered;
      expect(settled).toBe(false);
      expect(
        fixture.store.database
          .prepare('SELECT state FROM trial_usage_operations')
          .get(),
      ).toEqual({ state: 'pending' });
      release();
      await expect(running).rejects.toMatchObject({
        code: 'FLOW_STORAGE_INVALID',
      });
      expect(
        fixture.store.database
          .prepare('SELECT state FROM trial_usage_operations')
          .get(),
      ).toEqual({ state: 'uncertain' });
    } finally {
      release();
      fixture.store.close();
    }
  });

  it('counts known usage even when the business result is invalid and delegates dispose', async () => {
    let disposed = 0;
    const fixture = guestFixture({
      run(input) {
        input.usageBudget?.onRequestStarted(0);
        input.usageBudget?.onUsage(0, 9);
        input.usageBudget?.onSettled(true);
        return Promise.resolve({
          transition: 'invalid-transition',
          result: { invalid: true },
        } as never);
      },
      dispose() {
        disposed += 1;
        return Promise.resolve();
      },
    });
    try {
      const result = await fixture.runtime.run(fixture.input);
      expect(result).toMatchObject({ transition: 'invalid-transition' });
      expect(fixture.trials.listGuests()[0]?.tokensUsed).toBe(9);
      await fixture.runtime.dispose();
      expect(disposed).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  it('accounts settled guest callbacks and passes no budget to Owner', async () => {
    const store = memoryController();
    const trials = new TrialStore(store, FLOW_USER_ID, DEFAULT_TRIAL_POLICY);
    store.transaction(() => {
      trials.grant('616161', 60_000, '616161');
    });
    const { jobId, sessionId } = queueJob(store, 'synthetic', {
      ownerId: '616161',
      chatId: '616161',
    });
    store.database
      .prepare("UPDATE jobs SET status='RUNNING' WHERE id=?")
      .run(jobId);
    let budgetLimit = 0;
    const inner: AgentRuntime = {
      run(input) {
        expect(input.usageBudget).toBeDefined();
        budgetLimit = input.usageBudget?.limitTokens ?? 0;
        input.usageBudget?.onRequestStarted(1);
        input.usageBudget?.onUsage(1, 17);
        input.usageBudget?.onSettled(true);
        return Promise.resolve({
          transition: 'ready',
          result: { suggestedFlow: null },
        });
      },
      async dispose() {},
    };
    const runtime = new TrialBudgetRuntime(inner, store, trials);
    const flow = (
      await import('../../src/flow/definitions.js')
    ).createFlowBundle({
      runtimes: {
        intake: TEST_RUNTIME,
        mbti: TEST_RUNTIME,
        natal: TEST_RUNTIME,
      },
      limits: { intake: TEST_LIMITS, mbti: TEST_LIMITS, natal: TEST_LIMITS },
    }).flows[0];
    const node = flow?.nodes[0];
    if (flow === undefined || node === undefined)
      throw new Error('Missing fixture flow');
    const input = {
      controllerSessionId: sessionId,
      jobId,
      node,
      definition: flow,
      input: 'x',
      state: {},
      historyFacts: [],
      signal: new AbortController().signal,
    };
    await runtime.run(input);
    expect(budgetLimit).toBeGreaterThan(0);
    expect(trials.listGuests()[0]?.tokensUsed).toBe(17);
    expect(
      store.database
        .prepare('SELECT state,total_tokens FROM trial_usage_operations')
        .get(),
    ).toEqual({ state: 'complete', total_tokens: 17 });
    await runtime.dispose();
    store.close();
  });
});
