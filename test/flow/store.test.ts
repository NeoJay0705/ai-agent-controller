import { describe, expect, it } from 'vitest';

import type { ControllerStore } from '../../src/controller/store.js';
import { FlowStore } from '../../src/flow/store.js';
import { parseFlowExecutionState } from '../../src/flow/execution-types.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import { FlowRegistry } from '../../src/flow/registry.js';
import type {
  FlowDefinition,
  FlowLimits,
  FlowRuntime,
} from '../../src/flow/types.js';
import {
  CHAT_ID,
  createSession,
  memoryStore,
  USER_ID,
} from '../controller/helpers.js';

const runtime: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: 'FLOW_TEST_API_KEY',
};

const limits: FlowLimits = {
  nodeTimeoutMs: 1000,
  waitTimeoutMs: 10_000,
  jobTimeoutMs: 2000,
  maxTransitions: 100,
  maxRetries: 2,
  maxModelTurns: 20,
  maxToolCalls: 4,
  maxOutputChars: 10_000,
};

function registry(): FlowRegistry {
  return new FlowRegistry(
    createFlowBundle({
      runtimes: { intake: runtime, mbti: runtime, natal: runtime },
      limits: { intake: limits, mbti: limits, natal: limits },
    }),
  );
}

function registryWithCustomFlow(): FlowRegistry {
  const base = registry().snapshot();
  const custom: FlowDefinition = {
    id: 'custom',
    version: '1.0.0',
    name: 'Custom flow',
    resultDescription: 'A registered custom flow.',
    aliases: [],
    runtime,
    limits,
    entryNode: 'done',
    nodes: [
      {
        id: 'done',
        kind: 'server',
        handler: 'unsupported',
        systemPrompt: 'Host control only.',
        prompt: 'No model request.',
        expectedResult: 'No result.',
        resultContract: null,
        next: {},
      },
    ],
  };
  return new FlowRegistry({ ...base, flows: [...base.flows, custom] });
}

function createJob(store: ControllerStore, input = 'A supported goal'): string {
  createSession(store, 'flow-session');
  return store.transaction(() => store.queueJob(USER_ID, CHAT_ID, input, 10));
}

function recommendation(suggestedFlow: string | null = 'mbti') {
  return {
    transition: 'ready',
    result: { suggestedFlow },
  } as const;
}

function commitRecommendation(
  flowStore: FlowStore,
  jobId: string,
  suggestedFlow: string | null,
) {
  return flowStore.commitFlowStep({
    jobId,
    expectedRevision: 0,
    currentNodeId: 'recommend',
    transition: 'ready',
    agentResult: recommendation(suggestedFlow),
    state: { suggestedFlow },
    outcome: 'run',
  });
}

