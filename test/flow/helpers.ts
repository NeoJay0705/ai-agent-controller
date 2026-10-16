import { DatabaseSync } from 'node:sqlite';

import { ControllerStore } from '../../src/controller/store.js';
import type {
  AgentNodeResult,
  AgentRuntime,
  JsonValue,
} from '../../src/flow/types.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import { FlowRegistry } from '../../src/flow/registry.js';
import { FlowStore } from '../../src/flow/store.js';
import type { FlowLimits, FlowRuntime } from '../../src/flow/types.js';
import type { BirthChartInput } from '../../src/flow/natal.js';
import type { MbtiAnswer } from '../../src/flow/mbti.js';
import type { AgentRuntime as AgentRuntimeType } from '../../src/flow/types.js';
import { createSession, USER_ID, CHAT_ID } from '../controller/helpers.js';

export const FLOW_USER_ID = USER_ID;
export const FLOW_CHAT_ID = CHAT_ID;

export const TEST_RUNTIME: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: 'FLOW_TEST_API_KEY',
};

export const TEST_LIMITS: FlowLimits = {
  nodeTimeoutMs: 5_000,
  waitTimeoutMs: 60_000,
  jobTimeoutMs: 120_000,
  maxTransitions: 100,
  maxRetries: 0,
  maxModelTurns: 5,
  maxToolCalls: 1,
  maxOutputChars: 20_000,
};

export function testFlowStore(
  controller: ControllerStore,
  now: () => number = () => 1_000,
  limits = TEST_LIMITS,
): FlowStore {
  return new FlowStore(
    controller,
    new FlowRegistry(
      createFlowBundle({
        runtimes: {
          intake: TEST_RUNTIME,
          mbti: TEST_RUNTIME,
          natal: TEST_RUNTIME,
        },
        limits: { intake: limits, mbti: limits, natal: limits },
      }),
    ),
    { now },
  );
}

export function memoryController(
  now: () => number = () => 1_000,
): ControllerStore {
  return new ControllerStore(new DatabaseSync(':memory:'), { now });
}

export function queueJob(
  controller: ControllerStore,
  input: string,
  options: {
    readonly name?: string;
    readonly ownerId?: string;
    readonly chatId?: string;
  } = {},
): { readonly jobId: string; readonly sessionId: string } {
  const ownerId = options.ownerId ?? FLOW_USER_ID;
  const chatId = options.chatId ?? FLOW_CHAT_ID;
  const sessionId = createSession(
    controller,
    options.name ?? 'flow-test',
    ownerId,
    chatId,
  );
  const jobId = controller.transaction(() =>
    controller.queueJob(ownerId, chatId, input, 100),
  );
  return { jobId, sessionId };
}

export function steer(
  controller: ControllerStore,
  jobId: string,
  content: string,
  options: {
    readonly ownerId?: string;
    readonly chatId?: string;
  } = {},
): string {
  return controller.transaction(() =>
    controller.steerJob(
      options.ownerId ?? FLOW_USER_ID,
      jobId,
      content,
      100,
      options.chatId ?? FLOW_CHAT_ID,
    ),
  );
}

export type FakeResponder = (
  input: Parameters<AgentRuntimeType['run']>[0],
) => AgentNodeResult | Promise<AgentNodeResult>;

export class FakeAgentRuntime implements AgentRuntime {
  readonly calls: Parameters<AgentRuntimeType['run']>[0][] = [];
  disposeCount = 0;
  private readonly responder: FakeResponder;
  private readonly beforeRun:
    | ((input: Parameters<AgentRuntimeType['run']>[0]) => Promise<void>)
    | undefined;

  constructor(
    options: {
      readonly responder?: FakeResponder;
      readonly beforeRun?: (
        input: Parameters<AgentRuntimeType['run']>[0],
      ) => Promise<void>;
    } = {},
  ) {
    this.responder = options.responder ?? defaultFakeResponse;
    this.beforeRun = options.beforeRun;
  }

  async run(
    input: Parameters<AgentRuntime['run']>[0],
  ): Promise<AgentNodeResult> {
    this.calls.push(input);
    await this.beforeRun?.(input);
    if (input.signal.aborted) {
      const error = new Error('FLOW_ABORTED') as Error & { code: string };
      error.code = 'FLOW_ABORTED';
      throw error;
    }
    return await this.responder(input);
  }

  dispose(): Promise<void> {
    this.disposeCount += 1;
    return Promise.resolve();
  }
}

