import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import flowHostGuard from '../../src/flow/pi-rpc-guard.js';

const TEST_ROOT = resolve('.test-artifacts/pi-flow');
const SYNTHETIC_KEY = 'synthetic-only-flow-key';
const SYNTHETIC_OAUTH_ACCESS = 'synthetic-oauth-access-for-guard';
const TEST_NONCE = 'synthetic-guard-nonce-0123456789';
const roots: string[] = [];

interface GuardTestOverrides {
  readonly tools?: readonly string[];
  readonly effectiveLimits?: {
    readonly maxModelTurns?: number;
    readonly maxOutputChars?: number;
  };
  readonly auth?: {
    readonly mode: 'pi-login';
    readonly expiresAt: number;
  };
}

interface FakeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly exposure: string;
}

type CapturedHandler = (event: unknown, context: FakeContext) => unknown;

class FakeExtensionAPI {
  readonly handlers = new Map<string, CapturedHandler[]>();
  readonly tools = new Map<string, FakeTool>();
  readonly registeredFlags: string[] = [];
  readonly requestedFlags: string[] = [];
  readonly activeTools: string[] = [];

  registerFlag(name: string): void {
    this.registeredFlags.push(name);
  }

  getFlag(name: string): undefined {
    this.requestedFlags.push(name);
    return undefined;
  }

  registerTool(tool: FakeTool): void {
    this.tools.set(tool.name, tool);
    this.activeTools.push(tool.name);
  }

