import { describe, expect, it } from 'vitest';

import { FlowExecutor } from '../../src/flow/executor.js';
import { FlowRunner } from '../../src/flow/runner.js';
import { FlowStore } from '../../src/flow/store.js';
import type { FlowLimits } from '../../src/flow/types.js';
import { createSession, flushTasks, waitUntil } from '../controller/helpers.js';
import {
  FakeAgentRuntime,
  FLOW_CHAT_ID,
  FLOW_USER_ID,
  TEST_LIMITS,
  memoryController,
  queueJob,
  steer,
  testFlowStore,
} from './helpers.js';

const NOW = 30_000;

function queueInSelectedSession(
  controller: ReturnType<typeof memoryController>,
  input: string,
): string {
  return controller.transaction(() =>
    controller.queueJob(FLOW_USER_ID, FLOW_CHAT_ID, input, 100),
  );
}

function createRunner(
  controller: ReturnType<typeof memoryController>,
  flowStore: FlowStore,
  fake: FakeAgentRuntime,
  options: {
    readonly concurrency?: number;
    readonly now?: () => number;
    readonly limits?: FlowLimits;
    readonly onError?: (error: Error) => void;
    readonly canRunOwner?: (ownerId: string) => boolean;
    readonly maxWorkersPerOwner?: (ownerId: string) => number;
  } = {},
): FlowRunner {
  const executor = new FlowExecutor(controller, flowStore, fake, {
    now: options.now ?? (() => NOW),
  });
  return new FlowRunner(controller, flowStore, executor, {
    concurrency: options.concurrency ?? 1,
    now: options.now ?? (() => NOW),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.canRunOwner === undefined
      ? {}
      : { canRunOwner: options.canRunOwner }),
    ...(options.maxWorkersPerOwner === undefined
      ? {}
      : { maxWorkersPerOwner: options.maxWorkersPerOwner }),
  });
}

