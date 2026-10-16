import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { Type } from 'typebox';
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';

import { calculateNatalChart, validateBirthChartInput } from './natal.js';
import type { FlowLimits, JsonValue } from './types.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_AUTH_SNAPSHOT_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MIN_OAUTH_VALIDITY_MS = 5 * 60 * 1000;
const MAX_READY_BYTES = 4096;
const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+\S+/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  cohere: 'COHERE_API_KEY',
};

interface GuardConfig {
  readonly version: 1;
  readonly nonce: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly tools: readonly string[];
  readonly effectiveLimits: FlowLimits;
  readonly auth?: {
    readonly mode: 'pi-login';
    readonly expiresAt: number;
  };
  readonly node: {
    readonly id: string;
    readonly resultContract: string | null;
    readonly transitions: readonly string[];
  };
}

interface JobData {
  readonly tag: 'flow-job-data';
  readonly input: string;
  readonly state: JsonValue;
  readonly historyFacts: readonly JsonValue[];
}

const NATAL_TOOL_PARAMETERS = Type.Object({}, { additionalProperties: false });
const NATAL_TOOL_OUTPUT = Type.Object(
  { chart: Type.Unknown() },
  { additionalProperties: false },
);

export default async function flowHostGuard(pi: ExtensionAPI): Promise<void> {
  const path = process.env['PI_FLOW_GUARD_CONFIG'];
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('FLOW_GUARD_CONFIG_INVALID');
  }
  const config = await readGuardConfig(path);
  const providerKeyName = PROVIDER_KEY_ENV[config.provider];
  if (config.auth === undefined && providerKeyName === undefined) {
    throw new Error('FLOW_GUARD_CONFIG_INVALID');
  }
  const currentCredential =
    config.auth === undefined
      ? (process.env[providerKeyName ?? ''] ?? '')
      : await readPrivateOAuthSnapshot(config);
  const allowedTools = new Set(config.tools);
  let failureCode: GuardFailureCode | undefined;
  let failureNotificationSent = false;
  let jobData: JobData | undefined;
  let turnCount = 0;
  let toolCallCount = 0;
  let outputChars = 0;

  const fail = (code: GuardFailureCode, context: ExtensionContext): void => {
    if (failureCode === undefined) failureCode = code;
    if (!failureNotificationSent) {
      failureNotificationSent = true;
      context.ui.notify(
        JSON.stringify({
          tag: 'flow-host-failure',
          nonce: config.nonce,
          code: failureCode,
        }),
        'error',
      );
    }
    context.abort();
  };
  const modelAndToolsMatch = (context: ExtensionContext): boolean => {
    const model = context.model;
    const tools = pi.getActiveTools().sort();
    return (
      context.mode === 'rpc' &&
      model?.provider === config.provider &&
      model.id === config.model &&
      context.thinkingLevel === config.thinking &&
      JSON.stringify(tools) === JSON.stringify([...config.tools].sort())
    );
  };

  if (allowedTools.has('calculate_natal_chart')) {
    pi.registerTool({
      name: 'calculate_natal_chart',
      label: 'Calculate natal chart',
      description:
        'Calculate a natal chart only from the current, host-provided confirmed birth input.',
      parameters: NATAL_TOOL_PARAMETERS,
      outputSchema: NATAL_TOOL_OUTPUT,
      exposure: 'direct',
      executionMode: 'sequential',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      async execute(_toolCallId, _params, signal, _onUpdate, context) {
        await Promise.resolve();
        if (
          failureCode !== undefined ||
          signal?.aborted ||
          jobData === undefined ||
          !allowedTools.has('calculate_natal_chart')
        ) {
          const code = failureCode ?? 'FLOW_TOOL_INPUT_INVALID';
          fail(code, context);
          throw new Error(code);
        }
        if (toolCallCount > config.effectiveLimits.maxToolCalls) {
          fail('FLOW_TOOL_LIMIT', context);
          throw new Error('FLOW_TOOL_LIMIT');
        }
        let rawInput: unknown;
        try {
          rawInput = JSON.parse(jobData.input) as unknown;
        } catch {
          fail('FLOW_TOOL_INPUT_INVALID', context);
          throw new Error('FLOW_TOOL_INPUT_INVALID');
        }
        let validatedInput;
        try {
          validatedInput = validateBirthChartInput(rawInput);
        } catch {
          fail('FLOW_TOOL_INPUT_INVALID', context);
          throw new Error('FLOW_TOOL_INPUT_INVALID');
        }
        let chart;
        try {
          chart = calculateNatalChart(validatedInput);
        } catch {
          fail('FLOW_TOOL_INPUT_INVALID', context);
          throw new Error('FLOW_TOOL_INPUT_INVALID');
        }
        const text = JSON.stringify({ chart });
        outputChars += text.length;
        if (
          text.length > config.effectiveLimits.maxOutputChars ||
          outputChars > config.effectiveLimits.maxOutputChars ||
          hasCredential(text, currentCredential)
        ) {
          fail('FLOW_TOOL_OUTPUT_LIMIT', context);
          throw new Error('FLOW_TOOL_OUTPUT_LIMIT');
        }
        const structuredContent = JSON.parse(text) as JsonValue;
        return {
          content: [{ type: 'text', text }],
          details: { chart },
          structuredContent,
        };
      },
    });
  }

  pi.on('session_start', (_event, context) => {
    if (!settingsAreSafe(pi.getSettings())) return;
    const model = context.model;
    const activeTools = pi.getActiveTools().sort();
    const toolMetadata = pi
      .getAllTools()
      .filter((tool) => activeTools.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: tool.exposure,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const message = JSON.stringify({
      tag: 'flow-host-ready',
      nonce: config.nonce,
      tools: activeTools,
      toolMetadata,
      provider: model?.provider ?? '',
      model: model?.id ?? '',
      thinking: context.thinkingLevel ?? '',
    });
    if (Buffer.byteLength(message, 'utf8') > MAX_READY_BYTES) return;
    context.ui.notify(message, 'info');
  });

  pi.on('before_provider_request', (_event, context) => {
    if (config.auth !== undefined && !oauthSnapshotHasValidity(config)) {
      fail('FLOW_AUTH_SNAPSHOT_INVALID', context);
    }
  });

  pi.on('before_agent_start', (event, context) => {
    if (config.auth !== undefined && !oauthSnapshotHasValidity(config)) {
      fail('FLOW_AUTH_SNAPSHOT_INVALID', context);
      return;
    }
    if (!modelAndToolsMatch(context)) {
      fail('FLOW_MODEL_UNAVAILABLE', context);
      return;
    }
    if (event.messageType !== 'user') {
      jobData = undefined;
      fail('FLOW_PROMPT_INVALID', context);
      return;
    }
    const marker = 'FLOW_JOB_DATA_JSON:';
    const markerIndex = event.prompt.indexOf(marker);
    if (
      markerIndex < 0 ||
      event.prompt.indexOf(marker, markerIndex + marker.length) >= 0
    ) {
      jobData = undefined;
      fail('FLOW_PROMPT_INVALID', context);
      return;
    }
    const raw = event.prompt.slice(markerIndex + marker.length);
    const parsed = parseJobData(raw, currentCredential);
    if (parsed === undefined) {
      jobData = undefined;
      fail('FLOW_PROMPT_INVALID', context);
      return;
    }
    jobData = parsed;
    failureCode = undefined;
    failureNotificationSent = false;
    turnCount = 0;
    toolCallCount = 0;
    outputChars = 0;
  });

  pi.on('turn_start', (_event, context) => {
    if (!modelAndToolsMatch(context)) {
      fail('FLOW_MODEL_UNAVAILABLE', context);
      return;
    }
    turnCount += 1;
    if (turnCount > config.effectiveLimits.maxModelTurns) {
      fail('FLOW_MODEL_TURN_LIMIT', context);
    }
  });

  pi.on('session_before_compact', (_event, context) => {
    failureCode ??= 'FLOW_CONTEXT_LIMIT';
    context.abort();
    return { cancel: true };
  });
  pi.on('session_compact', (_event, context) => {
    fail('FLOW_CONTEXT_LIMIT', context);
  });
  pi.on('session_compact_failed', (_event, context) => {
    fail('FLOW_CONTEXT_LIMIT', context);
  });

  pi.on('message_update', (event, context) => {
    if (event.message.role !== 'assistant') return;
    const update = event.assistantMessageEvent;
    if (
      update.type === 'text_delta' ||
      update.type === 'thinking_delta' ||
      update.type === 'toolcall_delta'
    ) {
      outputChars += update.delta.length;
      if (outputChars > config.effectiveLimits.maxOutputChars) {
        fail('FLOW_OUTPUT_LIMIT', context);
      }
    }
  });

  pi.on('message_end', (event, context) => {
    const message = event.message;
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const serialized = safeStringify(message);
    const hasSecret = hasCredential(serialized, currentCredential);
    const assistant = message.role === 'assistant';
    const providerError =
      assistant &&
      (message.stopReason === 'error' ||
        (typeof message.errorMessage === 'string' &&
          message.errorMessage.length > 0));
    let code: GuardFailureCode | undefined;
    if (hasSecret) code = 'FLOW_OUTPUT_INVALID';
    else if (providerError) code = 'FLOW_MODEL_REQUEST_FAILED';
    else if (failureCode !== undefined) code = failureCode;
    if (code === undefined) return;
    fail(code, context);
    return {
      message: redactMessage(message, code),
    };
  });

  pi.on('tool_call', (event, context) => {
    const error = validateToolCall(event, allowedTools, config, toolCallCount);
    if (error === undefined) {
      toolCallCount += 1;
      return;
    }
    fail(error, context);
    return { block: true, terminate: true, reason: error };
  });

  pi.on('tool_result', (event, context) => {
    const error = validateToolResult(
      event,
      currentCredential,
      config.effectiveLimits.maxOutputChars,
    );
    if (error === undefined) return;
    fail(error, context);
    return {
      content: [{ type: 'text', text: error }],
      details: undefined,
      structuredContent: null,
      isError: true,
    };
  });

  pi.on('agent_settled', () => {
    jobData = undefined;
  });
}

