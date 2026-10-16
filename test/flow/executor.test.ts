import { describe, expect, it } from 'vitest';

import { FlowExecutor } from '../../src/flow/executor.js';
import { FlowRegistry } from '../../src/flow/registry.js';
import { FlowStore } from '../../src/flow/store.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import { MBTI_BANK_VERSION, MBTI_QUESTIONS } from '../../src/flow/mbti.js';
import { NATAL_METHOD_VERSION } from '../../src/flow/natal.js';
import { PiCliRpcRuntimeError } from '../../src/flow/pi-rpc-runtime.js';
import type { FlowExecutionState } from '../../src/flow/execution-types.js';
import { parseFlowExecutionState } from '../../src/flow/execution-types.js';
import type { FlowBundle } from '../../src/flow/types.js';
import {
  FakeAgentRuntime,
  FLOW_USER_ID,
  TEST_LIMITS,
  TEST_RUNTIME,
  memoryController,
  queueJob,
  steer,
  testFlowStore,
} from './helpers.js';

const NOW = 10_000;

async function startJob(
  flowStore: FlowStore,
  executor: FlowExecutor,
  jobId: string,
): Promise<void> {
  const reserved = flowStore.reserveReadyJobs(NOW, 1);
  expect(reserved.map((item) => item.jobId)).toContain(jobId);
  await executor.execute(jobId, new AbortController().signal);
}

async function steerAndResume(
  controller: ReturnType<typeof memoryController>,
  flowStore: FlowStore,
  executor: FlowExecutor,
  jobId: string,
  content: string,
): Promise<void> {
  steer(controller, jobId, content);
  const reserved = flowStore.reserveReadyJobs(NOW, 1);
  expect(reserved.map((item) => item.jobId)).toContain(jobId);
  await executor.execute(jobId, new AbortController().signal);
}

function stateFor(flowStore: FlowStore, jobId: string): FlowExecutionState {
  const run = flowStore.getPinnedFlowRun(jobId);
  if (run === null) throw new Error('Expected a pinned Flow run.');
  return parseFlowExecutionState(run.state);
}

function baseBundle(): FlowBundle {
  return createFlowBundle({
    runtimes: {
      intake: TEST_RUNTIME,
      mbti: TEST_RUNTIME,
      natal: TEST_RUNTIME,
    },
    limits: {
      intake: TEST_LIMITS,
      mbti: TEST_LIMITS,
      natal: TEST_LIMITS,
    },
  });
}

function metadataHeavyBundle(): FlowBundle {
  const bundle = baseBundle();
  return {
    ...bundle,
    flows: bundle.flows.map((flow) => ({
      ...flow,
      name: `${flow.name} natal capability metadata`,
      resultDescription: `${flow.resultDescription} natal capability metadata`,
      nodes: flow.nodes.map((node) => ({
        ...node,
        expectedResult: `${node.expectedResult} natal capability metadata`,
      })),
    })),
  };
}

function anonymizeNodeIds(bundle: FlowBundle): FlowBundle {
  const ids = new Map<string, string>();
  for (const flow of bundle.flows) {
    flow.nodes.forEach((node, index) => {
      ids.set(`${flow.id}/${node.id}`, `node_${String(index)}`);
    });
  }
  const renamed = (flowId: string, nodeId: string): string => {
    const result = ids.get(`${flowId}/${nodeId}`);
    if (result === undefined) throw new Error('Missing renamed node ID.');
    return result;
  };
  return {
    ...bundle,
    flows: bundle.flows.map((flow) => ({
      ...flow,
      entryNode: renamed(flow.id, flow.entryNode),
      nodes: flow.nodes.map((node) => ({
        ...node,
        id: renamed(flow.id, node.id),
        next: Object.fromEntries(
          Object.entries(node.next).map(([transition, reference]) => {
            const parts = reference.split('/');
            const targetFlowId = parts.length === 2 ? parts[0] : flow.id;
            const targetNodeId = parts.length === 2 ? parts[1] : reference;
            if (targetFlowId === undefined || targetNodeId === undefined) {
              throw new Error('Invalid test node reference.');
            }
            const nextId = renamed(targetFlowId, targetNodeId);
            return [
              transition,
              parts.length === 2 ? `${targetFlowId}/${nextId}` : nextId,
            ];
          }),
        ),
      })),
    })),
  };
}

function storeForBundle(
  controller: ReturnType<typeof memoryController>,
  bundle: FlowBundle,
): FlowStore {
  return new FlowStore(controller, new FlowRegistry(bundle), {
    now: () => NOW,
  });
}

async function completeMbtiFlow(
  controller: ReturnType<typeof memoryController>,
  flowStore: FlowStore,
  executor: FlowExecutor,
  jobId: string,
): Promise<void> {
  await startJob(flowStore, executor, jobId);
  await steerAndResume(controller, flowStore, executor, jobId, 'mbti');
  for (let batch = 0; batch < 3; batch += 1) {
    const ids = stateFor(flowStore, jobId).askedQuestionIds;
    await steerAndResume(
      controller,
      flowStore,
      executor,
      jobId,
      ids.map((id) => `${String(id)}=2`).join(' '),
    );
    await steerAndResume(controller, flowStore, executor, jobId, '確認本人');
  }
}