describe('FlowRunner scheduling and worker lifetime', () => {
  it('reports persistence failures with a safe storage classification', async () => {
    const controller = memoryController(() => NOW);
    try {
      const { jobId } = queueJob(controller, 'persistence failure test');
      const flowStore = testFlowStore(controller, () => NOW);
      const persistenceError = new Error('synthetic persistence failure');
      flowStore.fail = () => {
        throw persistenceError;
      };
      const fake = new FakeAgentRuntime({
        responder: () => {
          throw new Error('synthetic provider failure');
        },
      });
      const reported: string[] = [];
      const runner = createRunner(controller, flowStore, fake, {
        onError: (error) => reported.push(error.message),
      });

      runner.tick();
      await waitUntil(() => reported.length === 1);

      expect(reported).toEqual(['FLOW_STORAGE_INVALID']);
      expect(reported).not.toContain(persistenceError.message);
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'RUNNING',
      );
      await runner.stop();
    } finally {
      controller.close();
    }
  });

  it('keeps same-Session FIFO and the partition while the first Job waits', async () => {
    const controller = memoryController(() => NOW);
    try {
      createSession(controller, 'fifo');
      const first = queueInSelectedSession(controller, 'first request');
      const second = queueInSelectedSession(controller, 'second request');
      const flowStore = testFlowStore(controller, () => NOW);
      const fake = new FakeAgentRuntime();
      const runner = createRunner(controller, flowStore, fake, {
        concurrency: 2,
      });

      runner.tick();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, first)?.status ===
          'WAITING_INPUT',
      );
      expect(controller.statusForJob(FLOW_USER_ID, second)).toMatchObject({
        status: 'QUEUED',
        startedAt: null,
      });
      runner.tick();
      await flushTasks();
      expect(controller.statusForJob(FLOW_USER_ID, second)?.status).toBe(
        'QUEUED',
      );

      steer(controller, first, 'unsupported');
      runner.tick();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, first)?.status === 'COMPLETED',
      );
      await waitUntil(() => {
        runner.tick();
        return (
          controller.statusForJob(FLOW_USER_ID, second)?.status ===
          'WAITING_INPUT'
        );
      });
      expect(
        controller.statusForJob(FLOW_USER_ID, second)?.startedAt,
      ).not.toBeNull();
      await runner.stop();
      expect(fake.disposeCount).toBe(1);
    } finally {
      controller.close();
    }
  });

  it('runs different Sessions concurrently and frees global slots while retaining waiting partitions', async () => {
    const controller = memoryController(() => NOW);
    try {
      const first = queueJob(controller, 'first session', {
        name: 'first-session',
        chatId: '515151',
      });
      const second = queueJob(controller, 'second session', {
        name: 'second-session',
        chatId: '616161',
      });
      const third = queueJob(controller, 'third session', {
        name: 'third-session',
        chatId: '717171',
      });
      const flowStore = testFlowStore(controller, () => NOW);
      const fake = new FakeAgentRuntime();
      const runner = createRunner(controller, flowStore, fake, {
        concurrency: 2,
      });

      runner.tick();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, first.jobId)?.status ===
            'WAITING_INPUT' &&
          controller.statusForJob(FLOW_USER_ID, second.jobId)?.status ===
            'WAITING_INPUT',
      );
      expect(controller.statusForJob(FLOW_USER_ID, third.jobId)?.status).toBe(
        'QUEUED',
      );
      await waitUntil(() => {
        runner.tick();
        return (
          controller.statusForJob(FLOW_USER_ID, third.jobId)?.status ===
          'WAITING_INPUT'
        );
      });
      expect(controller.statusForJob(FLOW_USER_ID, first.jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      expect(controller.statusForJob(FLOW_USER_ID, second.jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      await runner.stop();
    } finally {
      controller.close();
    }
  });

  it('fails waiting Jobs at wait/job deadlines and cancels the obsolete prompt', async () => {
    let now = NOW;
    const controller = memoryController(() => now);
    try {
      const shortLimits: FlowLimits = {
        ...TEST_LIMITS,
        waitTimeoutMs: 10,
        jobTimeoutMs: 500,
      };
      const { jobId } = queueJob(controller, 'timed request');
      const flowStore = testFlowStore(controller, () => now, shortLimits);
      const fake = new FakeAgentRuntime();
      const runner = createRunner(controller, flowStore, fake, {
        concurrency: 1,
        now: () => now,
      });
      runner.tick();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, jobId)?.status ===
          'WAITING_INPUT',
      );
      const prompt = controller
        .dueOutbox(now)
        .find((item) => item.jobId === jobId && item.kind === 'prompt');
      if (prompt === undefined) throw new Error('Expected a waiting prompt.');
      expect(controller.isOutboxSendable(prompt.id)).toBe(true);
      now += 11;
      runner.tick();
      expect(controller.statusForJob(FLOW_USER_ID, jobId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'TIMEOUT',
      });
      expect(controller.isOutboxSendable(prompt.id)).toBe(false);
      expect(fake.calls).toHaveLength(1);
      await runner.stop();
    } finally {
      controller.close();
    }
  });

  it('holds a running slot and Session lock until an aborted Agent child has joined', async () => {
    let now = NOW;
    let releaseChild: (() => void) | undefined;
    let childStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const controller = memoryController(() => now);
    const fake = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (input.node.id === 'recommend') {
          childStarted?.();
          await childGate;
        }
      },
    });
    try {
      const limits = { ...TEST_LIMITS, jobTimeoutMs: 1_000 };
      const first = queueJob(controller, 'blocked agent', {
        name: 'blocked',
        chatId: '515151',
      });
      const next = queueJob(controller, 'next session job', {
        name: 'next',
        chatId: '616161',
      });
      const flowStore = testFlowStore(controller, () => now, limits);
      const runner = createRunner(controller, flowStore, fake, {
        concurrency: 1,
        now: () => now,
      });
      runner.tick();
      await started;
      now += 1_001;
      runner.tick();
      expect(controller.statusForJob(FLOW_USER_ID, first.jobId)?.status).toBe(
        'RUNNING',
      );
      expect(controller.statusForJob(FLOW_USER_ID, next.jobId)?.status).toBe(
        'QUEUED',
      );
      runner.tick();
      expect(controller.statusForJob(FLOW_USER_ID, next.jobId)?.status).toBe(
        'QUEUED',
      );

      releaseChild?.();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, first.jobId)?.status ===
          'FAILED',
      );
      expect(
        controller.statusForJob(FLOW_USER_ID, first.jobId)?.failureCode,
      ).toBe('TIMEOUT');
      await waitUntil(() => {
        runner.tick();
        return (
          controller.statusForJob(FLOW_USER_ID, next.jobId)?.status ===
          'WAITING_INPUT'
        );
      });
      await runner.stop();
    } finally {
      releaseChild?.();
      controller.close();
    }
  });

  it('keeps a cancelling worker slot until the runtime promise settles before starting the next Session Job', async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    let aborted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const signalAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const controller = memoryController(() => NOW);
    const fake = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (input.node.id !== 'recommend') return;
        started?.();
        input.signal.addEventListener('abort', () => aborted?.(), {
          once: true,
        });
        await gate;
      },
    });
    try {
      const first = queueJob(controller, 'first', {
        name: 'cancel-first',
        chatId: '515151',
      });
      const second = queueJob(controller, 'second', {
        name: 'cancel-second',
        chatId: '616161',
      });
      const flowStore = testFlowStore(controller, () => NOW);
      const runner = createRunner(controller, flowStore, fake, {
        concurrency: 1,
      });
      runner.tick();
      await workerStarted;
      controller.transaction(() =>
        controller.requestCancellation(FLOW_USER_ID, first.jobId, FLOW_USER_ID),
      );
      runner.tick();
      await signalAborted;
      expect(controller.statusForJob(FLOW_USER_ID, first.jobId)?.status).toBe(
        'CANCELLING',
      );
      expect(controller.statusForJob(FLOW_USER_ID, second.jobId)?.status).toBe(
        'QUEUED',
      );
      runner.tick();
      expect(controller.statusForJob(FLOW_USER_ID, second.jobId)?.status).toBe(
        'QUEUED',
      );
      release?.();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, first.jobId)?.status ===
          'CANCELLED',
      );
      await waitUntil(() => {
        runner.tick();
        return (
          controller.statusForJob(FLOW_USER_ID, second.jobId)?.status ===
          'WAITING_INPUT'
        );
      });
      await runner.stop();
    } finally {
      release?.();
      controller.close();
    }
  });

  it('limits workers per owner across Sessions while allowing another owner to run', async () => {
    let release: (() => void) | undefined;
    const starts: string[] = [];
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = memoryController(() => NOW);
    const fake = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (input.node.id !== 'recommend') return;
        starts.push(input.jobId);
        await gate;
      },
    });
    try {
      const first = queueJob(controller, 'first', {
        name: 'owner-one',
        chatId: '515151',
      });
      const second = queueJob(controller, 'second', {
        name: 'owner-two',
        chatId: '616161',
      });
      const guest = queueJob(controller, 'guest', {
        name: 'guest-one',
        ownerId: 'guest-owner',
        chatId: '717171',
      });
      const flowStore = testFlowStore(controller, () => NOW);
      const runner = createRunner(controller, flowStore, fake, {
        concurrency: 2,
        maxWorkersPerOwner: () => 1,
      });
      runner.tick();
      await waitUntil(() => starts.length === 2);
      expect(starts).toContain(first.jobId);
      expect(starts).toContain(guest.jobId);
      expect(starts).not.toContain(second.jobId);
      expect(controller.statusForJob(FLOW_USER_ID, second.jobId)?.status).toBe(
        'QUEUED',
      );
      release?.();
      await waitUntil(
        () =>
          controller.statusForJob(FLOW_USER_ID, first.jobId)?.status ===
            'WAITING_INPUT' &&
          controller.statusForJob('guest-owner', guest.jobId)?.status ===
            'WAITING_INPUT',
      );
      await waitUntil(() => {
        runner.tick();
        return (
          controller.statusForJob(FLOW_USER_ID, second.jobId)?.status ===
          'WAITING_INPUT'
        );
      });
      await runner.stop();
    } finally {
      release?.();
      controller.close();
    }
  });

  it('stop aborts and joins workers before disposing the Agent runtime', async () => {
    let releaseChild: (() => void) | undefined;
    let childStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const controller = memoryController(() => NOW);
    const fake = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (input.node.id === 'recommend') {
          childStarted?.();
          await childGate;
        }
      },
    });
    try {
      const { jobId } = queueJob(controller, 'stop request');
      const flowStore = testFlowStore(controller, () => NOW);
      const runner = createRunner(controller, flowStore, fake);
      runner.tick();
      await started;
      const stopped = runner.stop();
      await flushTasks();
      expect(fake.disposeCount).toBe(0);
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'RUNNING',
      );
      releaseChild?.();
      await stopped;
      expect(fake.disposeCount).toBe(1);
      runner.tick();
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'RUNNING',
      );
    } finally {
      releaseChild?.();
      controller.close();
    }
  });
});