type GuardFailureCode =
  | 'FLOW_MODEL_UNAVAILABLE'
  | 'FLOW_PROMPT_INVALID'
  | 'FLOW_OUTPUT_INVALID'
  | 'FLOW_MODEL_REQUEST_FAILED'
  | 'FLOW_AUTH_SNAPSHOT_INVALID'
  | 'FLOW_MODEL_TURN_LIMIT'
  | 'FLOW_CONTEXT_LIMIT'
  | 'FLOW_RETRY_FORBIDDEN'
  | 'FLOW_OUTPUT_LIMIT'
  | 'FLOW_TOOL_FORBIDDEN'
  | 'FLOW_TOOL_LIMIT'
  | 'FLOW_TOOL_INPUT_INVALID'
  | 'FLOW_TOOL_OUTPUT_LIMIT';

async function readGuardConfig(path: string): Promise<GuardConfig> {
  try {
    const metadata = await lstat(path);
    const actual = await realpath(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      actual !== resolve(path) ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > MAX_CONFIG_BYTES
    ) {
      throw new Error('FLOW_GUARD_CONFIG_INVALID');
    }
    const source = await readFile(actual, 'utf8');
    const config = JSON.parse(source) as unknown;
    if (!isGuardConfig(config)) throw new Error('FLOW_GUARD_CONFIG_INVALID');
    return config;
  } catch {
    throw new Error('FLOW_GUARD_CONFIG_INVALID');
  }
}

