import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseControllerConfig } from '../../src/controller/config.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import type {
  AgentRuntime,
  FlowBundle,
  FlowLimits,
  FlowRuntime,
} from '../../src/flow/types.js';
import { ControllerStore } from '../../src/controller/store.js';
import { ControllerService } from '../../src/controller/service.js';
import type { ServiceOptions } from '../../src/controller/service.js';
import type { ControllerResources } from '../../src/controller/lifecycle.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type {
  TelegramMessage,
  TelegramUpdate,
} from '../../src/controller/types.js';

export const TEST_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
export const USER_ID = '424242';
export const CHAT_ID = '515151';

export const TEST_FLOW_RUNTIME: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: 'FLOW_TEST_API_KEY',
};

export const TEST_FLOW_LIMITS: FlowLimits = {
  nodeTimeoutMs: 5_000,
  waitTimeoutMs: 60_000,
  jobTimeoutMs: 120_000,
  maxTransitions: 120,
  maxRetries: 0,
  maxModelTurns: 4,
  maxToolCalls: 1,
  maxOutputChars: 20_000,
};

export function testFlowBundle(): FlowBundle {
  return createFlowBundle({
    runtimes: {
      intake: TEST_FLOW_RUNTIME,
      mbti: TEST_FLOW_RUNTIME,
      natal: TEST_FLOW_RUNTIME,
    },
    limits: {
      intake: { ...TEST_FLOW_LIMITS, maxToolCalls: 0 },
      mbti: { ...TEST_FLOW_LIMITS, maxToolCalls: 0 },
      natal: TEST_FLOW_LIMITS,
    },
  });
}

export const UNSUPPORTED_AGENT_RUNTIME: AgentRuntime = {
  run() {
    return Promise.resolve({
      transition: 'ready',
      result: { suggestedFlow: null },
    });
  },
  async dispose() {},
};

export function testControllerService(
  config: Extract<ReturnType<typeof parseControllerConfig>, { mode: 'bot' }>,
  resources: ControllerResources,
  telegram: TelegramClient,
  options: ServiceOptions = {},
): ControllerService {
  return new ControllerService(config, resources, telegram, testFlowBundle(), {
    ...options,
    agentRuntimeForTests:
      options.agentRuntimeForTests ?? UNSUPPORTED_AGENT_RUNTIME,
  });
}

export function testConfig(
  overrides: Readonly<Record<string, string | undefined>> = {},
  cwd = process.cwd(),
): Extract<ReturnType<typeof parseControllerConfig>, { readonly mode: 'bot' }> {
  const config = parseControllerConfig(
    {
      TELEGRAM_BOT_TOKEN: TEST_TOKEN,
      TELEGRAM_ALLOWED_USER_ID: USER_ID,
      PI_FLOW_CONFIG: resolve(process.cwd(), 'config/pi-flow.example.json'),
      CONTROLLER_DATA_DIR: '.test-artifacts/config-data',
      ...overrides,
    },
    cwd,
  );
  if (config.mode !== 'bot')
    throw new Error('Bot test configuration is required.');
  return config;
}

export function memoryStore(
  options: {
    now?: () => number;
    id?: (kind: string) => string;
  } = {},
): ControllerStore {
  return new ControllerStore(new DatabaseSync(':memory:'), options);
}

export function makeUpdate(
  updateId: number,
  text: string | undefined,
  options: {
    userId?: number;
    chatId?: number;
    chatType?: string;
    replyTo?: number;
    date?: unknown;
    includeMessage?: boolean;
  } = {},
): TelegramUpdate {
  if (options.includeMessage === false) return { update_id: updateId };
  const message: TelegramMessage = {
    message_id: updateId + 1000,
    date: options.date === undefined ? 2_000_000_000 : options.date,
    chat: {
      id: options.chatId ?? Number(CHAT_ID),
      type: options.chatType ?? 'private',
    },
    ...(options.userId === undefined
      ? { from: { id: Number(USER_ID) } }
      : { from: { id: options.userId } }),
    ...(text === undefined ? {} : { text }),
    ...(options.replyTo === undefined
      ? {}
      : { reply_to_message: { message_id: options.replyTo } }),
  };
  return { update_id: updateId, message };
}

export function createSession(
  store: ControllerStore,
  name = 'main',
  owner = USER_ID,
  chat = CHAT_ID,
): string {
  return store.transaction(() => store.createSession(owner, chat, name).id);
}

export function artifactsPath(name: string): string {
  return resolve(
    process.cwd(),
    '.test-artifacts',
    `${name}-${randomUUID()}.sqlite`,
  );
}

export async function ensureArtifactsDirectory(): Promise<void> {
  await mkdir(resolve(process.cwd(), '.test-artifacts'), {
    recursive: true,
    mode: 0o700,
  });
}

export async function removeDatabaseArtifacts(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

export async function flushTasks(): Promise<void> {
  await new Promise<void>((resolveTask) => setImmediate(resolveTask));
}

export async function waitUntil(
  condition: () => boolean,
  attempts = 50,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return;
    await flushTasks();
  }
  throw new Error('Condition was not reached within controlled task turns.');
}
