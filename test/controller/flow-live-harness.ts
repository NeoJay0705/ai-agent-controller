import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseControllerConfig } from '../../src/controller/config.js';
import { openControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerService } from '../../src/controller/service.js';
import type { ServiceOptions } from '../../src/controller/service.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import type { TelegramUpdate } from '../../src/controller/types.js';
import { PiCliRpcRuntime } from '../../src/flow/pi-rpc-runtime.js';
import type { AgentRuntime } from '../../src/flow/types.js';
import { FlowStore } from '../../src/flow/store.js';
import { effectiveNodeLimits, FlowRegistry } from '../../src/flow/registry.js';
import { loadFlowBundleConfig } from '../../src/flow/config-file.js';

export const SYNTHETIC_USER_ID = '424242';
export const SYNTHETIC_CHAT_ID = '515151';
export const SYNTHETIC_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
export const LIVE_MODEL_CONFIG = resolve(
  process.cwd(),
  'config/pi-flow.oauth.example.json',
);
export const DEFAULT_AGENT_NODE_BUDGET = 12;
export const MAX_AGENT_NODE_BUDGET = 20;
export const MAX_STAGE_MS = 210_000;
export const MAX_SCENARIO_MS = 20 * 60_000;

export type SafeCode =
  | 'LIVE_DISABLED'
  | 'AUTH_PATH_REQUIRED'
  | 'AUTH_PATH_INVALID'
  | 'ARTIFACT_PATH_INVALID'
  | 'AGENT_NODE_BUDGET_INVALID'
  | 'AGENT_NODE_BUDGET_EXCEEDED'
  | 'LIVE_STAGE_TIMEOUT'
  | 'JOB_FAILED'
  | 'TRANSPORT_REJECTED'
  | 'LIVE_ASSERTION_FAILED'
  | 'LIVE_SETUP_FAILED';

export class LiveHarnessError extends Error {
  readonly code: SafeCode;
  readonly stage: string;

  constructor(code: SafeCode, stage: string) {
    super(code);
    this.name = 'LiveHarnessError';
    this.code = code;
    this.stage = stage;
  }
}

export interface SyntheticMessage {
  readonly messageId: number;
  readonly chatId: number;
  readonly text: string;
  readonly kind: string;
}

export interface SyntheticInput {
  readonly updateId: number;
  readonly messageId: number;
  readonly text: string;
  readonly replyTo?: number;
}

/** Only the fixed synthetic Bot API URL and two POST methods are accepted. */
export class MockTelegramTransport {
  readonly methods: string[] = [];
  readonly sent: SyntheticMessage[] = [];
  readonly inputs: SyntheticInput[] = [];
  private readonly updates: TelegramUpdate[] = [];
  private nextUpdateId = 0;
  private nextMessageId = 30_000;
  private stopped = false;
  private readonly pending = new Set<() => void>();
  private readonly token: string;

  constructor(token = SYNTHETIC_TOKEN) {
    this.token = token;
  }

