import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerService } from '../../src/controller/service.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type { TelegramUpdate } from '../../src/controller/types.js';
import { loadFlowBundleConfig } from '../../src/flow/config-file.js';
import {
  testConfig,
  makeUpdate,
  flushTasks,
  CHAT_ID,
  USER_ID,
} from './helpers.js';
import { FakeAgentRuntime } from '../flow/helpers.js';

const FLOW_CONFIG_PATH = resolve(process.cwd(), 'config/pi-flow.example.json');
const ARTIFACT_ROOT = resolve(
  process.cwd(),
  '.test-artifacts/pi-flow/wiring/e2e',
);

class ManualClock {
  constructor(public current = 1_000) {}

  now = (): number => this.current;
}

class ManualSleep {
  private readonly pending: Array<{
    readonly milliseconds: number;
    readonly finish: () => void;
  }> = [];

  sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolveSleep) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', finish);
        const index = this.pending.findIndex((item) => item.finish === finish);
        if (index >= 0) this.pending.splice(index, 1);
        resolveSleep();
      };
      this.pending.push({ milliseconds, finish });
      signal.addEventListener('abort', finish, { once: true });
    });
  };

  hasDelay(milliseconds: number): boolean {
    return this.pending.some((item) => item.milliseconds === milliseconds);
  }

  releaseAtMost(maximum: number): void {
    for (const item of [...this.pending]) {
      if (item.milliseconds <= maximum) item.finish();
    }
  }

  releaseDelay(milliseconds: number): void {
    for (const item of [...this.pending]) {
      if (item.milliseconds === milliseconds) item.finish();
    }
  }

  pendingMilliseconds(): readonly number[] {
    return this.pending.map((item) => item.milliseconds);
  }
}

interface SentMessage {
  readonly messageId: number;
  readonly chatId: number;
  readonly text: string;
}

interface SimulatedUpdateOptions {
  readonly replyTo?: number;
  readonly date?: number;
}

class SimulatedTelegram {
  readonly calls: string[] = [];
  readonly sent: SentMessage[] = [];
  private readonly updates: TelegramUpdate[] = [];
  private updateId = 0;
  private messageId = 20_000;
  private blockPredicate: ((text: string) => boolean) | undefined;
  private blockedOnce = false;
  private blockedSend:
    | {
        readonly messageId: number;
        readonly chatId: number;
        readonly text: string;
        readonly resolve: (response: Response) => void;
        readonly reject: (error: Error) => void;
        readonly signal: AbortSignal | undefined;
      }
    | undefined;

  readonly fetcher: FetchLike = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = new URL(url).pathname.split('/').at(-1) ?? '';
    this.calls.push(method);
    if (method === 'getUpdates') {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: this.updates.splice(0) }),
          { status: 200 },
        ),
      );
    }
    if (method !== 'sendMessage' || typeof init?.body !== 'string') {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error_code: 400 }), {
          status: 400,
        }),
      );
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const chatId = Number(body['chat_id']);
    const text = typeof body['text'] === 'string' ? body['text'] : '';
    const messageId = ++this.messageId;
    if (
      !this.blockedOnce &&
      this.blockPredicate !== undefined &&
      this.blockPredicate(text)
    ) {
      this.blockedOnce = true;
      return new Promise<Response>((resolveResponse, rejectResponse) => {
        const signal = init.signal ?? undefined;
        this.blockedSend = {
          messageId,
          chatId,
          text,
          resolve: resolveResponse,
          reject: rejectResponse,
          signal,
        };
        if (signal?.aborted) {
          rejectResponse(new Error('synthetic transport aborted'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            rejectResponse(new Error('synthetic transport aborted'));
          },
          { once: true },
        );
      });
    }
    this.sent.push({ messageId, chatId, text });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: messageId, chat: { id: chatId } },
        }),
        { status: 200 },
      ),
    );
  };

  push(text: string, options: SimulatedUpdateOptions = {}): number {
    const updateId = ++this.updateId;
    this.updates.push(
      makeUpdate(updateId, text, {
        date: options.date ?? 2_000_000_000,
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      }),
    );
    return updateId;
  }

  releaseNextMatching(text: (value: string) => boolean): void {
    this.blockPredicate = text;
    this.blockedOnce = false;
  }

  releaseBlockedSend(): number {
    const blocked = this.blockedSend;
    if (blocked === undefined) throw new Error('No Telegram send is blocked.');
    this.blockedSend = undefined;
    this.sent.push({
      messageId: blocked.messageId,
      chatId: blocked.chatId,
      text: blocked.text,
    });
    blocked.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: blocked.messageId,
            chat: { id: blocked.chatId },
          },
        }),
        { status: 200 },
      ),
    );
    return blocked.messageId;
  }

  get blockedMessageId(): number | null {
    return this.blockedSend?.messageId ?? null;
  }
}