describe('FlowStore persistence and atomic transitions', () => {
  it('pins an immutable Flow snapshot once and sets a bounded Job deadline', () => {
    let now = 10_000;
    const controller = memoryStore({ now: () => now });
    try {
      const jobId = createJob(controller);
      const flowStore = new FlowStore(controller, registry(), {
        now: () => now,
      });

      const first = flowStore.getOrCreatePinnedFlowRun(jobId, 'intake', {
        stage: 'recommend',
      });
      now += 500;
      const repeated = flowStore.getOrCreatePinnedFlowRun(jobId, 'intake', {
        stage: 'replacement',
      });

      expect(first).toMatchObject({
        jobId,
        flowId: 'intake',
        nodeId: 'recommend',
        state: { stage: 'recommend' },
        revision: 0,
        transitions: 0,
        promptGeneration: 0,
        jobDeadline: 12_000,
      });
      expect(Object.isFrozen(first.bundle)).toBe(true);
      expect(repeated).toEqual(first);
      expect(() =>
        flowStore.getOrCreatePinnedFlowRun(jobId, 'mbti', {}),
      ).toThrow(/pinned Flow/i);
      expect(flowStore.getPinnedFlowRun(jobId)).toEqual(first);
    } finally {
      controller.close();
    }
  });

  it('commits wait state, facts, prompt generation, and capped deadline in one transaction', () => {
    let now = 20_000;
    const controller = memoryStore({ now: () => now });
    try {
      const jobId = createJob(controller);
      const flowStore = new FlowStore(controller, registry(), {
        now: () => now,
      });
      flowStore.getOrCreatePinnedFlowRun(jobId, 'intake');
      now = 20_500;

      const result = flowStore.wait({
        jobId,
        expectedRevision: 0,
        currentNodeId: 'recommend',
        transition: 'ready',
        target: { flowId: 'intake', nodeId: 'choose' },
        agentResult: recommendation(),
        state: { suggested: 'mbti' },
        waitPrompt: 'Choose mbti or natal.',
        facts: [
          {
            kind: 'birth_date',
            value: '1990-01-02',
            source: { messageId: 42, explicit: true },
            bankVersion: 'birth-v1',
            confirmed: true,
          },
        ],
      });

      expect(result.status).toBe('committed');
      if (result.status !== 'committed')
        throw new Error('Expected committed wait.');
      expect(result.run).toMatchObject({
        flowId: 'intake',
        nodeId: 'choose',
        revision: 1,
        transitions: 1,
        promptGeneration: 1,
        waitDeadline: 22_000,
        jobDeadline: 22_000,
      });
      const waitingJob = controller.statusForJob(USER_ID, jobId);
      if (waitingJob === null) throw new Error('Expected the waiting Job.');
      expect(waitingJob.status).toBe('WAITING_INPUT');
      expect(
        flowStore.getSessionFacts(waitingJob.sessionId, USER_ID),
      ).toMatchObject([
        {
          kind: 'birth_date',
          value: '1990-01-02',
          flowVersion: '1.0.0',
          bankVersion: 'birth-v1',
          createdAt: now,
          provenance: 'user_confirmed',
        },
      ]);
      const prompt = controller
        .dueOutbox(now)
        .find((item) => item.kind === 'prompt');
      expect(prompt).toMatchObject({ kind: 'prompt', promptGeneration: 1 });
      if (prompt === undefined) throw new Error('Expected the prompt.');
      expect(controller.isOutboxSendable(prompt.id)).toBe(true);
    } finally {
      controller.close();
    }
  });

  it('rejects stale revisions and invalid transitions without changing state', () => {
    const controller = memoryStore({ now: () => 30_000 });
    try {
      const jobId = createJob(controller);
      const flowStore = new FlowStore(controller, registry(), {
        now: () => 30_000,
      });
      const run = flowStore.getOrCreatePinnedFlowRun(jobId, 'intake');
      const stale = flowStore.commitFlowStep({
        jobId,
        expectedRevision: 7,
        currentNodeId: 'recommend',
        transition: 'ready',
        agentResult: recommendation(),
        state: { shouldNotPersist: true },
        outcome: 'run',
      });
      expect(stale).toMatchObject({ status: 'stale', run });

      expect(() =>
        flowStore.commitFlowStep({
          jobId,
          expectedRevision: 0,
          currentNodeId: 'recommend',
          transition: 'not-declared',
          agentResult: recommendation(),
          state: {},
          outcome: 'run',
        }),
      ).toThrow();
      expect(() =>
        flowStore.commitFlowStep({
          jobId,
          expectedRevision: 0,
          currentNodeId: 'recommend',
          transition: 'ready',
          target: { flowId: 'natal', nodeId: 'done' },
          agentResult: recommendation(),
          state: {},
          outcome: 'run',
        }),
      ).toThrow(/pinned Flow graph/i);
      expect(() =>
        flowStore.commitFlowStep({
          jobId,
          expectedRevision: 0,
          currentNodeId: 'recommend',
          transition: 'ready',
          agentResult: {
            transition: 'ready',
            result: { suggestedFlow: 'unsupported' },
          },
          state: {},
          outcome: 'run',
        }),
      ).toThrow(/Agent result is invalid/i);
      expect(flowStore.getPinnedFlowRun(jobId)).toEqual(run);
      expect(controller.statusForJob(USER_ID, jobId)?.status).toBe('QUEUED');
      expect(
        controller.dueOutbox(30_000).filter((item) => item.kind === 'prompt'),
      ).toEqual([]);
    } finally {
      controller.close();
    }
  });

  it('requires recommendation membership in the pinned bundle before writing', () => {
    const controller = memoryStore({ now: () => 30_000 });
    try {
      const jobId = createJob(controller);
      const flowStore = new FlowStore(controller, registry(), {
        now: () => 30_000,
      });
      const initial = flowStore.getOrCreatePinnedFlowRun(jobId, 'intake');
      const initialOutbox = controller.dueOutbox(30_000);

      for (const suggestedFlow of ['unsupported', 'intake']) {
        expect(() =>
          commitRecommendation(flowStore, jobId, suggestedFlow),
        ).toThrow(/Agent result is invalid/i);
        expect(flowStore.getPinnedFlowRun(jobId)).toEqual(initial);
        expect(controller.statusForJob(USER_ID, jobId)?.status).toBe('QUEUED');
        expect(controller.dueOutbox(30_000)).toEqual(initialOutbox);
      }

      const acceptedNull = commitRecommendation(flowStore, jobId, null);
      expect(acceptedNull).toMatchObject({
        status: 'committed',
        run: { flowId: 'intake', nodeId: 'choose', revision: 1 },
      });
    } finally {
      controller.close();
    }
  });

  it('uses pinned custom-flow membership after the global registry changes', () => {
    const pinnedController = memoryStore({ now: () => 31_000 });
    const unpinnedController = memoryStore({ now: () => 32_000 });
    try {
      const pinnedJobId = createJob(pinnedController);
      const pinnedStore = new FlowStore(
        pinnedController,
        registryWithCustomFlow(),
        { now: () => 31_000 },
      );
      pinnedStore.getOrCreatePinnedFlowRun(pinnedJobId, 'intake');
      const updatedGlobalStore = new FlowStore(pinnedController, registry(), {
        now: () => 31_000,
      });
      expect(
        commitRecommendation(updatedGlobalStore, pinnedJobId, 'custom'),
      ).toMatchObject({ status: 'committed' });

      const unpinnedJobId = createJob(unpinnedController);
      const originalStore = new FlowStore(unpinnedController, registry(), {
        now: () => 32_000,
      });
      const initial = originalStore.getOrCreatePinnedFlowRun(
        unpinnedJobId,
        'intake',
      );
      const updatedRegistryStore = new FlowStore(
        unpinnedController,
        registryWithCustomFlow(),
        { now: () => 32_000 },
      );
      expect(() =>
        commitRecommendation(updatedRegistryStore, unpinnedJobId, 'custom'),
      ).toThrow(/Agent result is invalid/i);
      expect(originalStore.getPinnedFlowRun(unpinnedJobId)).toEqual(initial);
      expect(
        unpinnedController.statusForJob(USER_ID, unpinnedJobId)?.status,
      ).toBe('QUEUED');
    } finally {
      pinnedController.close();
      unpinnedController.close();
    }
  });

  it('does not finish while steering is pending and consumes only captured IDs', () => {
    const controller = memoryStore({ now: () => 40_000 });
    try {
      const jobId = createJob(controller);
      const flowStore = new FlowStore(controller, registry(), {
        now: () => 40_000,
      });
      flowStore.getOrCreatePinnedFlowRun(jobId, 'intake');
      flowStore.commitFlowStep({
        jobId,
        expectedRevision: 0,
        currentNodeId: 'recommend',
        transition: 'ready',
        agentResult: recommendation(),
        state: {},
        outcome: 'run',
      });
      flowStore.commitFlowStep({
        jobId,
        expectedRevision: 1,
        currentNodeId: 'choose',
        transition: 'unsupported',
        state: { terminal: true },
        outcome: 'run',
      });
      controller.transaction(() => {
        controller.steerJob(USER_ID, jobId, 'first update', 10, CHAT_ID);
        controller.steerJob(USER_ID, jobId, 'second update', 10, CHAT_ID);
      });

      const dirty = flowStore.finish({
        jobId,
        expectedRevision: 2,
        currentNodeId: 'unsupported',
        state: { result: 'not committed yet' },
      });
      expect(dirty).toMatchObject({ status: 'dirty', run: { revision: 2 } });
      expect(controller.statusForJob(USER_ID, jobId)?.status).toBe('RUNNING');
      expect(
        controller
          .dueOutbox(40_000)
          .filter((item) => item.kind === 'completed'),
      ).toHaveLength(0);

      const pending = flowStore.getPendingSteering(jobId);
      const firstPending = pending[0];
      const secondPending = pending[1];
      if (firstPending === undefined || secondPending === undefined) {
        throw new Error('Expected two pending steering messages.');
      }
      const consumed = flowStore.consumePendingSteering(jobId, [secondPending]);
      expect(consumed.map((item) => item.content)).toEqual(['second update']);
      expect(
        flowStore.getPendingSteering(jobId).map((item) => item.content),
      ).toEqual(['first update']);
      expect(flowStore.consumePendingSteering(jobId, [secondPending])).toEqual(
        [],
      );
      expect(
        flowStore.consumePendingSteering(jobId, [firstPending]),
      ).toMatchObject([{ content: 'first update' }]);

      const completed = flowStore.finish({
        jobId,
        expectedRevision: 2,
        currentNodeId: 'unsupported',
        state: { result: 'accepted' },
        notificationText: 'Flow completed safely.',
      });
      expect(completed.status).toBe('committed');
      expect(controller.statusForJob(USER_ID, jobId)?.status).toBe('COMPLETED');
      expect(
        controller
          .dueOutbox(40_000)
          .filter((item) => item.kind === 'completed'),
      ).toHaveLength(1);
    } finally {
      controller.close();
    }
  });

  it('persists only confirmed, owner-scoped facts with safe JSON provenance', () => {
    const controller = memoryStore({ now: () => 50_000 });
    try {
      const sessionId = createSession(controller, 'fact-session');
      const flowStore = new FlowStore(controller, registry(), {
        now: () => 50_000,
      });
      const saved = flowStore.saveSessionFact(sessionId, USER_ID, {
        kind: 'birth_date',
        value: '1990-01-02',
        source: { messageId: 8 },
        bankVersion: 'birth-v1',
        confirmed: true,
      });
      expect(saved).toMatchObject({
        sessionId,
        ownerId: USER_ID,
        kind: 'birth_date',
        flowVersion: null,
        bankVersion: 'birth-v1',
        createdAt: 50_000,
        provenance: 'user_confirmed',
      });
      expect(
        flowStore.getSessionFact(sessionId, 'other-owner', 'birth_date'),
      ).toBeNull();
      expect(() =>
        flowStore.saveSessionFact(sessionId, 'other-owner', {
          kind: 'other_fact',
          value: true,
          source: { messageId: 8 },
          confirmed: true,
        }),
      ).toThrow(/Session not found/i);
      expect(() =>
        flowStore.saveSessionFact(sessionId, USER_ID, {
          kind: 'secret',
          value: 'sk-abcdefghijklmnopqrstuvwxyz1234567890',
          source: { messageId: 8 },
          confirmed: true,
        }),
      ).toThrow(/restricted data/i);
      expect(flowStore.getSessionFacts(sessionId, USER_ID)).toHaveLength(1);
    } finally {
      controller.close();
    }
  });

  it('binds one immutable Pi identity to each Controller Session', () => {
    const controller = memoryStore();
    try {
      const sessionId = createSession(controller, 'identity-session');
      const flowStore = new FlowStore(controller, registry());
      const identity = {
        piSessionId: '11111111-1111-4111-8111-111111111111',
        filePath: '/private/pi/session/file.jsonl',
      };
      expect(flowStore.savePiIdentity(sessionId, identity)).toEqual(identity);
      expect(flowStore.savePiIdentity(sessionId, identity)).toEqual(identity);
      expect(flowStore.getPiIdentity(sessionId)).toEqual(identity);
      expect(() =>
        flowStore.savePiIdentity(sessionId, {
          ...identity,
          piSessionId: '22222222-2222-4222-8222-222222222222',
        }),
      ).toThrow(/different Pi Session/i);
    } finally {
      controller.close();
    }
  });

  it('restart-fails every active Job once, preserves other outbox rows, and cancels prompts', () => {
    const now = 60_000;
    const controller = memoryStore({ now: () => now });
    try {
      const waitingSession = createSession(
        controller,
        'waiting',
        USER_ID,
        CHAT_ID,
      );
      const runningSession = createSession(
        controller,
        'running',
        USER_ID,
        '616161',
      );
      const queuedSession = createSession(
        controller,
        'queued',
        USER_ID,
        '717171',
      );
      const terminalSession = createSession(
        controller,
        'terminal',
        USER_ID,
        '818181',
      );
      const waitingId = controller.transaction(() =>
        controller.queueJob(USER_ID, CHAT_ID, 'ask: wait', 10),
      );
      const runningId = controller.transaction(() =>
        controller.queueJob(USER_ID, '616161', 'run now', 10),
      );
      const queuedId = controller.transaction(() =>
        controller.queueJob(USER_ID, '717171', 'wait in queue', 10),
      );
      const terminalId = controller.transaction(() =>
        controller.queueJob(USER_ID, '818181', 'terminal', 10),
      );
      controller.scheduleAvailable(now, 2, 10_000);
      controller.advanceStep(waitingId, now + 1);
      controller.transaction(() => {
        controller.steerJob(USER_ID, waitingId, 'late answer', 10, CHAT_ID);
        controller.enqueueJobNotification(
          terminalId,
          'prompt',
          'old pending prompt',
          0,
        );
        controller.database
          .prepare("UPDATE jobs SET status='WAITING_INPUT' WHERE id=?")
          .run(terminalId);
      });
      const oldPrompt = controller
        .dueOutbox(now + 1)
        .find((item) => item.jobId === terminalId && item.kind === 'prompt');
      if (oldPrompt === undefined) throw new Error('Expected terminal prompt.');
      controller.deliverOutbox(oldPrompt.id, 818181, 99001, now + 2);
      controller.transaction(() => {
        controller.enqueueJobNotification(
          terminalId,
          'prompt',
          'pending terminal prompt',
          0,
        );
        controller.database
          .prepare("UPDATE jobs SET status='COMPLETED' WHERE id=?")
          .run(terminalId);
      });
      const pendingTerminalPromptRow = controller.database
        .prepare(
          "SELECT id FROM outbox WHERE job_id=? AND kind='prompt' AND status='PENDING'",
        )
        .get(terminalId) as { id?: unknown } | undefined;
      if (typeof pendingTerminalPromptRow?.id !== 'string') {
        throw new Error('Expected pending terminal prompt row.');
      }
      const pendingTerminalPromptId = pendingTerminalPromptRow.id;
      const unrelatedAck = controller
        .dueOutbox(now + 2)
        .find((item) => item.jobId === queuedId && item.kind === 'ack');
      if (unrelatedAck === undefined) {
        throw new Error('Expected unrelated acknowledgement.');
      }
      const terminalPromptBeforeRestart = controller.database
        .prepare(
          `SELECT o.status, c.outbox_id AS cancellation_id
           FROM outbox o LEFT JOIN outbox_cancellations c ON c.outbox_id=o.id
           WHERE o.id=?`,
        )
        .get(pendingTerminalPromptId);
      expect(terminalPromptBeforeRestart).toEqual({
        status: 'PENDING',
        cancellation_id: null,
      });
      expect(controller.isOutboxSendable(pendingTerminalPromptId)).toBe(false);
      expect(
        controller.dueOutbox(now + 2).map((item) => item.id),
      ).not.toContain(pendingTerminalPromptId);
      expect(controller.findPrompt('818181', 99001)?.active).toBe(true);
      const flowStore = new FlowStore(controller, registry(), {
        now: () => now,
      });

      expect(flowStore.restartTerminateAll()).toBe(3);
      expect(flowStore.restartTerminateAll()).toBe(0);
      for (const jobId of [waitingId, runningId, queuedId]) {
        expect(controller.statusForJob(USER_ID, jobId)).toMatchObject({
          status: 'FAILED',
          failureCode: 'SERVER_RESTART',
        });
      }
      expect(controller.statusForJob(USER_ID, waitingId)).toMatchObject({
        pendingSteering: 0,
        notAppliedSteering: 1,
      });
      expect(controller.findPrompt('818181', 99001)?.active).toBe(false);
      expect(controller.isOutboxSendable(pendingTerminalPromptId)).toBe(false);
      expect(controller.isOutboxSendable(unrelatedAck.id)).toBe(true);
      expect(
        controller.dueOutbox(now + 2).map((item) => item.id),
      ).not.toContain(pendingTerminalPromptId);
      expect(
        controller.database
          .prepare(
            `SELECT o.status, c.reason AS cancellation_reason
             FROM outbox o LEFT JOIN outbox_cancellations c ON c.outbox_id=o.id
             WHERE o.id=?`,
          )
          .get(pendingTerminalPromptId),
      ).toEqual({
        status: 'PENDING',
        cancellation_reason: 'JOB_TERMINAL',
      });
      expect(
        controller.statusForJob(USER_ID, terminalId)?.failedDeliveries,
      ).toBe(0);
      expect(
        controller.database
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='failed'")
          .get(),
      ).toEqual({ count: 3 });
      expect(waitingSession).not.toBe(runningSession);
      expect(queuedSession).not.toBe(terminalSession);
    } finally {
      controller.close();
    }
  });

  it('reserves FIFO Jobs by Session, pins intake limits, and resumes a waiting Job without taking another partition', () => {
    let now = 70_000;
    const controller = memoryStore({ now: () => now });
    try {
      createSession(controller, 'fifo-partition');
      const first = controller.transaction(() =>
        controller.queueJob(USER_ID, CHAT_ID, 'first', 10),
      );
      const second = controller.transaction(() =>
        controller.queueJob(USER_ID, CHAT_ID, 'second', 10),
      );
      createSession(controller, 'other-partition', USER_ID, '616161');
      const other = controller.transaction(() =>
        controller.queueJob(USER_ID, '616161', 'other Session', 10),
      );
      const flowStore = new FlowStore(controller, registry(), {
        now: () => now,
      });

      const reserved = flowStore.reserveReadyJobs(now, 2);
      expect(reserved.map((job) => job.jobId)).toContain(first);
      expect(reserved.map((job) => job.jobId)).toContain(other);
      expect(reserved.map((job) => job.jobId)).not.toContain(second);
      const initial = flowStore.getPinnedFlowRun(first);
      if (initial === null) throw new Error('Expected a pinned Flow run.');
      expect(initial).toMatchObject({
        flowId: 'intake',
        nodeId: 'recommend',
        jobDeadline: now + limits.jobTimeoutMs,
      });
      expect(
        controller.database
          .prepare('SELECT started_at, deadline_at FROM jobs WHERE id=?')
          .get(first),
      ).toEqual({ started_at: now, deadline_at: now + limits.jobTimeoutMs });

      const moved = flowStore.commitFlowStep({
        jobId: first,
        expectedRevision: initial.revision,
        currentNodeId: 'recommend',
        transition: 'ready',
        agentResult: recommendation(),
        state: initial.state,
        outcome: 'run',
      });
      expect(moved.status).toBe('committed');
      const waiting = flowStore.waitAtCurrentNode({
        jobId: first,
        expectedRevision: 1,
        currentNodeId: 'choose',
        state: initial.state,
        waitPrompt: 'Select an option.',
      });
      expect(waiting).toMatchObject({
        status: 'committed',
        run: {
          flowId: 'intake',
          nodeId: 'choose',
          waitDeadline: now + limits.jobTimeoutMs,
        },
      });
      expect(controller.statusForJob(USER_ID, first)?.status).toBe(
        'WAITING_INPUT',
      );
      expect(
        controller.database
          .prepare('SELECT status FROM jobs WHERE id=?')
          .get(second),
      ).toEqual({ status: 'QUEUED' });

      controller.transaction(() =>
        controller.steerJob(USER_ID, first, 'answer', 10, CHAT_ID),
      );
      now += 100;
      const resumed = flowStore.reserveReadyJobs(now, 1);
      expect(resumed.map((job) => job.jobId)).toEqual([first]);
      expect(controller.statusForJob(USER_ID, first)?.status).toBe('RUNNING');
      expect(controller.statusForJob(USER_ID, second)?.status).toBe('QUEUED');
    } finally {
      controller.close();
    }
  });

  it('checkpoints only captured steering in sequence and rolls back state and consumption atomically', () => {
    const now = 80_000;
    const controller = memoryStore({ now: () => now });
    try {
      const jobId = createJob(controller, 'input checkpoint');
      const flowStore = new FlowStore(controller, registry(), {
        now: () => now,
      });
      expect(
        flowStore.reserveReadyJobs(now, 1).map((job) => job.jobId),
      ).toContain(jobId);
      const initial = flowStore.getPinnedFlowRun(jobId);
      if (initial === null) throw new Error('Expected a pinned Flow run.');
      const firstId = controller.transaction(() =>
        controller.steerJob(USER_ID, jobId, 'first input', 10, CHAT_ID),
      );
      const secondId = controller.transaction(() =>
        controller.steerJob(USER_ID, jobId, 'second input', 10, CHAT_ID),
      );
      const pending = flowStore.getPendingSteering(jobId);
      const first = pending[0];
      const second = pending[1];
      if (first === undefined || second === undefined) {
        throw new Error('Expected two captured inputs.');
      }
      expect(first.id).toBe(firstId);
      expect(second.id).toBe(secondId);
      expect(() =>
        flowStore.checkpointInput({
          jobId,
          expectedRevision: initial.revision,
          currentNodeId: initial.nodeId,
          captured: [{ id: second.id, sequence: second.sequence }],
          state: initial.state,
        }),
      ).toThrow(/skipped or mismatched/i);
      expect(
        flowStore.checkpointInput({
          jobId,
          expectedRevision: initial.revision + 1,
          currentNodeId: initial.nodeId,
          captured: [{ id: first.id, sequence: first.sequence }],
          state: initial.state,
        }),
      ).toMatchObject({ status: 'stale' });

      controller.database.exec(
        `CREATE TRIGGER reject_checkpoint BEFORE UPDATE OF state_json ON flow_runs
         WHEN OLD.job_id='${jobId}' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
      );
      expect(() =>
        flowStore.checkpointInput({
          jobId,
          expectedRevision: initial.revision,
          currentNodeId: initial.nodeId,
          captured: [{ id: first.id, sequence: first.sequence }],
          state: initial.state,
        }),
      ).toThrow();
      controller.database.exec('DROP TRIGGER reject_checkpoint');
      expect(flowStore.getPinnedFlowRun(jobId)).toEqual(initial);
      expect(flowStore.getPendingSteering(jobId)).toHaveLength(2);
      expect(controller.statusForJob(USER_ID, jobId)?.appliedSteering).toEqual(
        [],
      );

      const firstCheckpoint = flowStore.checkpointInput({
        jobId,
        expectedRevision: initial.revision,
        currentNodeId: initial.nodeId,
        captured: [{ id: first.id, sequence: first.sequence }],
        state: initial.state,
      });
      expect(firstCheckpoint).toMatchObject({
        status: 'committed',
        run: { revision: 1, transitions: 1 },
      });
      expect(flowStore.getPendingSteering(jobId)).toMatchObject([
        { id: second.id, content: 'second input' },
      ]);
      const checkpointedRun = flowStore.getPinnedFlowRun(jobId);
      if (checkpointedRun === null)
        throw new Error('Expected checkpoint state.');
      const secondCheckpoint = flowStore.checkpointInput({
        jobId,
        expectedRevision: checkpointedRun.revision,
        currentNodeId: checkpointedRun.nodeId,
        captured: [{ id: second.id, sequence: second.sequence }],
        state: checkpointedRun.state,
      });
      expect(secondCheckpoint).toMatchObject({
        status: 'committed',
        run: { revision: 2 },
      });
      expect(flowStore.getPendingSteering(jobId)).toEqual([]);
      expect(controller.statusForJob(USER_ID, jobId)?.appliedSteering).toEqual([
        'first input',
        'second input',
      ]);
      expect(() =>
        flowStore.checkpointInput({
          jobId,
          expectedRevision: 2,
          currentNodeId: checkpointedRun.nodeId,
          captured: [{ id: second.id, sequence: second.sequence }],
          state: checkpointedRun.state,
        }),
      ).toThrow(/no longer pending/i);
    } finally {
      controller.close();
    }
  });

  it('discards an Agent interpretation only through its declared revise edge and persists captured sources', () => {
    const now = 90_000;
    const controller = memoryStore({ now: () => now });
    try {
      const jobId = createJob(controller, 'revise input');
      const flowStore = new FlowStore(controller, registry(), {
        now: () => now,
      });
      expect(
        flowStore.reserveReadyJobs(now, 1).map((job) => job.jobId),
      ).toContain(jobId);
      const initial = flowStore.getPinnedFlowRun(jobId);
      if (initial === null) throw new Error('Expected a pinned Flow run.');
      const state = {
        ...(initial.state as Record<string, unknown>),
        mbtiAssessment: { type: 'ESTJ' },
        mbtiCandidate: {
          answers: [{ questionId: 1, value: 1 }],
          presented: false,
          afterSequence: null,
          sourceMessageIds: [],
        },
        chart: { previous: true },
        interpretation: { summary: 'stale', sections: [] },
      };
      controller.database
        .prepare(
          `UPDATE flow_runs SET flow_id='mbti', node_id='analyze', state_json=? WHERE job_id=?`,
        )
        .run(JSON.stringify(state), jobId);
      const changed = flowStore.getPinnedFlowRun(jobId);
      if (changed === null) throw new Error('Expected revised Agent position.');
      const messageId = controller.transaction(() =>
        controller.steerJob(USER_ID, jobId, 'change my answer', 10, CHAT_ID),
      );
      const pending = flowStore.getPendingSteering(jobId)[0];
      if (pending === undefined) throw new Error('Expected pending steering.');

      const revised = flowStore.discardAgentAndRevise({
        jobId,
        expectedRevision: changed.revision,
        currentNodeId: 'analyze',
        captured: [{ id: pending.id, sequence: pending.sequence }],
        state: changed.state,
      });
      expect(revised).toMatchObject({
        status: 'committed',
        run: {
          flowId: 'mbti',
          nodeId: 'collect',
          revision: changed.revision + 1,
        },
      });
      if (revised.status !== 'committed')
        throw new Error('Expected revise transition.');
      expect(revised.run.state).toMatchObject({
        chart: null,
        interpretation: null,
        mbtiAssessment: null,
        mbtiCandidate: null,
      });
      const revisedState = parseFlowExecutionState(revised.run.state);
      expect(revisedState.inputs).toContainEqual({
        id: messageId,
        sequence: pending.sequence,
        source: 'steering',
        content: 'change my answer',
      });
      expect(flowStore.getPendingSteering(jobId)).toEqual([]);

      const otherJob = createJob(controller, 'no revise edge');
      expect(
        flowStore.reserveReadyJobs(now, 1).map((job) => job.jobId),
      ).toContain(otherJob);
      const otherRun = flowStore.getPinnedFlowRun(otherJob);
      if (otherRun === null) throw new Error('Expected second pinned run.');
      expect(() =>
        flowStore.discardAgentAndRevise({
          jobId: otherJob,
          expectedRevision: otherRun.revision,
          currentNodeId: 'recommend',
          captured: [],
          state: otherRun.state,
        }),
      ).toThrow(/no declared revise transition/i);
    } finally {
      controller.close();
    }
  });
});