  readonly fetcher: FetchLike = async (input, init) => {
    if (this.stopped)
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    let url: URL;
    try {
      url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
    } catch {
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    }
    const endpoint = url.pathname.split('/').at(-1) ?? '';
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.telegram.org' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== `/bot${this.token}/${endpoint}` ||
      init?.method !== 'POST' ||
      (endpoint !== 'getUpdates' && endpoint !== 'sendMessage')
    ) {
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    }
    this.methods.push(endpoint);
    if (init.signal?.aborted) return new Response('', { status: 200 });
    if (endpoint === 'getUpdates') {
      await this.abortableTurn(init.signal ?? undefined);
      return new Response(
        JSON.stringify({ ok: true, result: this.updates.splice(0) }),
        { status: 200 },
      );
    }
    if (typeof init.body !== 'string')
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    }
    const chatId = body['chat_id'];
    const text = body['text'];
    if (
      typeof chatId !== 'number' ||
      !Number.isSafeInteger(chatId) ||
      ![Number(SYNTHETIC_USER_ID), Number(SYNTHETIC_CHAT_ID)].includes(
        chatId,
      ) ||
      typeof text !== 'string'
    ) {
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    }
    const messageId = ++this.nextMessageId;
    this.sent.push({ messageId, chatId, text, kind: messageKind(text) });
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: messageId, chat: { id: chatId } },
      }),
      { status: 200 },
    );
  };

  push(text: string, replyTo?: number): number {
    if (this.stopped)
      throw new LiveHarnessError('TRANSPORT_REJECTED', 'transport');
    const updateId = ++this.nextUpdateId;
    const messageId = ++this.nextMessageId;
    const input: SyntheticInput = {
      updateId,
      messageId,
      text,
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    this.inputs.push(input);
    this.updates.push({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(SYNTHETIC_CHAT_ID), type: 'private' },
        from: { id: Number(SYNTHETIC_USER_ID) },
        text,
        ...(replyTo === undefined
          ? {}
          : { reply_to_message: { message_id: replyTo } }),
      },
    });
    return messageId;
  }

  stop(): void {
    this.stopped = true;
    for (const abort of [...this.pending]) abort();
    this.pending.clear();
  }

  get pendingTransportCount(): number {
    return this.pending.size;
  }

  private abortableTurn(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted || this.stopped) return Promise.resolve();
    return new Promise((resolveTurn) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.pending.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolveTurn();
      };
      this.pending.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      queueMicrotask(finish);
    });
  }
}

export interface AgentTraceEntry {
  readonly flowId: string;
  readonly nodeId: string;
  readonly contract: string | null;
  readonly startedAt: string;
  endedAt?: string;
  safeErrorCode?: string;
}

/** Counts Agent Node reservations and delegates every call to the real Pi runtime. */
export class RealRuntimeBudget implements AgentRuntime {
  readonly trace: AgentTraceEntry[] = [];
  budgetExceeded = false;
  private activeRuns = 0;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly delegate: PiCliRpcRuntime,
    readonly budget: number,
    private readonly spawnCounter: { value: number },
  ) {}

  get activeOperationCount(): number {
    return this.activeRuns;
  }

  get spawnCount(): number {
    return this.spawnCounter.value;
  }

  async run(input: Parameters<AgentRuntime['run']>[0]) {
    if (this.trace.length >= this.budget) {
      this.budgetExceeded = true;
      throw new LiveHarnessError('AGENT_NODE_BUDGET_EXCEEDED', input.node.id);
    }
    const entry: AgentTraceEntry = {
      flowId: input.definition.id,
      nodeId: input.node.id,
      contract: input.node.resultContract,
      startedAt: new Date().toISOString(),
    };
    this.trace.push(entry);
    this.activeRuns += 1;
    try {
      return await this.delegate.run(input);
    } catch (error) {
      entry.safeErrorCode = safeRuntimeCode(error);
      throw error;
    } finally {
      entry.endedAt = new Date().toISOString();
      this.activeRuns -= 1;
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.delegate.dispose();
    return this.disposePromise;
  }
}

export interface LiveHarness {
  readonly runDir: string;
  readonly config: Extract<
    ReturnType<typeof parseControllerConfig>,
    { mode: 'bot' }
  >;
  readonly resources: Awaited<ReturnType<typeof openControllerResources>>;
  readonly service: ControllerService;
  readonly flowStore: FlowStore;
  readonly telegram: MockTelegramTransport;
  readonly runtime: RealRuntimeBudget;
  readonly report: Record<string, unknown>;
  readonly transcript: {
    readonly inputs: SyntheticInput[];
    readonly sent: SyntheticMessage[];
  };
  start(): void;
  close(): Promise<void>;
}

export function liveGateEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment['PI_FLOW_LIVE_TEST'] === '1';
}

export function parseAgentNodeBudget(value: string | undefined): number {
  if (value === undefined) return DEFAULT_AGENT_NODE_BUDGET;
  if (!/^\d+$/.test(value))
    throw new LiveHarnessError('AGENT_NODE_BUDGET_INVALID', 'gate');
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_AGENT_NODE_BUDGET
  )
    throw new LiveHarnessError('AGENT_NODE_BUDGET_INVALID', 'gate');
  return parsed;
}

