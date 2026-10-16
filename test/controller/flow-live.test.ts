import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluateMbtiAnswers, MBTI_DISCLAIMER } from '../../src/flow/mbti.js';
import { NATAL_DISCLAIMER } from '../../src/flow/presentation.js';
import { calculateNatalChart } from '../../src/flow/natal.js';
import { parseFlowExecutionState } from '../../src/flow/execution-types.js';
import {
  createLiveHarness,
  liveGateEnabled,
  LiveHarnessError,
  MAX_SCENARIO_MS,
  MAX_STAGE_MS,
  pathExists,
  savePrivateJson,
  safeRuntimeCode,
  waitForStage,
} from './flow-live-harness.js';
import type { LiveHarness, SyntheticMessage } from './flow-live-harness.js';

const LIVE_ENABLED = liveGateEnabled(process.env);
const SYNTHETIC_ANSWERS = Array.from({ length: 12 }, (_, index) => ({
  questionId: index + 1,
  value: index === 1 ? 0 : 2,
}));
const NATAL_INPUT = {
  localDate: '2000-01-01',
  localTime: '12:00',
  latitude: 25.03,
  longitude: 121.56,
  timeZone: 'Asia/Taipei',
} as const;

function flowRecord(
  harness: LiveHarness,
  name: string,
): Record<string, unknown> {
  const flows = harness.report['flows'] as Record<string, unknown>[];
  let flow = flows.find((item) => item['name'] === name);
  if (flow === undefined) {
    flow = {
      name,
      stage: 'not-started',
      sessionId: null,
      jobId: null,
      status: 'not-run',
      checks: Object.fromEntries(
        [
          'session-created',
          'job-completed',
          'result-delivered',
          'facts-confirmed',
          'assessment-recomputed',
          'interpretation-present',
          'prompts-closed',
          'session-isolated',
          'model-runtime-real',
        ].map((key) => [key, 'not-verified']),
      ),
    };
    flows.push(flow);
  }
  return flow;
}

function setStage(harness: LiveHarness, name: string, stage: string): void {
  flowRecord(harness, name)['stage'] = stage;
  harness.report['activeFlow'] = name;
  harness.report['activeStage'] = stage;
}

function check(
  harness: LiveHarness,
  name: string,
  field: string,
  passed: boolean,
): void {
  const flow = flowRecord(harness, name);
  const checks = flow['checks'] as Record<string, string>;
  checks[field] = passed ? 'pass' : 'fail';
  expect(passed, `${name}: ${field}`).toBe(true);
}

function sentForJob(
  harness: LiveHarness,
  jobId: string,
  kind?: string,
): SyntheticMessage[] {
  return harness.telegram.sent.filter(
    (message) =>
      message.text.includes(`Job ${jobId}`) &&
      (kind === undefined || message.kind === kind),
  );
}

async function stageWait<T>(
  harness: LiveHarness,
  flow: string,
  stage: string,
  predicate: () => T | null | undefined | false,
): Promise<T> {
  setStage(harness, flow, stage);
  const remaining = MAX_SCENARIO_MS - (performance.now() - scenarioStarted);
  if (remaining <= 0) throw new LiveHarnessError('LIVE_STAGE_TIMEOUT', stage);
  return await waitForStage(stage, predicate, {
    maxMs: Math.min(MAX_STAGE_MS, remaining),
    failed: () => {
      const record = flowRecord(harness, flow);
      const jobId = record['jobId'];
      if (typeof jobId === 'string') {
        const status = harness.resources.store.statusForJob('424242', jobId);
        if (status?.status === 'FAILED') {
          record['status'] = 'FAILED';
          record['safeFailureCode'] = status.failureCode ?? 'JOB_FAILED';
          return true;
        }
      }
      return harness.runtime.budgetExceeded;
    },
  });
}

let scenarioStarted = 0;