describe('FlowExecutor host-controlled execution', () => {
  it('classifies recommendations from explicit request and update text, not capability metadata', async () => {
    const scenarios = [
      {
        request: 'Please help with an MBTI self-reflection.',
        updates: [],
        expected: 'mbti',
      },
      {
        request: 'Please create a natal chart.',
        updates: [],
        expected: 'natal',
      },
      {
        request: 'an unavailable request',
        updates: [],
        expected: null,
      },
      {
        request: 'a supported request',
        updates: ['Please recommend a natal chart.'],
        expected: 'natal',
      },
    ] as const;
    for (const scenario of scenarios) {
      const controller = memoryController(() => NOW);
      try {
        const flowStore = storeForBundle(controller, metadataHeavyBundle());
        const fake = new FakeAgentRuntime();
        const executor = new FlowExecutor(controller, flowStore, fake, {
          now: () => NOW,
        });
        const { jobId } = queueJob(controller, scenario.request);
        for (const update of scenario.updates) steer(controller, jobId, update);

        await startJob(flowStore, executor, jobId);

        const run = flowStore.getPinnedFlowRun(jobId);
        if (run === null) throw new Error('Expected a pinned Flow run.');
        expect(parseFlowExecutionState(run.state).suggestedFlow).toBe(
          scenario.expected,
        );
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]?.input).toContain('natal capability metadata');
        expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
          scenario.expected === null ? 'COMPLETED' : 'WAITING_INPUT',
        );
      } finally {
        controller.close();
      }
    }
  });

  it('persists strict, versioned plain-data host execution state', async () => {
    const controller = memoryController(() => NOW);
    try {
      const { jobId } = queueJob(controller, 'state schema test');
      const flowStore = testFlowStore(controller, () => NOW);
      const executor = new FlowExecutor(
        controller,
        flowStore,
        new FakeAgentRuntime(),
        {
          now: () => NOW,
        },
      );
      await startJob(flowStore, executor, jobId);
      const state = stateFor(flowStore, jobId);
      expect(state.schemaVersion).toBe(1);
      expect(state.birthTimeUnknown).toBe(false);
      expect(() =>
        parseFlowExecutionState({ ...state, schemaVersion: 2 }),
      ).toThrow(/version/i);
      expect(() =>
        parseFlowExecutionState({ ...state, unexpected: true }),
      ).toThrow(/unknown field/i);
      expect(() =>
        parseFlowExecutionState({ ...state, birthTimeUnknown: 'true' }),
      ).toThrow(/birth time flag/i);
    } finally {
      controller.close();
    }
  });

  it('runs intake, three MBTI batches,本人 confirmation, scoring, analysis, and terminal outbox', async () => {
    const controller = memoryController(() => NOW);
    try {
      const { jobId, sessionId } = queueJob(
        controller,
        'Please give me an MBTI self-reflection.',
      );
      const flowStore = testFlowStore(controller, () => NOW);
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });

      await startJob(flowStore, executor, jobId);
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      expect(fake.calls.map((call) => call.node.id)).toEqual(['recommend']);
      expect(fake.calls[0]?.input).toContain('businessFlows');
      expect(fake.calls[0]?.input).toContain('resultDescription');
      expect(fake.calls[0]?.input).toContain('parse_answers');
      expect(fake.calls[0]?.input).toContain('parse_birth');
      expect(fake.calls[0]?.input).not.toContain('"id":"intake"');
      expect(
        controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'prompt')
          .at(-1)?.text,
      ).toContain('建議不會代替你的選擇');

      await steerAndResume(controller, flowStore, executor, jobId, 'mbti');
      const batches: number[][] = [];
      for (let batch = 0; batch < 3; batch += 1) {
        const asked = [...stateFor(flowStore, jobId).askedQuestionIds];
        batches.push(asked);
        expect(asked).toHaveLength(4);
        const response = asked.map((id) => `${String(id)}=2`).join('、');
        await steerAndResume(controller, flowStore, executor, jobId, response);
        expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
          'WAITING_INPUT',
        );
        const candidatePrompt = controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'prompt')
          .at(-1)?.text;
        expect(candidatePrompt).toContain('尚未保存');
        expect(candidatePrompt).toContain('確認本人');
        await steerAndResume(
          controller,
          flowStore,
          executor,
          jobId,
          '確認本人',
        );
      }
      expect(batches).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ]);
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'COMPLETED',
      );
      expect(fake.calls.map((call) => call.node.id)).toEqual([
        'recommend',
        'parse_answers',
        'parse_answers',
        'parse_answers',
        'analyze',
      ]);
      expect(
        fake.calls.every(
          (call) =>
            call.node.kind === 'agent' &&
            (call.node.tools ?? []).length === 0 &&
            call.definition.runtime.provider === 'openai',
        ),
      ).toBe(true);
      const analysisInput = fake.calls.at(-1)?.input;
      expect(analysisInput).toContain('ESTJ');
      expect(analysisInput).toContain('questionId');
      const fact = flowStore.getSessionFact(
        sessionId,
        FLOW_USER_ID,
        'mbti_answers',
      );
      expect(fact).toMatchObject({
        bankVersion: MBTI_BANK_VERSION,
        provenance: 'user_confirmed',
        value: {
          answers: Array.from({ length: 12 }, (_, index) => ({
            questionId: index + 1,
            value: 2,
          })),
        },
      });
      expect(fact?.source).toMatchObject({
        jobId,
        subject: 'self',
        flowVersion: '1.0.0',
        bankVersion: MBTI_BANK_VERSION,
      });
      const terminal = controller
        .dueOutbox(NOW)
        .find((item) => item.jobId === jobId && item.kind === 'completed');
      expect(terminal?.text).toContain('MBTI 自我反思結果：ESTJ');
      expect(terminal?.text).toContain('逐題依據');
      expect(terminal?.text).toContain('不是心理測驗或心理診斷');
      expect(terminal?.text).not.toContain('PRIVATE_TEST_RATIONALE');
      expect(
        fake.calls.every(
          (call) => !call.input.includes('PRIVATE_TEST_RATIONALE'),
        ),
      ).toBe(true);
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.sessionId).toBe(
        sessionId,
      );
    } finally {
      controller.close();
    }
  });

  it('executes renamed MBTI and natal graphs by contract and pinned address', async () => {
    const controller = memoryController(() => NOW);
    try {
      const flowStore = storeForBundle(
        controller,
        anonymizeNodeIds(baseBundle()),
      );
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      const mbti = queueJob(controller, 'MBTI self-reflection');

      await completeMbtiFlow(controller, flowStore, executor, mbti.jobId);
      expect(controller.statusForJob(FLOW_USER_ID, mbti.jobId)?.status).toBe(
        'COMPLETED',
      );
      expect(fake.calls.map((call) => call.node.resultContract)).toEqual([
        'recommendation',
        'mbti_answers',
        'mbti_answers',
        'mbti_answers',
        'interpretation',
      ]);

      const natal = queueJob(
        controller,
        'Create a natal chart: date=2000-01-01 time=12:00 city=Taipei',
        { name: 'renamed-natal', chatId: '818181' },
      );
      await startJob(flowStore, executor, natal.jobId);
      await steerAndResume(
        controller,
        flowStore,
        executor,
        natal.jobId,
        'natal',
      );
      expect(controller.statusForJob(FLOW_USER_ID, natal.jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      await steerAndResume(
        controller,
        flowStore,
        executor,
        natal.jobId,
        'lat=25.03 lon=121.56 zone=Asia/Taipei',
      );
      expect(controller.statusForJob(FLOW_USER_ID, natal.jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      await steerAndResume(
        controller,
        flowStore,
        executor,
        natal.jobId,
        '確認本人',
      );
      expect(controller.statusForJob(FLOW_USER_ID, natal.jobId)?.status).toBe(
        'COMPLETED',
      );
      expect(
        fake.calls
          .filter((call) => call.jobId === natal.jobId)
          .map((call) => call.node.resultContract),
      ).toEqual([
        'recommendation',
        'birth_input',
        'birth_input',
        'interpretation',
      ]);
      expect(fake.calls.every((call) => /^node_\d+$/.test(call.node.id))).toBe(
        true,
      );
    } finally {
      controller.close();
    }
  });

  it('uses the renamed analysis node declared revise edge for steering', async () => {
    const controller = memoryController(() => NOW);
    let releaseAnalyze: (() => void) | undefined;
    let analyzeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      analyzeStarted = resolve;
    });
    const gated = new Promise<void>((resolve) => {
      releaseAnalyze = resolve;
    });
    let gatedOnce = false;
    const fake = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (input.node.resultContract === 'interpretation' && !gatedOnce) {
          gatedOnce = true;
          analyzeStarted?.();
          await gated;
        }
      },
    });
    try {
      const bundle = anonymizeNodeIds(baseBundle());
      const flowStore = storeForBundle(controller, bundle);
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      const { jobId } = queueJob(controller, 'MBTI analysis for me');
      await startJob(flowStore, executor, jobId);
      await steerAndResume(controller, flowStore, executor, jobId, 'mbti');
      for (let batch = 0; batch < 2; batch += 1) {
        const ids = stateFor(flowStore, jobId).askedQuestionIds;
        steer(controller, jobId, ids.map((id) => `${String(id)}=2`).join(' '));
        expect(
          flowStore.reserveReadyJobs(NOW, 1).map((item) => item.jobId),
        ).toContain(jobId);
        await executor.execute(jobId, new AbortController().signal);
        await steerAndResume(
          controller,
          flowStore,
          executor,
          jobId,
          '確認本人',
        );
      }
      const finalIds = stateFor(flowStore, jobId).askedQuestionIds;
      steer(
        controller,
        jobId,
        finalIds.map((id) => `${String(id)}=2`).join(' '),
      );
      expect(
        flowStore.reserveReadyJobs(NOW, 1).map((item) => item.jobId),
      ).toContain(jobId);
      await executor.execute(jobId, new AbortController().signal);
      const mbtiFlow = bundle.flows.find((flow) => flow.id === 'mbti');
      const scoreNode = mbtiFlow?.nodes.find(
        (node) => node.handler === 'mbti_score',
      );
      expect(flowStore.getPinnedFlowRun(jobId)?.nodeId).toBe(scoreNode?.id);
      steer(controller, jobId, '確認本人');
      expect(
        flowStore.reserveReadyJobs(NOW, 1).map((item) => item.jobId),
      ).toContain(jobId);
      const running = executor.execute(jobId, new AbortController().signal);
      await started;
      steer(controller, jobId, 'Please correct my answers.');
      releaseAnalyze?.();
      await running;

      const run = flowStore.getPinnedFlowRun(jobId);
      const collectNode = mbtiFlow?.nodes.find(
        (node) => node.handler === 'mbti_collect',
      );
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      expect(run?.nodeId).toBe(collectNode?.id);
      expect(parseFlowExecutionState(run?.state).interpretation).toBeNull();
      expect(
        controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'completed'),
      ).toHaveLength(0);
    } finally {
      releaseAnalyze?.();
      controller.close();
    }
  });

  it('rejects a wrong declared terminal handler instead of inferring completion from state', async () => {
    const controller = memoryController(() => NOW);
    try {
      const bundle = baseBundle();
      const wrongHandler: FlowBundle = {
        ...bundle,
        flows: bundle.flows.map((flow) => ({
          ...flow,
          nodes: flow.nodes.map((node) =>
            node.handler === 'mbti_done'
              ? { ...node, handler: 'natal_done' }
              : node,
          ),
        })),
      };
      const renamed = anonymizeNodeIds(wrongHandler);
      const flowStore = storeForBundle(controller, renamed);
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      const { jobId } = queueJob(controller, 'MBTI self-reflection');

      await completeMbtiFlow(controller, flowStore, executor, jobId);

      expect(controller.statusForJob(FLOW_USER_ID, jobId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'FLOW_RESULT_INVALID',
      });
      expect(
        controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'completed'),
      ).toHaveLength(0);
      const run = flowStore.getPinnedFlowRun(jobId);
      const mbti = renamed.flows.find((flow) => flow.id === 'mbti');
      const analysis = mbti?.nodes.find(
        (node) => node.resultContract === 'interpretation',
      );
      expect(run?.nodeId).toBe(analysis?.id);
    } finally {
      controller.close();
    }
  });

  it.each([
    'FLOW_AUTH_SOURCE_MISSING',
    'FLOW_AUTH_SOURCE_INVALID',
    'FLOW_AUTH_LOGIN_REQUIRED',
    'FLOW_AUTH_REFRESH_FAILED',
    'FLOW_AUTH_SNAPSHOT_INVALID',
  ] as const)(
    'persists safe authentication code %s without source or provider details',
    async (code) => {
      const controller = memoryController(() => NOW);
      const rawSource = '/synthetic/private/auth-source.json';
      const rawProviderError = 'synthetic-provider-response-do-not-expose';
      try {
        const { jobId } = queueJob(controller, 'authentication failure');
        const flowStore = testFlowStore(controller, () => NOW);
        const runtimeError = new PiCliRpcRuntimeError(code);
        Object.defineProperty(runtimeError, 'cause', {
          value: new Error(`${rawProviderError}: ${rawSource}`),
        });
        const fake = new FakeAgentRuntime({
          responder: () => {
            throw runtimeError;
          },
        });
        const executor = new FlowExecutor(controller, flowStore, fake, {
          now: () => NOW,
        });

        await startJob(flowStore, executor, jobId);

        const status = controller.statusForJob(FLOW_USER_ID, jobId);
        expect(status).toMatchObject({ status: 'FAILED', failureCode: code });
        const failure = controller
          .dueOutbox(NOW)
          .find((item) => item.jobId === jobId && item.kind === 'failed');
        expect(failure?.text).toContain(code);
        expect(failure?.text).not.toContain(rawSource);
        expect(failure?.text).not.toContain(rawProviderError);
        expect(JSON.stringify(status)).not.toContain(rawSource);
        expect(JSON.stringify(status)).not.toContain(rawProviderError);
      } finally {
        controller.close();
      }
    },
  );

  it('retries only an explicit failed model request and never retries an ambiguous child exit', async () => {
    for (const scenario of [
      {
        failureCode: 'FLOW_MODEL_REQUEST_FAILED',
        maxRetries: 1,
        expectedCalls: 2,
        expectedStatus: 'COMPLETED',
      },
      {
        failureCode: 'FLOW_MODEL_REQUEST_FAILED',
        maxRetries: 0,
        expectedCalls: 1,
        expectedStatus: 'FAILED',
      },
      {
        failureCode: 'FLOW_RPC_CHILD_EXITED',
        maxRetries: 2,
        expectedCalls: 1,
        expectedStatus: 'FAILED',
      },
    ] as const) {
      const controller = memoryController(() => NOW);
      try {
        const { jobId } = queueJob(controller, 'retry test');
        const flowStore = testFlowStore(controller, () => NOW, {
          ...TEST_LIMITS,
          maxRetries: scenario.maxRetries,
        });
        let calls = 0;
        const fake = new FakeAgentRuntime({
          responder: () => {
            calls += 1;
            if (calls === 1) {
              throw new PiCliRpcRuntimeError(scenario.failureCode);
            }
            return {
              transition: 'ready',
              result: { suggestedFlow: null },
              text: 'PRIVATE_TEST_RATIONALE',
            };
          },
        });
        const executor = new FlowExecutor(controller, flowStore, fake, {
          now: () => NOW,
        });

        await startJob(flowStore, executor, jobId);
        expect(fake.calls).toHaveLength(scenario.expectedCalls);
        expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
          scenario.expectedStatus,
        );
        if (scenario.expectedStatus === 'FAILED') {
          expect(
            controller.statusForJob(FLOW_USER_ID, jobId)?.failureCode,
          ).toBe(scenario.failureCode);
          const failure = controller
            .dueOutbox(NOW)
            .find((item) => item.jobId === jobId && item.kind === 'failed');
          expect(failure?.text).not.toContain('PRIVATE_PROVIDER_ERROR');
        }
      } finally {
        controller.close();
      }
    }
  });

  it('terminates a null recommendation without listing choices and still requires an explicit non-null choice', async () => {
    const controller = memoryController(() => NOW);
    try {
      const unsupported = queueJob(controller, 'an unavailable request');
      const flowStore = testFlowStore(controller, () => NOW);
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      await startJob(flowStore, executor, unsupported.jobId);
      expect(fake.calls.map((call) => call.node.id)).toEqual(['recommend']);
      expect(
        controller.statusForJob(FLOW_USER_ID, unsupported.jobId)?.status,
      ).toBe('COMPLETED');
      const unsupportedResult = controller
        .dueOutbox(NOW)
        .find(
          (item) =>
            item.jobId === unsupported.jobId && item.kind === 'completed',
        );
      expect(unsupportedResult?.text).toContain('目前沒有符合目標的已註冊能力');
      expect(unsupportedResult?.text).toContain('請縮小目標');
      expect(unsupportedResult?.text).not.toContain('MBTI');
      expect(unsupportedResult?.text).not.toContain('出生星盤');
      expect(
        controller
          .dueOutbox(NOW)
          .filter(
            (item) =>
              item.jobId === unsupported.jobId && item.kind === 'prompt',
          ),
      ).toHaveLength(0);

      const selected = queueJob(controller, 'a supported request');
      await startJob(flowStore, executor, selected.jobId);
      expect(
        controller.statusForJob(FLOW_USER_ID, selected.jobId)?.status,
      ).toBe('WAITING_INPUT');
      await steerAndResume(
        controller,
        flowStore,
        executor,
        selected.jobId,
        'random choice',
      );
      expect(
        controller.statusForJob(FLOW_USER_ID, selected.jobId)?.status,
      ).toBe('WAITING_INPUT');
      expect(
        controller
          .dueOutbox(NOW)
          .filter(
            (item) => item.jobId === selected.jobId && item.kind === 'prompt',
          )
          .at(-1)?.text,
      ).toContain('無法確認你的明確選擇');
      await steerAndResume(
        controller,
        flowStore,
        executor,
        selected.jobId,
        'unsupported',
      );
      expect(
        controller.statusForJob(FLOW_USER_ID, selected.jobId)?.status,
      ).toBe('COMPLETED');
      expect(fake.calls.map((call) => call.node.id)).toEqual([
        'recommend',
        'recommend',
      ]);
      const completed = controller
        .dueOutbox(NOW)
        .find(
          (item) => item.jobId === selected.jobId && item.kind === 'completed',
        );
      expect(completed?.text).toContain('目前沒有符合目標的已註冊能力');
      expect(completed?.text).not.toContain('PRIVATE_TEST_RATIONALE');
    } finally {
      controller.close();
    }
  });

  it('reuses only matching本人 facts in the same Session and asks explicit correction before replacing conflicts', async () => {
    const controller = memoryController(() => NOW);
    try {
      const answers = MBTI_QUESTIONS.map((question) => ({
        questionId: question.id,
        value: 2 as const,
      }));
      const first = queueJob(controller, 'first job');
      const flowStore = testFlowStore(controller, () => NOW);
      flowStore.saveSessionFact(first.sessionId, FLOW_USER_ID, {
        kind: 'mbti_answers',
        value: { bankVersion: MBTI_BANK_VERSION, answers },
        source: {
          jobId: 'prior-job',
          queuedMessageIds: ['queued-prior'],
          steeringMessageIds: [],
          confirmationMessageIds: ['confirmed-prior'],
          subject: 'self',
          flowVersion: '1.0.0',
          bankVersion: MBTI_BANK_VERSION,
        },
        flowVersion: '1.0.0',
        bankVersion: MBTI_BANK_VERSION,
        confirmed: true,
      });
      flowStore.saveSessionFact(first.sessionId, FLOW_USER_ID, {
        kind: 'natal_birth',
        value: {
          localDate: '2000-01-01',
          localTime: '12:00',
          latitude: 0,
          longitude: 0,
          timeZone: 'UTC',
        },
        source: {
          jobId: 'prior-natal-job',
          queuedMessageIds: ['natal-queued'],
          steeringMessageIds: [],
          confirmationMessageIds: ['natal-confirmed'],
          subject: 'self',
          flowVersion: '1.0.0',
          bankVersion: NATAL_METHOD_VERSION,
        },
        flowVersion: '1.0.0',
        bankVersion: NATAL_METHOD_VERSION,
        confirmed: true,
      });
      expect(
        flowStore.getSessionFact(
          first.sessionId,
          'other-owner',
          'mbti_answers',
        ),
      ).toBeNull();
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      await startJob(flowStore, executor, first.jobId);
      await steerAndResume(
        controller,
        flowStore,
        executor,
        first.jobId,
        'mbti',
      );
      expect(controller.statusForJob(FLOW_USER_ID, first.jobId)?.status).toBe(
        'COMPLETED',
      );
      expect(fake.calls.map((call) => call.node.id)).toContain('analyze');
      expect(fake.calls[0]?.historyFacts).toEqual([]);
      const mbtiAnalysis = fake.calls.find(
        (call) => call.node.id === 'analyze',
      );
      expect(mbtiAnalysis?.historyFacts).toHaveLength(1);
      expect(JSON.stringify(mbtiAnalysis?.historyFacts)).toContain(
        MBTI_BANK_VERSION,
      );
      expect(JSON.stringify(mbtiAnalysis?.historyFacts)).not.toContain(
        'localDate',
      );
      expect(
        controller
          .dueOutbox(NOW)
          .filter(
            (item) => item.jobId === first.jobId && item.kind === 'prompt',
          )
          .some((item) => item.text.includes('原創生活偏好題')),
      ).toBe(false);

      const other = queueJob(controller, 'other session job', {
        name: 'other-session',
        chatId: '616161',
      });
      await startJob(flowStore, executor, other.jobId);
      await steerAndResume(
        controller,
        flowStore,
        executor,
        other.jobId,
        'mbti',
      );
      expect(stateFor(flowStore, other.jobId).askedQuestionIds).toEqual([
        1, 2, 3, 4,
      ]);
      expect(
        controller
          .dueOutbox(NOW)
          .filter(
            (item) => item.jobId === other.jobId && item.kind === 'prompt',
          )
          .at(-1)?.text,
      ).toContain('原創生活偏好題');

      const conflictSession = queueJob(controller, 'conflict job', {
        name: 'conflict-session',
        chatId: '717171',
      });
      flowStore.saveSessionFact(conflictSession.sessionId, FLOW_USER_ID, {
        kind: 'mbti_answers',
        value: {
          bankVersion: MBTI_BANK_VERSION,
          answers: [{ questionId: 1, value: 2 }],
        },
        source: {
          jobId: 'history-job',
          queuedMessageIds: ['old-queued'],
          steeringMessageIds: [],
          confirmationMessageIds: ['old-confirm'],
          subject: 'self',
          flowVersion: '1.0.0',
          bankVersion: MBTI_BANK_VERSION,
        },
        flowVersion: '1.0.0',
        bankVersion: MBTI_BANK_VERSION,
        confirmed: true,
      });
      await startJob(flowStore, executor, conflictSession.jobId);
      await steerAndResume(
        controller,
        flowStore,
        executor,
        conflictSession.jobId,
        'mbti',
      );
      expect(
        stateFor(flowStore, conflictSession.jobId).askedQuestionIds,
      ).toEqual([2, 3, 4, 5]);
      await steerAndResume(
        controller,
        flowStore,
        executor,
        conflictSession.jobId,
        '更正 1=-2',
      );
      const conflictPrompt = controller
        .dueOutbox(NOW)
        .filter(
          (item) =>
            item.jobId === conflictSession.jobId && item.kind === 'prompt',
        )
        .at(-1)?.text;
      expect(conflictPrompt).toContain('已確認 2');
      expect(conflictPrompt).toContain('候選 -2');
      await steerAndResume(
        controller,
        flowStore,
        executor,
        conflictSession.jobId,
        '確認本人',
      );
      expect(
        flowStore.getSessionFact(
          conflictSession.sessionId,
          FLOW_USER_ID,
          'mbti_answers',
        )?.value,
      ).toMatchObject({
        answers: [{ questionId: 1, value: -2 }],
      });
    } finally {
      controller.close();
    }
  });

  it('parses natal data only after selection, asks for missing coordinates, confirms, and renders the offline chart', async () => {
    const controller = memoryController(() => NOW);
    try {
      const { jobId, sessionId } = queueJob(
        controller,
        'Create a natal chart for me: date=2000-01-01 time=12:00 city=Taipei',
      );
      const flowStore = testFlowStore(controller, () => NOW);
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      await startJob(flowStore, executor, jobId);
      expect(fake.calls.map((call) => call.node.id)).toEqual(['recommend']);
      await steerAndResume(controller, flowStore, executor, jobId, 'natal');
      expect(fake.calls.map((call) => call.node.id)).toEqual([
        'recommend',
        'parse_birth',
      ]);
      const missing = controller
        .dueOutbox(NOW)
        .filter((item) => item.jobId === jobId && item.kind === 'prompt')
        .at(-1)?.text;
      expect(missing).toContain('緯度');
      expect(missing).toContain('經度');
      expect(missing).toContain('IANA 時區');
      expect(missing).toContain('不會查詢地名');

      await steerAndResume(
        controller,
        flowStore,
        executor,
        jobId,
        'lat=25.03 lon=121.56 zone=Asia/Taipei',
      );
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      expect(
        fake.calls.filter((call) => call.node.id === 'analyze'),
      ).toHaveLength(0);
      const confirmation = controller
        .dueOutbox(NOW)
        .filter((item) => item.jobId === jobId && item.kind === 'prompt')
        .at(-1)?.text;
      expect(confirmation).toContain('2000-01-01');
      expect(confirmation).toContain('確認本人');
      expect(
        flowStore.getSessionFact(sessionId, FLOW_USER_ID, 'natal_birth'),
      ).toBeNull();

      await steerAndResume(controller, flowStore, executor, jobId, '確認本人');
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'COMPLETED',
      );
      const fact = flowStore.getSessionFact(
        sessionId,
        FLOW_USER_ID,
        'natal_birth',
      );
      expect(fact).toMatchObject({
        bankVersion: NATAL_METHOD_VERSION,
        provenance: 'user_confirmed',
        source: { subject: 'self', bankVersion: NATAL_METHOD_VERSION },
      });
      const result = controller
        .dueOutbox(NOW)
        .find((item) => item.jobId === jobId && item.kind === 'completed');
      expect(result?.text).toContain('UTC：2000-01-01T04:00:00.000Z');
      expect(result?.text).toContain('Sun:');
      expect(result?.text).toContain('Mercury:');
      expect(result?.text).toContain('Ascendant：');
      expect(result?.text).toContain('MC：');
      expect(result?.text).toContain('十二宮 cusp');
      expect(result?.text).toContain('主要相位');
      expect(result?.text).toContain('娛樂與自我反思');
      expect(result?.text).not.toContain('PRIVATE_TEST_RATIONALE');
      expect(
        fake.calls.every((call) => (call.node.tools ?? []).length === 0),
      ).toBe(true);
      expect(
        fake.calls.find((call) => call.node.id === 'parse_birth')?.node
          .resultContract,
      ).toBe('birth_input');
    } finally {
      controller.close();
    }
  });

  it('does not reuse a confirmed birth time when the user says it is unknown', async () => {
    const controller = memoryController(() => NOW);
    try {
      const { jobId, sessionId } = queueJob(
        controller,
        'Create my natal chart: date=2000-01-01 birth time unknown',
      );
      const flowStore = testFlowStore(controller, () => NOW);
      const previousBirth = {
        localDate: '2000-01-01',
        localTime: '12:00',
        latitude: 0,
        longitude: 0,
        timeZone: 'UTC',
      };
      flowStore.saveSessionFact(sessionId, FLOW_USER_ID, {
        kind: 'natal_birth',
        value: previousBirth,
        source: {
          jobId: 'prior-birth-job',
          queuedMessageIds: ['prior-queued'],
          steeringMessageIds: [],
          confirmationMessageIds: ['prior-confirmation'],
          subject: 'self',
          flowVersion: '1.0.0',
          bankVersion: NATAL_METHOD_VERSION,
        },
        flowVersion: '1.0.0',
        bankVersion: NATAL_METHOD_VERSION,
        confirmed: true,
      });
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });

      await startJob(flowStore, executor, jobId);
      await steerAndResume(controller, flowStore, executor, jobId, 'natal');
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      expect(stateFor(flowStore, jobId).birthTimeUnknown).toBe(true);
      expect(fake.calls.map((call) => call.node.id)).toEqual([
        'recommend',
        'parse_birth',
      ]);
      expect(
        controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'prompt')
          .at(-1)?.text,
      ).toContain('出生當地時間');
      expect(fake.calls.some((call) => call.node.id === 'analyze')).toBe(false);

      await steerAndResume(
        controller,
        flowStore,
        executor,
        jobId,
        'time=10:30',
      );
      expect(stateFor(flowStore, jobId).birthTimeUnknown).toBe(false);
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'WAITING_INPUT',
      );
      const candidate = controller
        .dueOutbox(NOW)
        .filter((item) => item.jobId === jobId && item.kind === 'prompt')
        .at(-1)?.text;
      expect(candidate).toContain('出生當地時間：10:30');
      expect(candidate).toContain('已確認資料與本次候選不同。');
      expect(fake.calls.some((call) => call.node.id === 'analyze')).toBe(false);

      await steerAndResume(controller, flowStore, executor, jobId, '確認本人');
      expect(controller.statusForJob(FLOW_USER_ID, jobId)?.status).toBe(
        'COMPLETED',
      );
      expect(
        flowStore.getSessionFact(sessionId, FLOW_USER_ID, 'natal_birth')?.value,
      ).toMatchObject({
        localTime: '10:30',
      });
    } finally {
      controller.close();
    }
  });

  it('discards stale interpretation when steering arrives during analysis and never commits the old terminal result', async () => {
    const controller = memoryController(() => NOW);
    let releaseAnalyze: (() => void) | undefined;
    let analyzeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      analyzeStarted = resolve;
    });
    const gated = new Promise<void>((resolve) => {
      releaseAnalyze = resolve;
    });
    const fake = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (input.node.id === 'analyze') {
          analyzeStarted?.();
          await gated;
        }
      },
    });
    try {
      const { jobId } = queueJob(controller, 'MBTI analysis for me');
      const flowStore = testFlowStore(controller, () => NOW);
      const executor = new FlowExecutor(controller, flowStore, fake, {
        now: () => NOW,
      });
      await startJob(flowStore, executor, jobId);
      await steerAndResume(controller, flowStore, executor, jobId, 'mbti');
      for (let batch = 0; batch < 2; batch += 1) {
        const ids = stateFor(flowStore, jobId).askedQuestionIds;
        steer(controller, jobId, ids.map((id) => `${String(id)}=2`).join(' '));
        const reserved = flowStore.reserveReadyJobs(NOW, 1);
        expect(reserved.map((item) => item.jobId)).toContain(jobId);
        await executor.execute(jobId, new AbortController().signal);
        await steerAndResume(
          controller,
          flowStore,
          executor,
          jobId,
          '確認本人',
        );
      }
      const finalIds = stateFor(flowStore, jobId).askedQuestionIds;
      steer(
        controller,
        jobId,
        finalIds.map((id) => `${String(id)}=2`).join(' '),
      );
      expect(
        flowStore.reserveReadyJobs(NOW, 1).map((item) => item.jobId),
      ).toContain(jobId);
      await executor.execute(jobId, new AbortController().signal);
      const candidateRun = flowStore.getPinnedFlowRun(jobId);
      expect(candidateRun?.nodeId).toBe('score');
      steer(controller, jobId, '確認本人');
      expect(
        flowStore.reserveReadyJobs(NOW, 1).map((item) => item.jobId),
      ).toContain(jobId);
      const running = executor.execute(jobId, new AbortController().signal);
      await started;
      steer(controller, jobId, 'Please correct my answers.');
      releaseAnalyze?.();
      await running;
      const status = controller.statusForJob(FLOW_USER_ID, jobId);
      expect(status?.status).toBe('WAITING_INPUT');
      expect(
        controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'completed'),
      ).toHaveLength(0);
      const revised = flowStore.getPinnedFlowRun(jobId);
      expect(revised?.nodeId).toBe('collect');
      expect(parseFlowExecutionState(revised?.state).interpretation).toBeNull();
      expect(parseFlowExecutionState(revised?.state).chart).toBeNull();
    } finally {
      releaseAnalyze?.();
      controller.close();
    }
  });

  it('rejects invalid Agent transitions and result payloads as stable failures without raw errors', async () => {
    for (const response of [
      { transition: 'unknown', result: { suggestedFlow: 'mbti' } },
      { transition: 'ready', result: { suggestedFlow: 'not-registered' } },
      {
        transition: 'ready',
        result: { suggestedFlow: 'mbti', rationale: 'raw' },
      },
    ]) {
      const controller = memoryController(() => NOW);
      try {
        const { jobId } = queueJob(controller, 'request');
        const flowStore = testFlowStore(controller, () => NOW);
        const fake = new FakeAgentRuntime({ responder: () => response });
        const executor = new FlowExecutor(controller, flowStore, fake, {
          now: () => NOW,
        });
        await startJob(flowStore, executor, jobId);
        expect(controller.statusForJob(FLOW_USER_ID, jobId)).toMatchObject({
          status: 'FAILED',
          failureCode: 'FLOW_RESULT_INVALID',
        });
        const errors = controller
          .dueOutbox(NOW)
          .filter((item) => item.jobId === jobId && item.kind === 'failed');
        expect(errors[0]?.text).toContain('FLOW_RESULT_INVALID');
        expect(errors[0]?.text).not.toContain('raw');
      } finally {
        controller.close();
      }
    }
  });

  it('uses only the current declared natal calculation tool and fails closed when the declaration is missing', async () => {
    const noToolsBundle = createFlowBundle({
      runtimes: {
        intake: TEST_RUNTIME,
        mbti: TEST_RUNTIME,
        natal: TEST_RUNTIME,
      },
      limits: {
        intake: TEST_LIMITS,
        mbti: TEST_LIMITS,
        natal: { ...TEST_LIMITS, maxToolCalls: 0 },
      },
    });
    const noTools = structuredClone(noToolsBundle) as unknown as {
      flows: { id: string; nodes: { id: string; tools?: string[] }[] }[];
      schemaVersion: 1;
    };
    const natal = noTools.flows.find((flow) => flow.id === 'natal');
    const calculate = natal?.nodes.find((node) => node.id === 'calculate');
    if (calculate === undefined)
      throw new Error('Expected natal calculate Node.');
    calculate.tools = [];
    const noToolController = memoryController(() => NOW);
    try {
      const { jobId } = queueJob(noToolController, 'test');
      const store = new FlowStore(noToolController, new FlowRegistry(noTools), {
        now: () => NOW,
      });
      const initial = store.reserveReadyJobs(NOW, 1);
      expect(initial.map((item) => item.jobId)).toContain(jobId);
      const run = store.getPinnedFlowRun(jobId);
      if (run === null) throw new Error('Expected pinned run.');
      const state = parseFlowExecutionState(run.state);
      const natalFlow = run.bundle.flows.find((flow) => flow.id === 'natal');
      if (natalFlow === undefined)
        throw new Error('Expected pinned natal Flow.');
      noToolController.database
        .prepare(
          `UPDATE flow_runs SET flow_id='natal', node_id='calculate',
             state_json=?, revision=revision+1 WHERE job_id=?`,
        )
        .run(
          JSON.stringify({
            ...state,
            selectedFlow: 'natal',
            sources: { ...state.sources, subject: 'self' },
            natalConfirmed: {
              localDate: '2000-01-01',
              localTime: '12:00',
              latitude: 0,
              longitude: 0,
              timeZone: 'UTC',
            },
          }),
          jobId,
        );
      const fake = new FakeAgentRuntime();
      const executor = new FlowExecutor(noToolController, store, fake, {
        now: () => NOW,
      });
      await executor.execute(jobId, new AbortController().signal);
      expect(noToolController.statusForJob(FLOW_USER_ID, jobId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'FLOW_TOOL_UNAVAILABLE',
      });
    } finally {
      noToolController.close();
    }
  });
});