interface Harness {
  readonly config: ReturnType<typeof testConfig>;
  readonly clock: ManualClock;
  readonly sleeper: ManualSleep;
  readonly telegram: SimulatedTelegram;
  readonly resources: Awaited<ReturnType<typeof openControllerResources>>;
  readonly runtime: FakeAgentRuntime;
  readonly service: ControllerService;
  readonly dataDir: string;
}

async function createHarness(options: {
  readonly name: string;
  readonly runtime?: FakeAgentRuntime;
  readonly telegram?: SimulatedTelegram;
  readonly clock?: ManualClock;
  readonly concurrency?: number;
}): Promise<Harness> {
  await mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  const dataDir = join(ARTIFACT_ROOT, options.name);
  const clock = options.clock ?? new ManualClock();
  const sleeper = new ManualSleep();
  const telegram = options.telegram ?? new SimulatedTelegram();
  const runtime = options.runtime ?? new FakeAgentRuntime();
  const config = testConfig({
    CONTROLLER_DATA_DIR: dataDir,
    PI_FLOW_CONFIG: FLOW_CONFIG_PATH,
    JOB_CONCURRENCY: String(options.concurrency ?? 2),
  });
  const resources = await openControllerResources(config, { now: clock.now });
  const bundle = await loadFlowBundleConfig(config.flowConfigPath);
  const service = new ControllerService(
    config,
    resources,
    new TelegramClient(config.token, telegram.fetcher),
    bundle,
    {
      clock,
      sleep: sleeper.sleep,
      pollIntervalMs: 100,
      outboxIntervalMs: 100,
      environment: (name) =>
        name === 'FLOW_TEST_API_KEY' ? 'synthetic-only-flow-key' : undefined,
      agentRuntimeForTests: runtime,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
  );
  return {
    config,
    clock,
    sleeper,
    telegram,
    resources,
    runtime,
    service,
    dataDir,
  };
}

async function openReadyGate(harness: Harness): Promise<void> {
  const readyTime = Math.floor(harness.clock.current / 1000) * 1000 + 1000;
  const delay = readyTime - harness.clock.current;
  harness.clock.current = readyTime;
  harness.sleeper.releaseDelay(delay);
  await flushTasks();
}

async function startHarness(harness: Harness): Promise<void> {
  harness.service.start();
  await openReadyGate(harness);
}

async function pumpUntil(
  harness: Harness,
  condition: () => boolean,
  attempts = 500,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return;
    harness.sleeper.releaseAtMost(100);
    await flushTasks();
  }
  if (!condition()) {
    throw new Error(
      `Integration condition was not reached; delays=${harness.sleeper.pendingMilliseconds().join(',')}`,
    );
  }
}

function latestSent(
  telegram: SimulatedTelegram,
  jobId: string,
  fragment: string,
  from = 0,
): SentMessage | undefined {
  return telegram.sent
    .slice(from)
    .filter(
      (message) =>
        message.text.includes(`Job ${jobId}`) &&
        message.text.includes(fragment),
    )
    .at(-1);
}