export function validateLiveArtifactPath(
  value: string | undefined,
  repoRoot = process.cwd(),
): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value))
    throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'gate');
  const root = resolve(repoRoot, '.test-artifacts/pi-flow/live-model');
  const target = resolve(value);
  const rel = relative(root, target);
  if (
    target === root ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'gate');
  return target;
}

export async function createLiveHarness(options: {
  readonly authFile: string;
  readonly maxAgentNodes?: string;
  readonly artifactRoot?: string;
  readonly onStage?: (
    flow: string,
    stage: string,
    sessionId?: string,
    jobId?: string,
  ) => void;
}): Promise<LiveHarness> {
  const artifactRoot = validateLiveArtifactPath(options.artifactRoot);
  const budget = parseAgentNodeBudget(options.maxAgentNodes);
  if (options.authFile.trim().length === 0 || !isAbsolute(options.authFile))
    throw new LiveHarnessError('AUTH_PATH_REQUIRED', 'gate');
  const liveRoot = resolve(process.cwd(), '.test-artifacts/pi-flow/live-model');
  const rootToCreate = artifactRoot ?? liveRoot;
  await ensurePrivateArtifactDirectory(liveRoot);
  if (rootToCreate !== liveRoot)
    await ensurePrivateArtifactDirectory(rootToCreate);
  const runDir = resolve(rootToCreate, randomUUID());
  if (!runDir.startsWith(`${liveRoot}${sep}`))
    throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'gate');
  await ensurePrivateArtifactDirectory(runDir);
  const authAbsolute = resolve(options.authFile);
  const piDir = resolve(runDir, 'data/pi');
  if (authAbsolute === piDir || authAbsolute.startsWith(`${piDir}${sep}`))
    throw new LiveHarnessError('AUTH_PATH_INVALID', 'gate');

  let resources:
    Awaited<ReturnType<typeof openControllerResources>> | undefined;
  let service: ControllerService | undefined;
  const report: Record<string, unknown> = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: 'real PiCliRpcRuntime with Agent-node counter wrapper; mock Telegram transport',
    modelConfiguration: {
      provider: 'openai',
      model: 'gpt-6-luna',
      thinking: 'max',
      maxModelTurns: 4,
      maxRetries: 0,
    },
    runtime: 'real',
    telegram:
      'mock-only; no global fetch; no HTTP/provider request count observed',
    agentNodeBudget: budget,
    agentNodeHardCap: MAX_AGENT_NODE_BUDGET,
    agentNodesStarted: 0,
    spawnCount: 0,
    mockMessagesSent: 0,
    flows: [],
    cleanup: {
      attempted: false,
      serviceStopped: false,
      pendingTransport: null,
    },
  };
  const telegram = new MockTelegramTransport();
  const transcript = { inputs: telegram.inputs, sent: telegram.sent };
  try {
    const config = parseControllerConfig({
      TELEGRAM_BOT_TOKEN: SYNTHETIC_TOKEN,
      TELEGRAM_ALLOWED_USER_ID: SYNTHETIC_USER_ID,
      PI_FLOW_CONFIG: LIVE_MODEL_CONFIG,
      PI_FLOW_AUTH_FILE: authAbsolute,
      CONTROLLER_DATA_DIR: resolve(runDir, 'data'),
      JOB_CONCURRENCY: '1',
      MAX_PENDING_JOBS: '2',
      MAX_PENDING_STEERING: '20',
    });
    if (config.mode !== 'bot')
      throw new LiveHarnessError('LIVE_SETUP_FAILED', 'config');
    const bundle = await loadFlowBundleConfig(config.flowConfigPath);
    const authPiRoot = resolve(config.dataDir, 'pi');
    if (
      authAbsolute === authPiRoot ||
      authAbsolute.startsWith(`${authPiRoot}${sep}`)
    )
      throw new LiveHarnessError('AUTH_PATH_INVALID', 'gate');
    const registry = new FlowRegistry(bundle);
    for (const flow of bundle.flows) {
      if (flow.limits.maxModelTurns !== 4 || flow.limits.maxRetries !== 0)
        throw new LiveHarnessError('LIVE_SETUP_FAILED', 'model-config');
      for (const node of flow.nodes) {
        if (node.kind === 'agent') {
          const runtime = node.runtime ?? flow.runtime;
          const limits = effectiveNodeLimits(flow, node);
          if (limits.maxModelTurns !== 4 || limits.maxRetries !== 0)
            throw new LiveHarnessError('LIVE_SETUP_FAILED', 'model-config');
          if (
            runtime.provider !== 'openai' ||
            runtime.model !== 'gpt-6-luna' ||
            runtime.thinking !== 'max'
          )
            throw new LiveHarnessError('LIVE_SETUP_FAILED', 'model-config');
        }
      }
    }
    resources = await openControllerResources(config);
    const flowStore = new FlowStore(resources.store, registry);
    const spawnCounter = { value: 0 };
    const real = new PiCliRpcRuntime({
      dataDir: config.dataDir,
      flowStore,
      piAuthFile: authAbsolute,
      onSpawnForTests: () => {
        spawnCounter.value += 1;
      },
    });
    const runtime = new RealRuntimeBudget(real, budget, spawnCounter);
    const opts: ServiceOptions = {
      agentRuntimeForTests: runtime,
      pollIntervalMs: 100,
      outboxIntervalMs: 100,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };
    service = new ControllerService(
      config,
      resources,
      new TelegramClient(config.token, telegram.fetcher),
      bundle,
      opts,
    );
    const onStage = options.onStage;
    const harness: LiveHarness = {
      runDir,
      config,
      resources,
      service,
      flowStore,
      telegram,
      runtime,
      report,
      transcript,
      start: () => service?.start(),
      close: async () => {
        const cleanup = report['cleanup'] as Record<string, unknown>;
        cleanup['attempted'] = true;
        try {
          await service?.stop();
          cleanup['serviceStopped'] = true;
        } catch (error) {
          cleanup['safeErrorCode'] = safeRuntimeCode(error);
        }
        telegram.stop();
        cleanup['pendingTransport'] = telegram.pendingTransportCount;
        report['agentNodesStarted'] = runtime.trace.length;
        report['spawnCount'] = runtime.spawnCount;
        report['mockMessagesSent'] = telegram.sent.length;
        report['agentTrace'] = runtime.trace;
        await savePrivateJson(resolve(runDir, 'transcript.json'), transcript);
        await savePrivateJson(resolve(runDir, 'report.json'), report);
      },
    };
    if (onStage !== undefined) report['stageObserver'] = 'provided';
    return harness;
  } catch (error) {
    telegram.stop();
    let serviceStopped: boolean | null = null;
    if (service !== undefined) {
      try {
        await service.stop();
        serviceStopped = true;
      } catch {
        serviceStopped = false;
      }
    } else if (resources !== undefined) {
      try {
        await resources.close();
        serviceStopped = true;
      } catch {
        serviceStopped = false;
      }
    }
    await Promise.all([
      savePrivateJson(resolve(runDir, 'transcript.json'), transcript),
      savePrivateJson(resolve(runDir, 'report.json'), {
        ...report,
        failure: safeRuntimeCode(error),
        cleanup: {
          attempted: true,
          serviceStopped,
          pendingTransport: telegram.pendingTransportCount,
        },
      }),
    ]);
    throw error instanceof LiveHarnessError
      ? error
      : new LiveHarnessError('LIVE_SETUP_FAILED', 'setup');
  }
}