  getAllTools(): readonly FakeTool[] {
    return [...this.tools.values()];
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  getSettings(): Record<string, unknown> {
    return {
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: {
        enabled: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxAgentDelayMs: 0,
        provider: { maxRetries: 0, maxRetryDelayMs: 0 },
      },
    };
  }

  on(event: string, handler: CapturedHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  invoke(event: string, payload: unknown, context: FakeContext): unknown {
    const handler = this.handlers.get(event)?.[0];
    if (handler === undefined)
      throw new Error(`Missing captured ${event} handler.`);
    return handler(payload, context);
  }
}

class FakeContext {
  readonly notifications: Array<{
    readonly message: string;
    readonly type: string;
  }> = [];
  aborted = false;
  model: { provider: string; id: string } | undefined = {
    provider: 'openai',
    id: 'gpt-6-luna',
  };
  mode = 'rpc';
  thinkingLevel = 'max';

  readonly ui = {
    notify: (message: string, type: string): void => {
      this.notifications.push({ message, type });
    },
  };

  abort(): void {
    this.aborted = true;
  }
}

afterEach(async () => {
  delete process.env['PI_FLOW_GUARD_CONFIG'];
  delete process.env['OPENAI_API_KEY'];
  delete process.env['PI_CODING_AGENT_DIR'];
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('Pi RPC host guard extension', () => {
  it('requires the explicit private child environment path and does not use extension flags', async () => {
    delete process.env['PI_FLOW_GUARD_CONFIG'];
    const api = new FakeExtensionAPI();
    await expect(flowHostGuard(api as unknown as ExtensionAPI)).rejects.toThrow(
      'FLOW_GUARD_CONFIG_INVALID',
    );
    expect(api.registeredFlags).toEqual([]);
    expect(api.requestedFlags).toEqual([]);
  });

  it('rejects a non-private guard file and a symlinked guard file', async () => {
    const root = await createTestRoot();
    const unsafePath = join(root, 'unsafe.json');
    const validConfig = JSON.stringify(createGuardConfig());
    await writeFile(unsafePath, validConfig, { mode: 0o644 });
    await chmod(unsafePath, 0o644);
    process.env['PI_FLOW_GUARD_CONFIG'] = unsafePath;
    await expect(
      flowHostGuard(new FakeExtensionAPI() as unknown as ExtensionAPI),
    ).rejects.toThrow('FLOW_GUARD_CONFIG_INVALID');

    const privatePath = join(root, 'private.json');
    await writePrivateConfig(privatePath, validConfig);
    const symlinkPath = join(root, 'guard-link.json');
    await symlink(privatePath, symlinkPath);
    process.env['PI_FLOW_GUARD_CONFIG'] = symlinkPath;
    await expect(
      flowHostGuard(new FakeExtensionAPI() as unknown as ExtensionAPI),
    ).rejects.toThrow('FLOW_GUARD_CONFIG_INVALID');
  });

  it('emits a nonce-bound ready message with the actual selected tool metadata', async () => {
    const { configPath, config } = await installConfig({
      tools: ['calculate_natal_chart'],
    });
    process.env['PI_FLOW_GUARD_CONFIG'] = configPath;
    process.env['OPENAI_API_KEY'] = SYNTHETIC_KEY;
    const api = new FakeExtensionAPI();
    await flowHostGuard(api as unknown as ExtensionAPI);
    const context = new FakeContext();

    api.invoke('session_start', { type: 'session_start' }, context);

    expect(api.registeredFlags).toEqual([]);
    expect(api.requestedFlags).toEqual([]);
    expect(context.notifications).toHaveLength(1);
    const ready = JSON.parse(context.notifications[0]?.message ?? 'null') as {
      tag: string;
      nonce: string;
      tools: string[];
      toolMetadata: FakeTool[];
      provider: string;
      model: string;
      thinking: string;
    };
    expect(ready).toMatchObject({
      tag: 'flow-host-ready',
      nonce: config.nonce,
      tools: ['calculate_natal_chart'],
      provider: 'openai',
      model: 'gpt-6-luna',
      thinking: 'max',
    });
    expect(ready.toolMetadata).toHaveLength(1);
    expect(ready.toolMetadata[0]).toMatchObject({
      name: 'calculate_natal_chart',
      exposure: 'direct',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it('fails closed for exact model and exact thinking mismatches', async () => {
    const { api } = await createGuard();
    const context = new FakeContext();
    context.model = { provider: 'openai', id: 'different-model' };
    api.invoke('before_agent_start', validUserEvent(), context);
    expect(readFailure(context)).toBe('FLOW_MODEL_UNAVAILABLE');
    expect(context.aborted).toBe(true);

    const second = await createGuard();
    const wrongThinking = new FakeContext();
    wrongThinking.thinkingLevel = 'high';
    second.api.invoke('before_agent_start', validUserEvent(), wrongThinking);
    expect(readFailure(wrongThinking)).toBe('FLOW_MODEL_UNAVAILABLE');

    const third = await createGuard();
    const readyContext = new FakeContext();
    third.api.invoke('session_start', { type: 'session_start' }, readyContext);
    const ready = JSON.parse(
      readyContext.notifications[0]?.message ?? 'null',
    ) as { nonce: string };
    expect(ready.nonce).toBe(TEST_NONCE);
  });

  it('blocks undeclared tool calls and enforces turn and output limits', async () => {
    const toolGuard = await createGuard({ tools: [] });
    const toolContext = new FakeContext();
    const blocked = toolGuard.api.invoke(
      'tool_call',
      {
        type: 'tool_call',
        toolName: 'unregistered_tool',
        toolCallId: 'synthetic-call-id',
        input: {},
      },
      toolContext,
    ) as { block: boolean; terminate: boolean; reason: string };
    expect(blocked).toEqual({
      block: true,
      terminate: true,
      reason: 'FLOW_TOOL_FORBIDDEN',
    });
    expect(readFailure(toolContext)).toBe('FLOW_TOOL_FORBIDDEN');

    const counterGuard = await createGuard({
      effectiveLimits: { maxModelTurns: 1, maxOutputChars: 4 },
    });
    const turnContext = new FakeContext();
    counterGuard.api.invoke('turn_start', { type: 'turn_start' }, turnContext);
    counterGuard.api.invoke('turn_start', { type: 'turn_start' }, turnContext);
    expect(readFailure(turnContext)).toBe('FLOW_MODEL_TURN_LIMIT');

    const toolLimitGuard = await createGuard({
      tools: ['calculate_natal_chart'],
    });
    const toolLimitContext = new FakeContext();
    const allowedCall = {
      type: 'tool_call',
      toolName: 'calculate_natal_chart',
      toolCallId: 'synthetic-call-id',
      input: {},
    };
    expect(
      toolLimitGuard.api.invoke('tool_call', allowedCall, toolLimitContext),
    ).toBeUndefined();
    const blockedCall = toolLimitGuard.api.invoke(
      'tool_call',
      allowedCall,
      toolLimitContext,
    ) as { reason: string };
    expect(blockedCall.reason).toBe('FLOW_TOOL_LIMIT');
    expect(readFailure(toolLimitContext)).toBe('FLOW_TOOL_LIMIT');

    const outputGuard = await createGuard({
      effectiveLimits: { maxModelTurns: 1, maxOutputChars: 4 },
    });
    const outputContext = new FakeContext();
    outputGuard.api.invoke(
      'message_update',
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: '12345' },
      },
      outputContext,
    );
    expect(readFailure(outputContext)).toBe('FLOW_OUTPUT_LIMIT');
  });

  it('loads only the private OAuth snapshot and redacts its access token', async () => {
    const { api } = await createOAuthGuard();
    const context = new FakeContext();
    api.invoke('before_agent_start', validUserEvent(), context);
    expect(context.aborted).toBe(false);

    const replacement = api.invoke(
      'message_end',
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: SYNTHETIC_OAUTH_ACCESS }],
          provider: 'openai',
          model: 'gpt-6-luna',
          stopReason: 'stop',
        },
      },
      context,
    ) as { message: Record<string, unknown> };
    expect(readFailure(context)).toBe('FLOW_OUTPUT_INVALID');
    expect(JSON.stringify(replacement)).not.toContain(SYNTHETIC_OAUTH_ACCESS);
  });

  it('blocks an OAuth request when the snapshot expires during the child run', async () => {
    const { api, config } = await createOAuthGuard();
    const context = new FakeContext();
    vi.spyOn(Date, 'now').mockReturnValue(config.expiresAt + 1);

    api.invoke(
      'before_provider_request',
      { type: 'before_provider_request' },
      context,
    );

    expect(readFailure(context)).toBe('FLOW_AUTH_SNAPSHOT_INVALID');
    expect(context.aborted).toBe(true);
  });

  it('rejects malformed OAuth metadata, wrong-mode snapshots, and extra providers', async () => {
    const invalidMetadata = await installConfig({
      auth: {
        mode: 'pi-login',
        expiresAt: Date.now() + 60 * 60_000,
        token: 'not-allowed',
      } as unknown as { readonly mode: 'pi-login'; readonly expiresAt: number },
    });
    process.env['PI_FLOW_GUARD_CONFIG'] = invalidMetadata.configPath;
    await expect(
      flowHostGuard(new FakeExtensionAPI() as unknown as ExtensionAPI),
    ).rejects.toThrow('FLOW_GUARD_CONFIG_INVALID');

    await expect(
      createOAuthGuard({
        credential: {
          type: 'api_key',
          key: 'synthetic-api-key-not-for-oauth',
        },
      }),
    ).rejects.toThrow('FLOW_AUTH_SNAPSHOT_INVALID');

    await expect(
      createOAuthGuard({
        extraProviders: {
          anthropic: { type: 'api_key', key: '!not-executed' },
        },
      }),
    ).rejects.toThrow('FLOW_AUTH_SNAPSHOT_INVALID');

    await expect(createOAuthGuard({ fileMode: 0o644 })).rejects.toThrow(
      'FLOW_AUTH_SNAPSHOT_INVALID',
    );
    await expect(createOAuthGuard({ symlinkSnapshot: true })).rejects.toThrow(
      'FLOW_AUTH_SNAPSHOT_INVALID',
    );
  });

  it('replaces provider errors and synthetic credentials before the message can be persisted', async () => {
    const providerGuard = await createGuard();
    const providerContext = new FakeContext();
    const rawProviderMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'raw provider output' }],
      provider: 'openai',
      model: 'gpt-6-luna',
      stopReason: 'error',
      errorMessage: 'raw-provider-error-detail',
    };
    const providerReplacement = providerGuard.api.invoke(
      'message_end',
      { type: 'message_end', message: rawProviderMessage },
      providerContext,
    ) as { message: Record<string, unknown> };
    expect(readFailure(providerContext)).toBe('FLOW_MODEL_REQUEST_FAILED');
    expect(providerReplacement.message['errorMessage']).toBe(
      'FLOW_MODEL_REQUEST_FAILED',
    );
    expect(JSON.stringify(providerReplacement)).not.toContain(
      'raw-provider-error-detail',
    );

    const credentialGuard = await createGuard();
    const credentialContext = new FakeContext();
    const credentialReplacement = credentialGuard.api.invoke(
      'message_end',
      {
        type: 'message_end',
        message: {
          ...rawProviderMessage,
          errorMessage: `provider detail ${SYNTHETIC_KEY}`,
        },
      },
      credentialContext,
    ) as { message: Record<string, unknown> };
    expect(readFailure(credentialContext)).toBe('FLOW_OUTPUT_INVALID');
    expect(credentialReplacement.message['errorMessage']).toBe(
      'FLOW_OUTPUT_INVALID',
    );
    expect(JSON.stringify(credentialReplacement)).not.toContain(SYNTHETIC_KEY);
  });
});