function isGuardConfig(value: unknown): value is GuardConfig {
  if (
    !isRecord(value) ||
    !hasOptionalExactKeys(
      value,
      [
        'version',
        'nonce',
        'provider',
        'model',
        'thinking',
        'tools',
        'effectiveLimits',
        'auth',
        'node',
      ],
      ['auth'],
    ) ||
    value['version'] !== 1 ||
    typeof value['nonce'] !== 'string' ||
    !/^[A-Za-z0-9_-]{20,80}$/.test(value['nonce']) ||
    typeof value['provider'] !== 'string' ||
    typeof value['model'] !== 'string' ||
    typeof value['thinking'] !== 'string' ||
    !Array.isArray(value['tools']) ||
    value['tools'].some((tool) => tool !== 'calculate_natal_chart') ||
    new Set(value['tools']).size !== value['tools'].length ||
    !isRecord(value['effectiveLimits']) ||
    !isRecord(value['node'])
  ) {
    return false;
  }
  const limits = value['effectiveLimits'];
  const limitKeys = [
    'nodeTimeoutMs',
    'waitTimeoutMs',
    'jobTimeoutMs',
    'maxTransitions',
    'maxRetries',
    'maxModelTurns',
    'maxToolCalls',
    'maxOutputChars',
  ];
  if (!hasExactKeys(limits, limitKeys)) return false;
  if (
    limitKeys.some(
      (key) =>
        typeof limits[key] !== 'number' ||
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < (key === 'maxRetries' || key === 'maxToolCalls' ? 0 : 1),
    )
  ) {
    return false;
  }
  const auth = value['auth'];
  if (
    auth !== undefined &&
    (!isRecord(auth) ||
      !hasExactKeys(auth, ['mode', 'expiresAt']) ||
      auth['mode'] !== 'pi-login' ||
      typeof auth['expiresAt'] !== 'number' ||
      !Number.isSafeInteger(auth['expiresAt']) ||
      auth['expiresAt'] <= 0)
  ) {
    return false;
  }
  const node = value['node'];
  return (
    hasExactKeys(node, ['id', 'resultContract', 'transitions']) &&
    typeof node['id'] === 'string' &&
    (typeof node['resultContract'] === 'string' ||
      node['resultContract'] === null) &&
    Array.isArray(node['transitions']) &&
    node['transitions'].every((transition) => typeof transition === 'string')
  );
}