export async function waitForStage<T>(
  stage: string,
  predicate: () => T | null | undefined | false,
  options: { readonly maxMs?: number; readonly failed?: () => boolean } = {},
): Promise<T> {
  const deadline =
    performance.now() + Math.min(options.maxMs ?? MAX_STAGE_MS, MAX_STAGE_MS);
  while (performance.now() < deadline) {
    if (options.failed?.()) throw new LiveHarnessError('JOB_FAILED', stage);
    const value = predicate();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new LiveHarnessError('LIVE_STAGE_TIMEOUT', stage);
}

const SAFE_RUNTIME_CODES = new Set([
  'FLOW_CREDENTIAL_MISSING',
  'FLOW_AUTH_SOURCE_MISSING',
  'FLOW_AUTH_SOURCE_INVALID',
  'FLOW_AUTH_LOGIN_REQUIRED',
  'FLOW_AUTH_REFRESH_FAILED',
  'FLOW_AUTH_SNAPSHOT_INVALID',
  'FLOW_PROVIDER_UNSUPPORTED',
  'FLOW_SESSION_BUSY',
  'FLOW_SESSION_IDENTITY_INVALID',
  'FLOW_HISTORY_MISSING',
  'FLOW_HISTORY_INVALID',
  'FLOW_HISTORY_LIMIT',
  'FLOW_NODE_TIMEOUT',
  'FLOW_ABORTED',
  'FLOW_MODEL_UNAVAILABLE',
  'UNSUPPORTED_THINKING',
  'FLOW_TOOL_UNAVAILABLE',
  'FLOW_TOOL_FORBIDDEN',
  'FLOW_TOOL_LIMIT',
  'FLOW_MODEL_TURN_LIMIT',
  'FLOW_RETRY_FORBIDDEN',
  'FLOW_CONTEXT_LIMIT',
  'FLOW_OUTPUT_LIMIT',
  'FLOW_OUTPUT_INVALID',
  'FLOW_PROMPT_INVALID',
  'FLOW_PROMPT_NOT_STARTED',
  'FLOW_GUARD_HANDSHAKE_FAILED',
  'FLOW_RPC_CHILD_START_FAILED',
  'FLOW_RPC_CHILD_EXITED',
  'FLOW_RPC_PROTOCOL_FAILED',
  'FLOW_MODEL_REQUEST_FAILED',
  'FLOW_RESULT_INVALID',
  'FLOW_RUNTIME_DISPOSED',
  'FLOW_EXECUTION_FAILED',
  'TIMEOUT',
  'LIVE_STAGE_TIMEOUT',
  'JOB_FAILED',
]);

export function safeRuntimeCode(error: unknown): string {
  if (error instanceof LiveHarnessError) return error.code;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    SAFE_RUNTIME_CODES.has(error.code)
  )
    return error.code;
  return 'LIVE_SETUP_FAILED';
}