describe('gated live Pi model MBTI and natal self-test', () => {
  afterEach(() => {
    scenarioStarted = 0;
  });

  it.skipIf(!LIVE_ENABLED)(
    'runs both synthetic sessions against the configured real Pi model',
    async () => {
      scenarioStarted = performance.now();
      const authFile = process.env['PI_FLOW_LIVE_AUTH_FILE'];
      if (
        authFile === undefined ||
        authFile.trim().length === 0 ||
        !resolve(authFile).startsWith('/')
      ) {
        throw new LiveHarnessError('AUTH_PATH_REQUIRED', 'gate');
      }
      const maxAgentNodes = process.env['PI_FLOW_LIVE_MAX_AGENT_NODES'];
      const artifactRoot = process.env['PI_FLOW_LIVE_ARTIFACT_ROOT'];
      const harness = await createLiveHarness({
        authFile,
        ...(maxAgentNodes === undefined ? {} : { maxAgentNodes }),
        ...(artifactRoot === undefined ? {} : { artifactRoot }),
      });
      const mbti = flowRecord(harness, 'mbti-test');
      const natal = flowRecord(harness, 'natal-test');
      let cleanupFailure: string | undefined;
      try {
        harness.start();
        await stageWait(harness, 'mbti-test', 'wait-ready', () =>
          harness.telegram.sent.find((message) => message.kind === 'ready'),
        );
        harness.telegram.push('/new mbti-test');
        const session = await stageWait(
          harness,
          'mbti-test',
          'create-session',
          () => harness.resources.store.selectedSession('424242', '515151'),
        );
        mbti['sessionId'] = session.id;
        check(
          harness,
          'mbti-test',
          'session-created',
          session.name === 'mbti-test',
        );
        harness.telegram.push('/queue 幫我用原創問題推估 MBTI');
        const queued = await stageWait(
          harness,
          'mbti-test',
          'queue-job',
          () => {
            const row = harness.resources.store.database
              .prepare('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1')
              .get() as { id?: string } | undefined;
            return row?.id;
          },
        );
        mbti['jobId'] = queued;
        const flowChoice = await stageWait(
          harness,
          'mbti-test',
          'wait-flow-choice',
          () => sentForJob(harness, queued, 'flow-choice')[0],
        );
        const initialState = harness.flowStore.getPinnedFlowRun(queued);
        if (initialState === null)
          throw new LiveHarnessError(
            'LIVE_ASSERTION_FAILED',
            'mbti-pinned-run',
          );
        const recommendation = initialState.bundle.flows.find(
          (flow) => flow.id === 'intake',
        )?.runtime;
        expect(recommendation).toMatchObject({
          provider: 'openai',
          model: 'gpt-6-luna',
          thinking: 'max',
        });
        harness.telegram.push('mbti', flowChoice.messageId);

        const seenQuestionIds = new Set<number>();
        let questionSentCursor = harness.telegram.sent.length;
        for (let batch = 0; batch < 3; batch += 1) {
          const questionMessage = await stageWait(
            harness,
            'mbti-test',
            `mbti-questions-${String(batch + 1)}`,
            () => {
              const fact = harness.flowStore.getSessionFact(
                session.id,
                '424242',
                'mbti_answers',
              );
              const answers =
                (
                  fact?.value as
                    { answers?: { questionId: number }[] } | undefined
                )?.answers ?? [];
              if (answers.length !== batch * 4) return null;
              return harness.telegram.sent
                .slice(questionSentCursor)
                .find(
                  (message) =>
                    message.text.includes(`Job ${queued}`) &&
                    message.kind === 'mbti-questions',
                );
            },
          );
          const questionIds = [
            ...questionMessage.text.matchAll(/(?:^|\n)(\d+)\. /g),
          ].map((match) => Number(match[1]));
          expect(questionIds).toHaveLength(4);
          expect(new Set(questionIds).size).toBe(4);
          expect(questionIds.every((id) => !seenQuestionIds.has(id))).toBe(
            true,
          );
          questionIds.forEach((id) => seenQuestionIds.add(id));
          questionSentCursor = harness.telegram.sent.length;
          const answerText = questionIds
            .map((id) => {
              const answer = SYNTHETIC_ANSWERS.find(
                (item) => item.questionId === id,
              );
              if (answer === undefined)
                throw new LiveHarnessError(
                  'LIVE_ASSERTION_FAILED',
                  'mbti-vector',
                );
              return `${String(answer.questionId)}=${String(answer.value)}`;
            })
            .join('、');
          const replyId = harness.telegram.push(
            answerText,
            questionMessage.messageId,
          );
          const candidateCursor = harness.telegram.sent.length;
          const candidate = await stageWait(
            harness,
            'mbti-test',
            `mbti-candidate-${String(batch + 1)}`,
            () =>
              harness.telegram.sent
                .slice(candidateCursor)
                .find(
                  (message) =>
                    message.text.includes(`Job ${queued}`) &&
                    message.kind === 'mbti-candidate',
                ),
          );
          const beforeFact = harness.flowStore.getSessionFact(
            session.id,
            '424242',
            'mbti_answers',
          );
          const beforeAnswers =
            (
              beforeFact?.value as
                { answers?: { questionId: number }[] } | undefined
            )?.answers ?? [];
          expect(beforeAnswers).toHaveLength(batch * 4);
          expect(
            questionIds.every(
              (questionId) =>
                !beforeAnswers.some(
                  (answer) => answer.questionId === questionId,
                ),
            ),
          ).toBe(true);
          const candidateBinding = harness.resources.store.database
            .prepare(
              'SELECT active FROM prompt_bindings WHERE chat_id=? AND message_id=?',
            )
            .get('515151', candidate.messageId) as
            { active?: number } | undefined;
          expect(candidateBinding?.active).toBe(1);
          const priorFact = harness.flowStore.getSessionFact(
            session.id,
            '424242',
            'mbti_answers',
          );
          const priorIds = new Set(
            (
              (
                priorFact?.value as
                  { answers?: { questionId: number }[] } | undefined
              )?.answers ?? []
            ).map((answer) => answer.questionId),
          );
          expect(
            questionIds.every((questionId) => !priorIds.has(questionId)),
          ).toBe(true);
          expect(candidate.text).toContain('候選答案');
          const previousConfirmationCount = Array.isArray(
            (priorFact?.source as { confirmationMessageIds?: unknown[] } | null)
              ?.confirmationMessageIds,
          )
            ? (priorFact?.source as { confirmationMessageIds: unknown[] })
                .confirmationMessageIds.length
            : 0;
          const confirmationId = harness.telegram.push(
            '確認本人',
            candidate.messageId,
          );
          await stageWait(
            harness,
            'mbti-test',
            `mbti-confirm-${String(batch + 1)}`,
            () => {
              if (batch < 2) {
                const fact = harness.flowStore.getSessionFact(
                  session.id,
                  '424242',
                  'mbti_answers',
                );
                const answers =
                  (fact?.value as { answers?: unknown[] } | undefined)
                    ?.answers ?? [];
                if (answers.length !== 4 * (batch + 1)) return false;
                const nextQuestion = harness.telegram.sent.find(
                  (message) =>
                    message.messageId > candidate.messageId &&
                    message.kind === 'mbti-questions' &&
                    message.text.includes(`Job ${queued}`),
                );
                if (nextQuestion === undefined) return false;
                const nextIds = [
                  ...nextQuestion.text.matchAll(/(?:^|\n)(\d+)\. /g),
                ].map((match) => Number(match[1]));
                return (
                  nextIds.length === 4 &&
                  new Set(nextIds).size === 4 &&
                  nextIds.every((id) => !seenQuestionIds.has(id))
                );
              }
              return (
                harness.resources.store.statusForJob('424242', queued)
                  ?.status === 'COMPLETED'
              );
            },
          );
          const confirmedFact = harness.flowStore.getSessionFact(
            session.id,
            '424242',
            'mbti_answers',
          );
          const confirmations = (
            confirmedFact?.source as
              { confirmationMessageIds?: unknown[] } | undefined
          )?.confirmationMessageIds;
          expect(confirmations).toHaveLength(previousConfirmationCount + 1);
          expect(replyId).toBeGreaterThan(0);
          expect(confirmationId).toBeGreaterThan(0);
        }
        const mbtiStatus = harness.resources.store.statusForJob(
          '424242',
          queued,
        );
        expect(mbtiStatus?.status).toBe('COMPLETED');
        mbti['status'] = mbtiStatus?.status ?? 'unknown';
        const state = harness.flowStore.getPinnedFlowRun(queued);
        if (state === null)
          throw new LiveHarnessError('LIVE_ASSERTION_FAILED', 'mbti-state');
        const execution = parseFlowExecutionState(state.state);
        const mbtiFact = harness.flowStore.getSessionFact(
          session.id,
          '424242',
          'mbti_answers',
        );
        expect(mbtiFact?.provenance).toBe('user_confirmed');
        const factSource = mbtiFact?.source as
          { subject?: unknown; confirmationMessageIds?: unknown } | undefined;
        expect(factSource?.subject).toBe('self');
        expect(Array.isArray(factSource?.confirmationMessageIds)).toBe(true);
        const factConfirmations = factSource?.confirmationMessageIds;
        expect(
          Array.isArray(factConfirmations) &&
            execution.sources.confirmationMessageIds.every((reference) =>
              factConfirmations.includes(reference),
            ),
        ).toBe(true);
        expect(
          (mbtiFact?.value as { answers?: unknown[] } | undefined)?.answers,
        ).toEqual(SYNTHETIC_ANSWERS);
        check(
          harness,
          'mbti-test',
          'facts-confirmed',
          mbtiFact !== null &&
            execution.sources.subject === 'self' &&
            execution.sources.confirmationMessageIds.length === 3,
        );
        const expectedAssessment = evaluateMbtiAnswers(SYNTHETIC_ANSWERS);
        expect(execution.mbtiAssessment).toEqual(expectedAssessment);
        check(
          harness,
          'mbti-test',
          'assessment-recomputed',
          JSON.stringify(execution.mbtiAssessment) ===
            JSON.stringify(expectedAssessment),
        );
        expect(execution.interpretation?.summary.length).toBeGreaterThan(0);
        expect(execution.interpretation?.sections.length).toBeGreaterThan(0);
        check(
          harness,
          'mbti-test',
          'interpretation-present',
          Boolean(
            execution.interpretation?.summary &&
            execution.interpretation.sections.length,
          ),
        );
        const mbtiOutbox = await stageWait(
          harness,
          'mbti-test',
          'mbti-result-delivery',
          () => {
            const rows = harness.resources.store.database
              .prepare(
                "SELECT text, status, chunk_index FROM outbox WHERE job_id=? AND kind='completed' ORDER BY created_at, rowid, chunk_index",
              )
              .all(queued) as {
              text: string;
              status: string;
              chunk_index: number;
            }[];
            if (
              rows.length === 0 ||
              rows.some((row) => row.status !== 'DELIVERED') ||
              rows.some(
                (row) =>
                  !harness.telegram.sent.some(
                    (message) => message.text === row.text,
                  ),
              )
            )
              return null;
            return rows;
          },
        );
        const mbtiText = mbtiOutbox.map((row) => row.text).join('\n');
        expect(mbtiText).toContain('本人 MBTI 自我反思結果');
        expect(mbtiText).toContain(MBTI_DISCLAIMER);
        expect(mbtiText).toContain('逐題依據');
        const undelivered = harness.resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE job_id=? AND kind='completed' AND status!='DELIVERED'",
          )
          .get(queued) as { count: number };
        expect(undelivered.count).toBe(0);
        check(
          harness,
          'mbti-test',
          'result-delivered',
          undelivered.count === 0,
        );
        const pendingPrompts = harness.resources.store.database
          .prepare(
            'SELECT COUNT(*) AS count FROM prompt_bindings WHERE job_id=? AND active=1',
          )
          .get(queued) as { count: number };
        expect(pendingPrompts.count).toBe(0);
        check(
          harness,
          'mbti-test',
          'prompts-closed',
          pendingPrompts.count === 0,
        );
        const answerInputs = harness.telegram.inputs.filter((item) =>
          /(?:^|\D)\d+\s*=/.test(item.text),
        );
        expect(answerInputs).toHaveLength(3);
        expect(answerInputs.map((item) => item.text).join(' ')).toContain(
          '2=0',
        );
        expect(answerInputs.every((item) => item.replyTo !== undefined)).toBe(
          true,
        );
        expect(
          harness.telegram.inputs.filter((item) => item.text === '確認本人'),
        ).toHaveLength(3);
        const submittedAnswers = answerInputs.flatMap((item) =>
          [...item.text.matchAll(/(?:^|[^0-9])(\d+)\s*=\s*(-?\d+|null)/g)].map(
            (match) => ({
              questionId: Number(match[1]),
              value: match[2] === 'null' ? null : Number(match[2]),
            }),
          ),
        );
        expect(submittedAnswers).toEqual(SYNTHETIC_ANSWERS);

        const statusSentCursor = harness.telegram.sent.length;
        const jobsBeforeStatus = (
          harness.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get() as { count: number }
        ).count;
        const nodesBeforeStatus = harness.runtime.trace.length;
        harness.telegram.push(`/status ${queued}`);
        await stageWait(harness, 'mbti-test', 'status-no-work', () =>
          harness.telegram.sent
            .slice(statusSentCursor)
            .find((message) =>
              message.text.includes(`Job ${queued} — COMPLETED`),
            ),
        );
        expect(
          (
            harness.resources.store.database
              .prepare('SELECT COUNT(*) AS count FROM jobs')
              .get() as { count: number }
          ).count,
        ).toBe(jobsBeforeStatus);
        expect(harness.runtime.trace.length).toBe(nodesBeforeStatus);

        harness.telegram.push('/new natal-test');
        const natalSession = await stageWait(
          harness,
          'natal-test',
          'create-session',
          () => {
            const found = harness.resources.store.selectedSession(
              '424242',
              '515151',
            );
            return found?.name === 'natal-test' ? found : null;
          },
        );
        natal['sessionId'] = natalSession.id;
        check(
          harness,
          'natal-test',
          'session-created',
          natalSession.name === 'natal-test',
        );
        harness.telegram.push(
          '/queue 請分析出生星盤，date=2000-01-01 time=12:00',
        );
        const natalJob = await stageWait(
          harness,
          'natal-test',
          'queue-job',
          () => {
            const row = harness.resources.store.database
              .prepare(
                'SELECT id FROM jobs WHERE session_id=? ORDER BY created_at DESC LIMIT 1',
              )
              .get(natalSession.id) as { id?: string } | undefined;
            return row?.id;
          },
        );
        natal['jobId'] = natalJob;
        const natalChoice = await stageWait(
          harness,
          'natal-test',
          'wait-flow-choice',
          () => sentForJob(harness, natalJob, 'flow-choice')[0],
        );
        harness.telegram.push('natal', natalChoice.messageId);
        const missing = await stageWait(
          harness,
          'natal-test',
          'wait-birth-input',
          () => sentForJob(harness, natalJob, 'natal-missing')[0],
        );
        expect(missing.text).toContain('IANA 時區');
        expect(
          harness.flowStore.getSessionFact(
            natalSession.id,
            '424242',
            'natal_birth',
          ),
        ).toBeNull();
        const candidateInputId = harness.telegram.push(
          'lat=25.03 lon=121.56 zone=Asia/Taipei',
          missing.messageId,
        );
        const natalCandidate = await stageWait(
          harness,
          'natal-test',
          'wait-birth-candidate',
          () => sentForJob(harness, natalJob, 'natal-candidate')[0],
        );
        for (const expected of [
          '2000-01-01',
          '12:00',
          '25.03',
          '121.56',
          'Asia/Taipei',
        ])
          expect(natalCandidate.text).toContain(expected);
        expect(
          harness.flowStore.getSessionFact(
            natalSession.id,
            '424242',
            'natal_birth',
          ),
        ).toBeNull();
        const natalConfirmation = harness.telegram.push(
          '確認本人',
          natalCandidate.messageId,
        );
        await stageWait(
          harness,
          'natal-test',
          'confirm-birth-and-complete',
          () =>
            harness.resources.store.statusForJob('424242', natalJob)?.status ===
            'COMPLETED',
        );
        const natalStatus = harness.resources.store.statusForJob(
          '424242',
          natalJob,
        );
        natal['status'] = natalStatus?.status ?? 'unknown';
        expect(natalStatus?.status).toBe('COMPLETED');
        const natalRun = harness.flowStore.getPinnedFlowRun(natalJob);
        if (natalRun === null)
          throw new LiveHarnessError('LIVE_ASSERTION_FAILED', 'natal-state');
        const natalState = parseFlowExecutionState(natalRun.state);
        const natalFact = harness.flowStore.getSessionFact(
          natalSession.id,
          '424242',
          'natal_birth',
        );
        expect(natalFact?.provenance).toBe('user_confirmed');
        expect(natalFact?.source).toMatchObject({ subject: 'self' });
        expect(natalFact?.value).toEqual(NATAL_INPUT);
        expect(natalFact?.source).toHaveProperty('confirmationMessageIds');
        expect(natalState.natalConfirmed).toMatchObject(NATAL_INPUT);
        expect(natalState.sources.confirmationMessageIds).toHaveLength(1);
        check(
          harness,
          'natal-test',
          'facts-confirmed',
          natalFact !== null &&
            natalState.sources.subject === 'self' &&
            natalState.sources.confirmationMessageIds.length === 1,
        );
        const recomputedChart = calculateNatalChart(NATAL_INPUT);
        expect(natalState.chart).toEqual(recomputedChart);
        expect(natalState.chart?.planets).toHaveLength(10);
        expect(natalState.chart?.houseCusps).toHaveLength(12);
        check(
          harness,
          'natal-test',
          'assessment-recomputed',
          JSON.stringify(natalState.chart) === JSON.stringify(recomputedChart),
        );
        expect(natalState.interpretation?.summary.length).toBeGreaterThan(0);
        expect(natalState.interpretation?.sections.length).toBeGreaterThan(0);
        check(
          harness,
          'natal-test',
          'interpretation-present',
          Boolean(
            natalState.interpretation?.summary &&
            natalState.interpretation.sections.length,
          ),
        );
        const natalOutbox = await stageWait(
          harness,
          'natal-test',
          'natal-result-delivery',
          () => {
            const rows = harness.resources.store.database
              .prepare(
                "SELECT text, status, chunk_index FROM outbox WHERE job_id=? AND kind='completed' ORDER BY created_at, rowid, chunk_index",
              )
              .all(natalJob) as {
              text: string;
              status: string;
              chunk_index: number;
            }[];
            if (
              rows.length === 0 ||
              rows.some((row) => row.status !== 'DELIVERED') ||
              rows.some(
                (row) =>
                  !harness.telegram.sent.some(
                    (message) => message.text === row.text,
                  ),
              )
            )
              return null;
            return rows;
          },
        );
        const natalText = natalOutbox.map((row) => row.text).join('\n');
        expect(natalText).toContain('出生星盤計算結果');
        for (const body of [
          'Sun:',
          'Moon:',
          'Mercury:',
          'Venus:',
          'Mars:',
          'Jupiter:',
          'Saturn:',
          'Uranus:',
          'Neptune:',
          'Pluto:',
          'Ascendant：',
          'MC：',
          '十二宮 cusp',
          '主要相位',
          NATAL_DISCLAIMER,
        ])
          expect(natalText).toContain(body);
        const natalChunks = harness.resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE job_id=? AND kind='completed' AND status!='DELIVERED'",
          )
          .get(natalJob) as { count: number };
        expect(natalChunks.count).toBe(0);
        check(
          harness,
          'natal-test',
          'result-delivered',
          natalChunks.count === 0,
        );
        const noPendingNatalPrompt = harness.resources.store.database
          .prepare(
            'SELECT COUNT(*) AS count FROM prompt_bindings WHERE job_id=? AND active=1',
          )
          .get(natalJob) as { count: number };
        expect(noPendingNatalPrompt.count).toBe(0);
        check(
          harness,
          'natal-test',
          'prompts-closed',
          noPendingNatalPrompt.count === 0,
        );
        expect(candidateInputId).toBeGreaterThan(0);
        expect(natalConfirmation).toBeGreaterThan(0);
        const mbtiIdentity = harness.flowStore.getPiIdentity(session.id);
        const natalIdentity = harness.flowStore.getPiIdentity(natalSession.id);
        expect(mbtiIdentity).not.toBeNull();
        expect(natalIdentity).not.toBeNull();
        expect(mbtiIdentity?.piSessionId).not.toBe(natalIdentity?.piSessionId);
        expect(mbtiIdentity?.filePath).not.toBe(natalIdentity?.filePath);
        expect(mbtiIdentity?.filePath).toContain(
          resolve(harness.config.dataDir, 'pi', session.id),
        );
        expect(natalIdentity?.filePath).toContain(
          resolve(harness.config.dataDir, 'pi', natalSession.id),
        );
        check(
          harness,
          'mbti-test',
          'session-isolated',
          mbtiIdentity?.piSessionId !== natalIdentity?.piSessionId &&
            mbtiIdentity?.filePath !== natalIdentity?.filePath,
        );
        check(
          harness,
          'natal-test',
          'session-isolated',
          mbtiIdentity?.piSessionId !== natalIdentity?.piSessionId &&
            mbtiIdentity?.filePath !== natalIdentity?.filePath,
        );
        expect(
          harness.flowStore.getSessionFact(session.id, '424242', 'natal_birth'),
        ).toBeNull();
        expect(
          harness.flowStore.getSessionFact(
            natalSession.id,
            '424242',
            'mbti_answers',
          ),
        ).toBeNull();
        for (const controllerSession of [session, natalSession]) {
          expect(
            await pathExists(
              resolve(
                harness.config.dataDir,
                'pi',
                controllerSession.id,
                'agent/auth.json',
              ),
            ),
          ).toBe(false);
        }
        check(
          harness,
          'mbti-test',
          'model-runtime-real',
          harness.runtime.trace.length > 0 && harness.runtime.spawnCount > 0,
        );
        check(
          harness,
          'natal-test',
          'model-runtime-real',
          harness.runtime.trace.length > 0 && harness.runtime.spawnCount > 0,
        );
        expect(harness.runtime.trace.length).toBeLessThanOrEqual(
          harness.runtime.budget,
        );
        expect(harness.runtime.trace.length).toBeLessThanOrEqual(20);
        expect(harness.runtime.spawnCount).toBe(harness.runtime.trace.length);
        expect(
          harness.telegram.methods.every(
            (method) => method === 'getUpdates' || method === 'sendMessage',
          ),
        ).toBe(true);
        expect(
          harness.telegram.inputs.some((input) =>
            input.text.startsWith('/queue'),
          ),
        ).toBe(true);
        check(
          harness,
          'mbti-test',
          'job-completed',
          mbtiStatus?.status === 'COMPLETED',
        );
        check(
          harness,
          'natal-test',
          'job-completed',
          natalStatus?.status === 'COMPLETED',
        );
      } catch (error) {
        const active = harness.report['activeFlow'];
        const flowName = active === 'natal-test' ? 'natal-test' : 'mbti-test';
        const failed = flowRecord(harness, flowName);
        const recordJobId = failed['jobId'];
        const jobFailure =
          typeof recordJobId === 'string'
            ? harness.resources.store.statusForJob('424242', recordJobId)
                ?.failureCode
            : null;
        failed['safeFailureCode'] ??=
          jobFailure ??
          (error instanceof LiveHarnessError
            ? error.code
            : 'LIVE_ASSERTION_FAILED');
        failed['status'] = 'failed';
        if (flowName === 'mbti-test') natal['status'] = 'not-executed';
        throw error;
      } finally {
        const stopped = await harness.service.stop().then(
          () => true,
          () => false,
        );
        harness.telegram.stop();
        const lockPath = resolve(harness.config.dataDir, 'controller.lock');
        const anchorPath = resolve(
          harness.config.dataDir,
          'controller.kernel.lock',
        );
        let lockExists: boolean | null = null;
        try {
          lockExists = await pathExists(lockPath);
        } catch (error) {
          cleanupFailure = safeRuntimeCode(error);
        }
        let anchorRegular0600 = false;
        try {
          const anchor = await lstat(anchorPath);
          anchorRegular0600 =
            anchor.isFile() && (anchor.mode & 0o777) === 0o600;
        } catch (error) {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          ))
            cleanupFailure = safeRuntimeCode(error);
        }
        const snapshotChecks: Record<string, string> = {};
        for (const entry of [mbti, natal]) {
          const sessionId = entry['sessionId'];
          if (typeof sessionId !== 'string') {
            snapshotChecks[entry['name'] as string] = 'not-created';
            continue;
          }
          const snapshot = resolve(
            harness.config.dataDir,
            'pi',
            sessionId,
            'agent/auth.json',
          );
          try {
            snapshotChecks[entry['name'] as string] = (await pathExists(
              snapshot,
            ))
              ? 'present'
              : 'missing';
          } catch (error) {
            snapshotChecks[entry['name'] as string] = 'error';
            cleanupFailure ??= safeRuntimeCode(error);
          }
        }
        const cleanup = harness.report['cleanup'] as Record<string, unknown>;
        cleanup['attempted'] = true;
        cleanup['serviceStopped'] = stopped;
        cleanup['runnerJoined'] = stopped;
        cleanup['noPendingRunnerOperation'] = stopped;
        cleanup['controllerLockRemoved'] = lockExists === false;
        cleanup['kernelAnchorRegular0600'] = anchorRegular0600;
        cleanup['snapshotBySession'] = snapshotChecks;
        cleanup['activeRuntimeOperations'] =
          harness.runtime.activeOperationCount;
        cleanup['pendingTransport'] = harness.telegram.pendingTransportCount;
        cleanup['noRuntimeOperations'] =
          harness.runtime.activeOperationCount === 0;
        cleanup['transportStopped'] =
          harness.telegram.pendingTransportCount === 0;
        if (cleanupFailure !== undefined)
          cleanup['safeErrorCode'] = cleanupFailure;
        harness.report['agentNodesStarted'] = harness.runtime.trace.length;
        harness.report['spawnCount'] = harness.runtime.spawnCount;
        harness.report['mockMessagesSent'] = harness.telegram.sent.length;
        harness.report['agentTrace'] = harness.runtime.trace;
        await Promise.all([
          savePrivateJson(
            resolve(harness.runDir, 'transcript.json'),
            harness.transcript,
          ),
          savePrivateJson(
            resolve(harness.runDir, 'report.json'),
            harness.report,
          ),
        ]);
        expect(stopped).toBe(true);
        expect(lockExists).toBe(false);
        expect(anchorRegular0600).toBe(true);
        expect(harness.runtime.activeOperationCount).toBe(0);
        expect(harness.telegram.pendingTransportCount).toBe(0);
        expect(
          Object.values(snapshotChecks).every(
            (value) => value === 'missing' || value === 'not-created',
          ),
        ).toBe(true);
      }
    },
    MAX_SCENARIO_MS + 5 * 60_000,
  );
});