function settingsAreSafe(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  const retry = settings['retry'];
  const compaction = settings['compaction'];
  if (
    !isRecord(retry) ||
    !isRecord(retry['provider']) ||
    !isRecord(compaction)
  ) {
    return false;
  }
  return (
    settings['cacheWarming'] === 'off' &&
    compaction['enabled'] === false &&
    retry['enabled'] === false &&
    retry['maxRetries'] === 0 &&
    retry['baseDelayMs'] === 0 &&
    retry['maxAgentDelayMs'] === 0 &&
    retry['provider']['maxRetries'] === 0 &&
    retry['provider']['maxRetryDelayMs'] === 0
  );
}

function parseJobData(raw: string, credential: string): JobData | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['tag', 'input', 'state', 'historyFacts']) ||
    parsed['tag'] !== 'flow-job-data' ||
    typeof parsed['input'] !== 'string' ||
    !Array.isArray(parsed['historyFacts']) ||
    hasCredential(raw, credential)
  ) {
    return undefined;
  }
  return parsed as unknown as JobData;
}

function validateToolCall(
  event: ToolCallEvent,
  allowedTools: ReadonlySet<string>,
  config: GuardConfig,
  previousCalls: number,
): GuardFailureCode | undefined {
  if (
    !allowedTools.has(event.toolName) ||
    !config.tools.includes(event.toolName) ||
    event.parentToolCallId !== undefined
  ) {
    return 'FLOW_TOOL_FORBIDDEN';
  }
  if (previousCalls >= config.effectiveLimits.maxToolCalls) {
    return 'FLOW_TOOL_LIMIT';
  }
  if (
    event.toolName === 'calculate_natal_chart' &&
    Object.keys(event.input).length !== 0
  ) {
    return 'FLOW_TOOL_INPUT_INVALID';
  }
  return undefined;
}

function validateToolResult(
  event: ToolResultEvent,
  credential: string,
  outputLimit: number,
): GuardFailureCode | undefined {
  const serialized = safeStringify({
    content: event.content,
    details: event.details,
    structuredContent: event.structuredContent,
  });
  if (hasCredential(serialized, credential)) return 'FLOW_OUTPUT_INVALID';
  if (
    serialized.length > outputLimit ||
    (event.isError && serialized.length > outputLimit)
  ) {
    return 'FLOW_TOOL_OUTPUT_LIMIT';
  }
  return undefined;
}

function redactMessage(
  message: MessageEndEvent['message'],
  code: GuardFailureCode,
): MessageEndEvent['message'] {
  const safe = { ...message } as Record<string, unknown>;
  delete safe['errorMessage'];
  if (message.role === 'user') {
    safe['content'] = '[flow input redacted]';
  } else if (message.role === 'assistant') {
    safe['content'] = [{ type: 'text', text: '[flow output redacted]' }];
    safe['stopReason'] = 'error';
    safe['errorMessage'] = code;
  }
  return safe as unknown as MessageEndEvent['message'];
}