async function createGuard(
  overrides: GuardTestOverrides = {},
): Promise<{ readonly api: FakeExtensionAPI; readonly configPath: string }> {
  const { configPath } = await installConfig(overrides);
  process.env['PI_FLOW_GUARD_CONFIG'] = configPath;
  process.env['OPENAI_API_KEY'] = SYNTHETIC_KEY;
  const api = new FakeExtensionAPI();
  await flowHostGuard(api as unknown as ExtensionAPI);
  return { api, configPath };
}

async function installConfig(overrides: GuardTestOverrides = {}): Promise<{
  readonly configPath: string;
  readonly config: ReturnType<typeof createGuardConfig>;
}> {
  const root = await createTestRoot();
  const config = createGuardConfig(overrides);
  const configPath = join(root, 'guard.json');
  await writePrivateConfig(configPath, JSON.stringify(config));
  return { configPath, config };
}

async function createOAuthGuard(
  overrides: {
    readonly credential?: Record<string, unknown>;
    readonly extraProviders?: Record<string, unknown>;
    readonly fileMode?: number;
    readonly symlinkSnapshot?: boolean;
  } = {},
): Promise<{
  readonly api: FakeExtensionAPI;
  readonly configPath: string;
  readonly config: { readonly expiresAt: number };
}> {
  const expiresAt = Date.now() + 10 * 60_000;
  const installed = await installConfig({
    auth: { mode: 'pi-login', expiresAt },
  });
  const agentDirectory = join(dirname(installed.configPath), 'agent');
  await mkdir(agentDirectory, { mode: 0o700 });
  const credential = overrides.credential ?? {
    type: 'oauth',
    access: SYNTHETIC_OAUTH_ACCESS,
    refresh: '',
    expires: expiresAt,
    clientId: 'synthetic-openai-client-id',
    scopes: ['chatgpt.tokens.use.direct'],
  };
  const authPath = join(agentDirectory, 'auth.json');
  const authText = JSON.stringify({
    ...overrides.extraProviders,
    openai: credential,
  });
  if (overrides.symlinkSnapshot === true) {
    const target = join(agentDirectory, 'snapshot-target.json');
    await writePrivateConfig(target, authText);
    await symlink(target, authPath);
  } else {
    await writePrivateConfig(authPath, authText);
    if (overrides.fileMode !== undefined) {
      await chmod(authPath, overrides.fileMode);
    }
  }
  process.env['PI_FLOW_GUARD_CONFIG'] = installed.configPath;
  process.env['PI_CODING_AGENT_DIR'] = agentDirectory;
  delete process.env['OPENAI_API_KEY'];
  const api = new FakeExtensionAPI();
  await flowHostGuard(api as unknown as ExtensionAPI);
  return {
    api,
    configPath: installed.configPath,
    config: { expiresAt },
  };
}