async function ensurePrivateArtifactDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const repo = resolve(process.cwd());
  const relativePath = relative(repo, absolute);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'gate');
  let current = repo;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST'))
        throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'artifact-path');
    }
    const metadata = await lstat(current).catch(() => {
      throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'artifact-path');
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'artifact-path');
    if ((await realpath(current)) !== current)
      throw new LiveHarnessError('ARTIFACT_PATH_INVALID', 'artifact-path');
    await chmod(current, 0o700);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function savePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function readSyntheticJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function messageKind(text: string): string {
  if (text.includes('請明確回覆 Flow ID')) return 'flow-choice';
  if (text.includes('原創生活偏好題')) return 'mbti-questions';
  if (text.includes('候選答案')) return 'mbti-candidate';
  if (text.includes('MBTI 自我反思結果')) return 'mbti-result';
  if (text.includes('請提供你本人的完整出生資料')) return 'natal-missing';
  if (text.includes('以下是出生資料候選')) return 'natal-candidate';
  if (text.includes('出生星盤計算結果')) return 'natal-result';
  if (text.includes('Controller is READY')) return 'ready';
  return 'other';
}

export function sentSince(
  telegram: MockTelegramTransport,
  index: number,
): readonly SyntheticMessage[] {
  return telegram.sent.slice(index);
}

export function updateInputCount(telegram: MockTelegramTransport): number {
  return telegram.inputs.length;
}