async function readPrivateOAuthSnapshot(config: GuardConfig): Promise<string> {
  const agentDirectory = process.env['PI_CODING_AGENT_DIR'];
  if (
    config.auth === undefined ||
    typeof agentDirectory !== 'string' ||
    !isAbsolute(agentDirectory) ||
    resolve(agentDirectory) !== agentDirectory
  ) {
    throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
  }
  const authPath = join(agentDirectory, 'auth.json');
  let handle;
  try {
    const parent = await lstat(agentDirectory, { bigint: true });
    if (
      parent.isSymbolicLink() ||
      !parent.isDirectory() ||
      (parent.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE) ||
      (typeof process.getuid === 'function' &&
        parent.uid !== BigInt(process.getuid())) ||
      (await realpath(agentDirectory)) !== agentDirectory
    ) {
      throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
    }
    const beforePath = await lstat(authPath, { bigint: true });
    if (
      beforePath.isSymbolicLink() ||
      !beforePath.isFile() ||
      (beforePath.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      beforePath.size > BigInt(MAX_AUTH_SNAPSHOT_BYTES) ||
      (typeof process.getuid === 'function' &&
        beforePath.uid !== BigInt(process.getuid())) ||
      (await realpath(authPath)) !== authPath
    ) {
      throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
    }
    handle = await open(
      authPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(MAX_AUTH_SNAPSHOT_BYTES) ||
      (before.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      (typeof process.getuid === 'function' &&
        before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
    }
    const buffer = Buffer.allocUnsafe(MAX_AUTH_SNAPSHOT_BYTES + 1);
    let offset = 0;
    try {
      while (offset < buffer.byteLength) {
        const length = Math.min(64 * 1024, buffer.byteLength - offset);
        const { bytesRead } = await handle.read(buffer, offset, length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const afterPath = await lstat(authPath, { bigint: true });
      if (
        offset > MAX_AUTH_SNAPSHOT_BYTES ||
        after.size > BigInt(MAX_AUTH_SNAPSHOT_BYTES) ||
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        BigInt(offset) !== after.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.mode !== before.mode ||
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        afterPath.dev !== after.dev ||
        afterPath.ino !== after.ino ||
        afterPath.size !== after.size ||
        afterPath.mtimeNs !== after.mtimeNs ||
        afterPath.ctimeNs !== after.ctimeNs ||
        afterPath.mode !== after.mode ||
        (typeof process.getuid === 'function' &&
          after.uid !== BigInt(process.getuid()))
      ) {
        throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, offset),
        );
      } catch {
        throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      let value: unknown;
      try {
        value = JSON.parse(source) as unknown;
      } catch {
        throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [config.provider]) ||
        !isRecord(value[config.provider])
      ) {
        throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      const credentialValue = value[config.provider];
      if (!isRecord(credentialValue)) {
        throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      const credential = credentialValue;
      if (
        credential['type'] !== 'oauth' ||
        typeof credential['access'] !== 'string' ||
        credential['access'].length === 0 ||
        credential['access'].length > 65_536 ||
        credential['refresh'] !== '' ||
        typeof credential['expires'] !== 'number' ||
        !Number.isSafeInteger(credential['expires']) ||
        credential['expires'] !== config.auth.expiresAt ||
        !oauthSnapshotHasValidity(config)
      ) {
        throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      return credential['access'];
    } finally {
      buffer.fill(0);
    }
  } catch {
    throw new Error('FLOW_AUTH_SNAPSHOT_INVALID');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function oauthSnapshotHasValidity(config: GuardConfig): boolean {
  if (config.auth === undefined) return true;
  const minimumValidity = Math.max(
    MIN_OAUTH_VALIDITY_MS,
    config.effectiveLimits.nodeTimeoutMs + 60_000,
  );
  return config.auth.expiresAt > Date.now() + minimumValidity;
}

function hasCredential(value: string, credential: string): boolean {
  return (
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)) ||
    (credential.length > 0 && value.includes(credential))
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[invalid]';
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function hasOptionalExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = keys.filter((key) =>
    optional.includes(key) ? value[key] !== undefined : true,
  );
  return hasExactKeys(value, allowed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