function sentJobText(telegram: SimulatedTelegram, jobId: string): string {
  return telegram.sent
    .filter((message) => message.text.includes(`Job ${jobId}`))
    .map((message) => message.text)
    .join('\n');
}

function jobIdFromOutbox(harness: Harness, kind: 'ack' | 'prompt'): string {
  const row = harness.resources.store.database
    .prepare(
      `SELECT job_id, text FROM outbox WHERE kind=? AND job_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
    )
    .get(kind) as { job_id: string | null; text: string } | undefined;
  if (row?.job_id !== null && row?.job_id !== undefined) return row.job_id;
  const match = /Queued job ([^\s.]+)/.exec(row?.text ?? '');
  if (match?.[1] === undefined) throw new Error('Expected a queued Job ID.');
  return match[1];
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.service.stop();
  await rm(harness.dataDir, { recursive: true, force: true });
}

afterEach(async () => {
  await rm(ARTIFACT_ROOT, { recursive: true, force: true });
});

describe('simulated Telegram to Flow production wiring', () => {
  it('stops before READY without polling, sending, or creating work', async () => {
    const harness = await createHarness({ name: 'stop-before-ready' });
    try {
      harness.telegram.push('/new must-not-run', { date: 1 });
      harness.service.start();
      await flushTasks();
      expect(harness.telegram.calls).toHaveLength(0);
      expect(
        harness.resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 0 });
      await harness.service.stop();
      expect(harness.telegram.calls).toHaveLength(0);
      expect(() => harness.resources.store.getOffset()).toThrow();
    } finally {
      await closeHarness(harness);
    }
  });

  it('gates startup and completes MBTI, history reuse, unsupported, and natal through Telegram updates', async () => {
    const harness = await createHarness({ name: 'happy-path', concurrency: 2 });
    try {
      harness.telegram.push('/new message-before-ready', { date: 1 });
      harness.service.start();
      await flushTasks();
      expect(harness.telegram.calls).toHaveLength(0);
      expect(harness.resources.store.getOffset()).toBe(0);
      expect(
        harness.resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 0 });

      await openReadyGate(harness);
      await pumpUntil(harness, () =>
        harness.resources.store.isUpdateProcessed(1),
      );
      expect(harness.resources.store.getOffset()).toBe(2);
      expect(harness.resources.store.listSessions(USER_ID)).toHaveLength(0);
      expect(
        harness.telegram.sent.some((message) =>
          message.text.includes('請重新傳送啟動期間的訊息'),
        ),
      ).toBe(true);

      harness.telegram.push('/new primary-session', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.selectedSession(USER_ID, CHAT_ID) !== null,
      );
      const primarySession = harness.resources.store.selectedSession(
        USER_ID,
        CHAT_ID,
      );
      if (primarySession === null)
        throw new Error('Expected a primary Session.');

      harness.telegram.push('/queue MBTI self-reflection', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 1 &&
          latestSent(
            harness.telegram,
            jobIdFromOutbox(harness, 'ack'),
            '請明確回覆 Flow ID',
          ) !== undefined,
      );
      const mbtiJob = jobIdFromOutbox(harness, 'ack');
      const initialChoice = latestSent(
        harness.telegram,
        mbtiJob,
        '請明確回覆 Flow ID',
      );
      if (initialChoice === undefined)
        throw new Error('Missing Flow choice prompt.');

      harness.telegram.push('/new other-session', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.selectedSession(USER_ID, CHAT_ID)?.name ===
          'other-session',
      );
      const otherSession = harness.resources.store.selectedSession(
        USER_ID,
        CHAT_ID,
      );
      if (otherSession === null) throw new Error('Expected the other Session.');
      harness.telegram.push(`/use ${otherSession.id}`, { date: 2 });
      harness.telegram.push('mbti', {
        date: 2,
        replyTo: initialChoice.messageId,
      });
      await pumpUntil(
        harness,
        () =>
          latestSent(harness.telegram, mbtiJob, '原創生活偏好題') !== undefined,
      );

      for (let batch = 0; batch < 3; batch += 1) {
        const questionPrompt = latestSent(
          harness.telegram,
          mbtiJob,
          '原創生活偏好題',
        );
        if (questionPrompt === undefined)
          throw new Error('Missing MBTI question prompt.');
        const firstQuestion = batch * 4 + 1;
        expect(questionPrompt.text).toContain(`${String(firstQuestion)}.`);
        const beforeAnswer = harness.telegram.sent.length;
        const answers = Array.from(
          { length: 4 },
          (_, index) =>
            `${String(firstQuestion + index)}=${index === 1 ? '0' : '2'}`,
        ).join('、');
        harness.telegram.push(answers, {
          date: 2,
          replyTo: questionPrompt.messageId,
        });
        await pumpUntil(
          harness,
          () =>
            latestSent(harness.telegram, mbtiJob, '候選答案', beforeAnswer) !==
            undefined,
        );
        const candidate = latestSent(
          harness.telegram,
          mbtiJob,
          '候選答案',
          beforeAnswer,
        );
        if (candidate === undefined)
          throw new Error('Missing MBTI candidate confirmation prompt.');
        const beforeConfirmation = harness.telegram.sent.length;
        harness.telegram.push('確認本人', {
          date: 2,
          replyTo: candidate.messageId,
        });
        if (batch < 2) {
          await pumpUntil(
            harness,
            () =>
              latestSent(
                harness.telegram,
                mbtiJob,
                '原創生活偏好題',
                beforeConfirmation,
              ) !== undefined,
          );
        } else {
          await pumpUntil(
            harness,
            () =>
              harness.resources.store.statusForJob(USER_ID, mbtiJob)?.status ===
                'COMPLETED' &&
              sentJobText(harness.telegram, mbtiJob).includes(
                'MBTI 自我反思結果',
              ),
          );
        }
      }
      const mbtiResult = sentJobText(harness.telegram, mbtiJob);
      expect(mbtiResult).toContain('逐題依據');
      expect(mbtiResult).toContain('確認本人');
      expect(mbtiResult).not.toContain('PRIVATE_TEST_RATIONALE');
      const mbtiFact = harness.resources.store.database
        .prepare(
          "SELECT value_json, source_json, provenance FROM session_facts WHERE session_id=? AND kind='mbti_answers'",
        )
        .get(primarySession.id) as
        | { value_json: string; source_json: string; provenance: string }
        | undefined;
      expect(mbtiFact?.provenance).toBe('user_confirmed');
      expect(JSON.parse(mbtiFact?.value_json ?? '{}')).toMatchObject({
        answers: Array.from({ length: 12 }, (_, index) => ({
          questionId: index + 1,
          value: index % 4 === 1 ? 0 : 2,
        })),
      });
      expect(JSON.parse(mbtiFact?.source_json ?? '{}')).toMatchObject({
        subject: 'self',
        jobId: mbtiJob,
      });
      expect(
        harness.resources.store.statusForJob(USER_ID, mbtiJob),
      ).toMatchObject({
        status: 'COMPLETED',
      });

      const callsBeforeStatus = harness.runtime.calls.length;
      harness.telegram.push(`/status ${mbtiJob}`, { date: 2 });
      await pumpUntil(harness, () =>
        harness.telegram.sent.some(
          (message) =>
            message.text.includes(`Job ${mbtiJob} — COMPLETED`) &&
            message.text.includes('Flow: mbti/done; transitions='),
        ),
      );
      expect(harness.runtime.calls).toHaveLength(callsBeforeStatus);
      expect(
        harness.resources.store.database
          .prepare('SELECT COUNT(*) AS count FROM jobs')
          .get(),
      ).toMatchObject({ count: 1 });
      harness.telegram.push(`/use ${primarySession.id}`, { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.selectedSession(USER_ID, CHAT_ID)?.id ===
          primarySession.id,
      );

      harness.telegram.push('/queue MBTI self-reflection again', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 2,
      );
      const reuseJob = jobIdFromOutbox(harness, 'ack');
      await pumpUntil(
        harness,
        () =>
          latestSent(harness.telegram, reuseJob, '請明確回覆 Flow ID') !==
          undefined,
      );
      const reuseChoice = latestSent(
        harness.telegram,
        reuseJob,
        '請明確回覆 Flow ID',
      );
      if (reuseChoice === undefined)
        throw new Error('Missing MBTI history reuse choice prompt.');
      harness.telegram.push('mbti', {
        date: 2,
        replyTo: reuseChoice.messageId,
      });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.statusForJob(USER_ID, reuseJob)?.status ===
            'COMPLETED' &&
          sentJobText(harness.telegram, reuseJob).includes('MBTI 自我反思結果'),
      );
      expect(
        harness.runtime.calls.some(
          (call) =>
            call.node.resultContract === 'mbti_answers' &&
            call.input.includes('"reuseConfirmedHistory":true'),
        ),
      ).toBe(true);
      expect(
        harness.telegram.sent.some(
          (message) =>
            message.text.includes(`Job ${reuseJob}`) &&
            message.text.includes('原創生活偏好題'),
        ),
      ).toBe(false);

      harness.telegram.push('/queue unavailable goal', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 3,
      );
      const unsupportedJob = jobIdFromOutbox(harness, 'ack');
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.statusForJob(USER_ID, unsupportedJob)
            ?.status === 'COMPLETED' &&
          sentJobText(harness.telegram, unsupportedJob).includes(
            '目前沒有符合目標的已註冊能力',
          ),
      );
      expect(sentJobText(harness.telegram, unsupportedJob)).not.toContain(
        'MBTI',
      );
      expect(sentJobText(harness.telegram, unsupportedJob)).not.toContain(
        '出生星盤',
      );

      harness.telegram.push(
        '/queue Please create a natal chart for me: date=2000-01-01 time=12:00',
        { date: 2 },
      );
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 4,
      );
      const natalJob = jobIdFromOutbox(harness, 'ack');
      await pumpUntil(
        harness,
        () =>
          latestSent(harness.telegram, natalJob, '請明確回覆 Flow ID') !==
          undefined,
      );
      const natalChoice = latestSent(
        harness.telegram,
        natalJob,
        '請明確回覆 Flow ID',
      );
      if (natalChoice === undefined)
        throw new Error('Missing natal Flow choice prompt.');
      harness.telegram.push('natal', {
        date: 2,
        replyTo: natalChoice.messageId,
      });
      await pumpUntil(
        harness,
        () =>
          latestSent(
            harness.telegram,
            natalJob,
            '請提供你本人的完整出生資料',
          ) !== undefined,
      );
      const missingPrompt = latestSent(
        harness.telegram,
        natalJob,
        '請提供你本人的完整出生資料',
      );
      if (missingPrompt === undefined)
        throw new Error('Missing natal input prompt.');
      expect(missingPrompt.text).toContain('IANA 時區');
      const beforeNatalCandidate = harness.telegram.sent.length;
      harness.telegram.push('lat=25.03 lon=121.56 zone=Asia/Taipei', {
        date: 2,
        replyTo: missingPrompt.messageId,
      });
      await pumpUntil(
        harness,
        () =>
          latestSent(
            harness.telegram,
            natalJob,
            '以下是出生資料候選',
            beforeNatalCandidate,
          ) !== undefined,
      );
      const natalCandidate = latestSent(
        harness.telegram,
        natalJob,
        '以下是出生資料候選',
        beforeNatalCandidate,
      );
      if (natalCandidate === undefined)
        throw new Error('Missing confirmed natal candidate.');
      expect(natalCandidate.text).toContain('2000-01-01');
      expect(natalCandidate.text).toContain('12:00');
      expect(natalCandidate.text).toContain('25.03');
      expect(
        harness.resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM session_facts WHERE session_id=? AND kind='natal_birth'",
          )
          .get(primarySession.id),
      ).toMatchObject({ count: 0 });
      harness.telegram.push('確認本人', {
        date: 2,
        replyTo: natalCandidate.messageId,
      });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.statusForJob(USER_ID, natalJob)?.status ===
            'COMPLETED' &&
          sentJobText(harness.telegram, natalJob).includes('出生星盤計算結果'),
      );
      const natalResult = sentJobText(harness.telegram, natalJob);
      expect(natalResult).toContain('Sun:');
      expect(natalResult).toContain('Mercury:');
      expect(natalResult).toContain('Ascendant：');
      expect(natalResult).toContain('MC：');
      expect(natalResult).toContain('十二宮 cusp');
      expect(natalResult).toContain('主要相位');
      expect(natalResult).toContain('娛樂與自我反思');
      expect(natalResult).not.toContain('PRIVATE_TEST_RATIONALE');
      const natalFact = harness.resources.store.database
        .prepare(
          "SELECT value_json, source_json, provenance FROM session_facts WHERE session_id=? AND kind='natal_birth'",
        )
        .get(primarySession.id) as
        | { value_json: string; source_json: string; provenance: string }
        | undefined;
      expect(natalFact?.provenance).toBe('user_confirmed');
      expect(JSON.parse(natalFact?.value_json ?? '{}')).toMatchObject({
        localDate: '2000-01-01',
        localTime: '12:00',
        latitude: 25.03,
        longitude: 121.56,
        timeZone: 'Asia/Taipei',
      });
      expect(JSON.parse(natalFact?.source_json ?? '{}')).toMatchObject({
        subject: 'self',
        jobId: natalJob,
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it('cancels work before READY and restart-terminates FIFO jobs while retaining valid outbox rows', async () => {
    const dataDir = join(ARTIFACT_ROOT, 'restart');
    const clock = new ManualClock(1_000);
    const telegram = new SimulatedTelegram();
    telegram.releaseNextMatching((text) =>
      text.includes('以下是原創生活偏好題'),
    );
    let holdStarted = false;
    const runtime: FakeAgentRuntime = new FakeAgentRuntime({
      beforeRun: async (input) => {
        if (
          input.node.resultContract === 'recommendation' &&
          input.input.includes('hold for restart')
        ) {
          holdStarted = true;
          await new Promise<void>((resolveRun) => {
            input.signal.addEventListener(
              'abort',
              () => {
                resolveRun();
              },
              { once: true },
            );
          });
        }
      },
    });
    const first = await createHarness({
      name: 'restart',
      runtime,
      telegram,
      clock,
      concurrency: 2,
    });
    try {
      first.telegram.push('/new fifo-session', { date: 2 });
      first.telegram.push('/queue MBTI self-reflection', { date: 2 });
      first.telegram.push('/queue same-session second job', { date: 2 });
      await startHarness(first);
      await pumpUntil(
        first,
        () =>
          first.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 2 &&
          first.resources.store.statusForSession(USER_ID, CHAT_ID)?.[0]
            ?.status === 'WAITING_INPUT',
      );
      const firstJob = first.resources.store.database
        .prepare('SELECT id FROM jobs ORDER BY sequence LIMIT 1')
        .get() as { id: string };
      const queuedJob = first.resources.store.database
        .prepare('SELECT id FROM jobs ORDER BY sequence DESC LIMIT 1')
        .get() as { id: string };
      await pumpUntil(
        first,
        () =>
          latestSent(first.telegram, firstJob.id, '請明確回覆 Flow ID') !==
          undefined,
      );
      const choicePrompt = latestSent(
        first.telegram,
        firstJob.id,
        '請明確回覆 Flow ID',
      );
      if (choicePrompt === undefined)
        throw new Error('Missing FIFO Flow choice prompt.');
      first.telegram.push('mbti', {
        date: 2,
        replyTo: choicePrompt.messageId,
      });
      await pumpUntil(first, () => first.telegram.blockedMessageId !== null);
      const pendingPromptRows = first.resources.store
        .dueOutbox(first.clock.now())
        .filter((item) => item.jobId === firstJob.id && item.kind === 'prompt');
      expect(pendingPromptRows).toHaveLength(1);

      first.telegram.push('/new cross-session', { date: 2 });
      await pumpUntil(
        first,
        () =>
          first.resources.store.selectedSession(USER_ID, CHAT_ID)?.name ===
          'cross-session',
      );
      first.telegram.push('/queue hold for restart', { date: 2 });
      await pumpUntil(
        first,
        () =>
          holdStarted &&
          first.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 3,
      );
      const runningJob = first.resources.store.database
        .prepare('SELECT id FROM jobs ORDER BY rowid DESC LIMIT 1')
        .get() as { id: string };
      expect(
        first.resources.store.statusForJob(USER_ID, firstJob.id)?.status,
      ).toBe('WAITING_INPUT');
      expect(
        first.resources.store.statusForJob(USER_ID, queuedJob.id)?.status,
      ).toBe('QUEUED');
      expect(
        first.resources.store.statusForJob(USER_ID, runningJob.id)?.status,
      ).toBe('RUNNING');
      const pendingPromptId = pendingPromptRows[0]?.id;
      if (pendingPromptId === undefined)
        throw new Error('Missing pending prompt ID.');
      await first.service.stop();

      const second = await createHarness({
        name: 'restart',
        telegram,
        clock: new ManualClock(2_000),
        concurrency: 2,
      });
      try {
        second.service.start();
        expect(
          second.resources.store.statusForJob(USER_ID, firstJob.id),
        ).toMatchObject({
          status: 'FAILED',
          failureCode: 'SERVER_RESTART',
        });
        expect(
          second.resources.store.statusForJob(USER_ID, queuedJob.id),
        ).toMatchObject({
          status: 'FAILED',
          failureCode: 'SERVER_RESTART',
        });
        expect(
          second.resources.store.statusForJob(USER_ID, runningJob.id),
        ).toMatchObject({
          status: 'FAILED',
          failureCode: 'SERVER_RESTART',
        });
        expect(
          second.resources.store.database
            .prepare("SELECT status FROM outbox WHERE kind='failed' LIMIT 1")
            .get(),
        ).toEqual({ status: 'PENDING' });
        expect(
          second.resources.store.database
            .prepare(
              'SELECT reason FROM outbox_cancellations WHERE outbox_id=?',
            )
            .get(pendingPromptId),
        ).toEqual({ reason: 'SERVER_RESTART' });
        expect(second.resources.store.isOutboxSendable(pendingPromptId)).toBe(
          false,
        );
        expect(
          second.resources.store.findPrompt(CHAT_ID, choicePrompt.messageId),
        ).toMatchObject({ active: false });
        await openReadyGate(second);
        await pumpUntil(second, () =>
          second.telegram.sent.some((message) =>
            message.text.includes('Job failed (SERVER_RESTART).'),
          ),
        );
        second.telegram.push('expired old question', {
          date: 3,
          replyTo: choicePrompt.messageId,
        });
        await pumpUntil(second, () =>
          second.resources.store.isUpdateProcessed(1),
        );
        expect(
          second.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get(),
        ).toMatchObject({ count: 3 });
        expect(
          second.resources.store.database
            .prepare(
              "SELECT COUNT(*) AS count FROM messages WHERE content='expired old question'",
            )
            .get(),
        ).toMatchObject({ count: 0 });
      } finally {
        await closeHarness(second);
      }
    } finally {
      await first.service.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rechecks sendability after a due snapshot and never sends a cancelled prompt', async () => {
    const harness = await createHarness({ name: 'cancel-snapshot' });
    try {
      const originalDueOutbox = harness.resources.store.dueOutbox.bind(
        harness.resources.store,
      );
      let cancelled = false;
      harness.resources.store.dueOutbox = (now, limit) => {
        const due = originalDueOutbox(now, limit);
        if (!cancelled) {
          const prompt = due.find((item) => item.kind === 'prompt');
          if (prompt?.jobId !== null && prompt?.jobId !== undefined) {
            cancelled = true;
            harness.resources.store.cancelPendingPrompts(
              prompt.jobId,
              'PROMPT_SUPERSEDED',
            );
          }
        }
        return due;
      };
      await startHarness(harness);
      harness.telegram.push('/new snapshot-session', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.selectedSession(USER_ID, CHAT_ID) !== null,
      );
      harness.telegram.push('/queue MBTI request', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          cancelled &&
          harness.resources.store.database
            .prepare('SELECT status FROM jobs LIMIT 1')
            .get()?.status === 'WAITING_INPUT',
      );
      expect(
        harness.telegram.sent.some((message) =>
          message.text.includes('請明確回覆 Flow ID'),
        ),
      ).toBe(false);
      expect(
        harness.resources.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox_cancellations WHERE reason='PROMPT_SUPERSEDED'",
          )
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      await closeHarness(harness);
    }
  });

  it('does not reactivate an in-flight prompt after a newer generation replaces it', async () => {
    const telegram = new SimulatedTelegram();
    telegram.releaseNextMatching((text) =>
      text.includes('以下是原創生活偏好題'),
    );
    const harness = await createHarness({
      name: 'late-send',
      telegram,
      concurrency: 1,
    });
    try {
      await startHarness(harness);
      telegram.push('/new late-session', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.selectedSession(USER_ID, CHAT_ID) !== null,
      );
      telegram.push('/queue MBTI self-reflection', { date: 2 });
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.database
            .prepare('SELECT COUNT(*) AS count FROM jobs')
            .get()?.count === 1,
      );
      const jobId = jobIdFromOutbox(harness, 'ack');
      await pumpUntil(
        harness,
        () => latestSent(telegram, jobId, '請明確回覆 Flow ID') !== undefined,
      );
      const choice = latestSent(telegram, jobId, '請明確回覆 Flow ID');
      if (choice === undefined) throw new Error('Missing Flow choice prompt.');
      telegram.push('mbti', { date: 2, replyTo: choice.messageId });
      await pumpUntil(harness, () => telegram.blockedMessageId !== null);
      const staleOutbox = harness.resources.store.database
        .prepare(
          "SELECT id, prompt_generation FROM outbox WHERE job_id=? AND kind='prompt' ORDER BY rowid DESC LIMIT 1",
        )
        .get(jobId) as { id: string; prompt_generation: number };
      const oldPromptId = telegram.blockedMessageId;
      if (oldPromptId === null)
        throw new Error('Expected the prompt send to block.');
      telegram.push(`/steer ${jobId} 1=2 2=0 3=null 4=1`, { date: 2 });
      await pumpUntil(harness, () => {
        const row = harness.resources.store.database
          .prepare('SELECT prompt_generation FROM flow_runs WHERE job_id=?')
          .get(jobId) as { prompt_generation: number } | undefined;
        return (
          row !== undefined &&
          row.prompt_generation >= 2 &&
          !harness.resources.store.isOutboxSendable(staleOutbox.id)
        );
      });
      expect(
        harness.resources.store.findPrompt(CHAT_ID, oldPromptId),
      ).toBeNull();
      expect(
        harness.resources.store.database
          .prepare('SELECT status FROM outbox WHERE id=?')
          .get(staleOutbox.id),
      ).toEqual({ status: 'PENDING' });
      const deliveredLatePromptId = telegram.releaseBlockedSend();
      await pumpUntil(
        harness,
        () =>
          harness.resources.store.findPrompt(CHAT_ID, deliveredLatePromptId) !==
          null,
      );
      expect(
        harness.resources.store.findPrompt(CHAT_ID, deliveredLatePromptId),
      ).toMatchObject({
        jobId,
        active: false,
        generation: staleOutbox.prompt_generation,
      });
    } finally {
      if (telegram.blockedMessageId !== null) telegram.releaseBlockedSend();
      await closeHarness(harness);
    }
  });
});