function defaultFakeResponse(
  input: Parameters<AgentRuntime['run']>[0],
): AgentNodeResult {
  if (input.node.resultContract === 'recommendation') {
    const payload = parseObject(input.input);
    const request =
      typeof payload['request'] === 'string' ? payload['request'] : '';
    const updates = Array.isArray(payload['updates'])
      ? payload['updates'].flatMap((item) =>
          isRecord(item) && typeof item['content'] === 'string'
            ? [item['content']]
            : [],
        )
      : [];
    const requestText = [request, ...updates].join('\n').toLowerCase();
    const suggestedFlow = requestText.includes('unavailable')
      ? null
      : requestText.includes('natal') || requestText.includes('星盤')
        ? 'natal'
        : 'mbti';
    return {
      transition: 'ready',
      result: { suggestedFlow },
      text: 'PRIVATE_TEST_RATIONALE',
    };
  }
  if (input.node.resultContract === 'mbti_answers') {
    const payload = parseObject(input.input);
    const ids = Array.isArray(payload['askedQuestionIds'])
      ? payload['askedQuestionIds'].filter(isNumber)
      : [];
    const rawAnswers = Array.isArray(payload['rawAnswers'])
      ? payload['rawAnswers'].flatMap((item) =>
          isRecord(item) && typeof item['text'] === 'string'
            ? [item['text']]
            : [],
        )
      : [];
    const answers: MbtiAnswer[] = ids.flatMap((questionId) => {
      const expression = new RegExp(
        `(?:^|[^0-9])${String(questionId)}\\s*[=:：]\\s*(-2|-1|0|1|2|null)(?=$|\\s|[,，、;；])`,
        'i',
      );
      const match = rawAnswers.join('\n').match(expression);
      if (match === null) return [];
      const value = match[1] === 'null' ? null : Number(match[1]);
      if (value !== null && ![-2, -1, 0, 1, 2].includes(value)) return [];
      return [{ questionId, value: value as MbtiAnswer['value'] }];
    });
    return {
      transition: 'parsed',
      result: { answers } as unknown as JsonValue,
      text: 'PRIVATE_TEST_RATIONALE',
    };
  }
  if (input.node.resultContract === 'birth_input') {
    const payload = parseObject(input.input);
    const text =
      typeof payload['explicitUserText'] === 'string'
        ? payload['explicitUserText']
        : '';
    const result: {
      -readonly [Key in keyof BirthChartInput]?: BirthChartInput[Key];
    } = {};
    const localDate = /(?:date|出生日期)\s*[=:：]\s*(\d{4}-\d{2}-\d{2})/i.exec(
      text,
    )?.[1];
    const localTime = /(?:time|時間)\s*[=:：]\s*(\d{2}:\d{2})/i.exec(text)?.[1];
    const latitude = /(?:lat|latitude|緯度)\s*[=:：]\s*(-?\d+(?:\.\d+)?)/i.exec(
      text,
    )?.[1];
    const longitude =
      /(?:lon|longitude|經度)\s*[=:：]\s*(-?\d+(?:\.\d+)?)/i.exec(text)?.[1];
    const timeZone =
      /(?:zone|timeZone|時區)\s*[=:：]\s*([A-Za-z_+-]+(?:\/[A-Za-z_+-]+)+|UTC)/i.exec(
        text,
      )?.[1];
    const utcOffsetMinutes =
      /(?:offset|utcOffsetMinutes)\s*[=:：]\s*(-?\d+)/i.exec(text)?.[1];
    if (localDate !== undefined) result.localDate = localDate;
    if (localTime !== undefined) result.localTime = localTime;
    if (latitude !== undefined) result.latitude = Number(latitude);
    if (longitude !== undefined) result.longitude = Number(longitude);
    if (timeZone !== undefined) result.timeZone = timeZone;
    if (utcOffsetMinutes !== undefined)
      result.utcOffsetMinutes = Number(utcOffsetMinutes);
    return {
      transition: 'parsed',
      result,
      text: 'PRIVATE_TEST_RATIONALE',
    };
  }
  if (input.node.resultContract === 'interpretation') {
    return {
      transition: 'complete',
      result: {
        summary: '合成解讀摘要。',
        sections: [{ title: '自我反思', content: '合成解讀內容。' }],
      },
      text: 'PRIVATE_TEST_RATIONALE',
    };
  }
  throw new Error('Fake Agent has no deterministic response for this Node.');
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