function createGuardConfig(overrides: GuardTestOverrides = {}) {
  return {
    version: 1,
    nonce: TEST_NONCE,
    provider: 'openai',
    model: 'gpt-6-luna',
    thinking: 'max',
    tools: [...(overrides.tools ?? [])],
    effectiveLimits: {
      nodeTimeoutMs: 10_000,
      waitTimeoutMs: 3_600_000,
      jobTimeoutMs: 86_400_000,
      maxTransitions: 100,
      maxRetries: 0,
      maxModelTurns: overrides.effectiveLimits?.maxModelTurns ?? 20,
      maxToolCalls: 1,
      maxOutputChars: overrides.effectiveLimits?.maxOutputChars ?? 20_000,
    },
    ...(overrides.auth === undefined ? {} : { auth: overrides.auth }),
    node: {
      id: 'recommend',
      resultContract: 'recommendation',
      transitions: ['ready'],
    },
  };
}

async function createTestRoot(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(TEST_ROOT, 'rpc-guard-'));
  roots.push(root);
  return root;
}

async function writePrivateConfig(
  path: string,
  contents: string,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await lstat(path);
  expect(metadata.isSymbolicLink()).toBe(false);
  expect(metadata.mode & 0o777).toBe(0o600);
}

function validUserEvent(): Record<string, unknown> {
  return {
    type: 'before_agent_start',
    messageType: 'user',
    prompt: `FLOW_JOB_DATA_JSON:${JSON.stringify({
      tag: 'flow-job-data',
      input: 'synthetic request',
      state: {},
      historyFacts: [],
    })}`,
  };
}

function readFailure(context: FakeContext): string {
  const notification = context.notifications.find(
    (item) => item.type === 'error',
  );
  if (notification === undefined)
    throw new Error('Missing stable failure notification.');
  const value = JSON.parse(notification.message) as {
    tag: string;
    nonce: string;
    code: string;
  };
  expect(value.tag).toBe('flow-host-failure');
  expect(value.nonce).toBe(TEST_NONCE);
  return value.code;
}
