import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { OAuthCredential } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPiAuthBrokerForTests,
  PiAuthBrokerError,
  type PiAuthBrokerInput,
} from '../../src/flow/pi-auth.js';

const TEST_ROOT = resolve('.test-artifacts/pi-flow/oauth-core/auth-tests');
const ACCESS_OLD = 'synthetic-oauth-access-before-rotation';
const REFRESH_OLD = 'synthetic-oauth-refresh-before-rotation';
const ACCESS_NEW = 'synthetic-oauth-access-after-rotation';
const REFRESH_NEW = 'synthetic-oauth-refresh-after-rotation';
const roots: string[] = [];

interface SyntheticAuthFile {
  readonly openai: Record<string, unknown>;
  readonly [provider: string]: unknown;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('Pi login OAuth broker', () => {
  it('accepts a valid builtin OAuth credential without refreshing and emits a refresh-free snapshot', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    const original = createAuthFile(oauthCredential(Date.now() + 60 * 60_000));
    const raw = await writeAuth(path, original);
    let refreshCount = 0;
    const secrets: string[] = [];
    const broker = createPiAuthBrokerForTests({
      refresh: () => {
        refreshCount += 1;
        return Promise.resolve(oauthCredential(Date.now() + 60 * 60_000));
      },
    });

    const snapshot = await broker.createSnapshot(
      brokerInput(path, new AbortController().signal, secrets),
    );

    expect(refreshCount).toBe(0);
    expect(snapshot.accessToken).toBe(ACCESS_OLD);
    expect(snapshot.expiresAt).toBe(original.openai['expires']);
    expect(snapshot.authJson).not.toContain(REFRESH_OLD);
    expect(JSON.parse(snapshot.authJson)).toEqual({
      openai: { ...original.openai, refresh: '' },
    });
    expect(secrets).toEqual([ACCESS_OLD, REFRESH_OLD]);
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('refreshes a seven-minute token for a 180-second Node delivery window', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(
      path,
      createAuthFile(oauthCredential(Date.now() + 7 * 60_000)),
    );
    let refreshCount = 0;
    const broker = createPiAuthBrokerForTests({
      refresh: () => {
        refreshCount += 1;
        return Promise.resolve(rotatedCredential(Date.now() + 60 * 60_000));
      },
    });

    const snapshot = await broker.createSnapshot({
      ...brokerInput(path, new AbortController().signal, []),
      nodeTimeoutMs: 180_000,
    });

    expect(refreshCount).toBe(1);
    expect(snapshot.accessToken).toBe(ACCESS_NEW);
    expect(snapshot.expiresAt).toBeGreaterThan(
      Date.now() + 60 * 60_000 - 1_000,
    );
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      openai: { access: ACCESS_NEW, refresh: REFRESH_NEW },
    });
  });

  it('preserves cancellation after acquiring the native lock but before OAuth refresh', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    const raw = await writeAuth(
      path,
      createAuthFile(oauthCredential(Date.now() + 1_000)),
    );
    const originalMode = (await stat(path)).mode & 0o777;
    const controller = new AbortController();
    let refreshCount = 0;
    const broker = createPiAuthBrokerForTests({
      refresh: () => {
        refreshCount += 1;
        return Promise.resolve(rotatedCredential(Date.now() + 60 * 60_000));
      },
    });
    const input = brokerInput(path, controller.signal, []);
    let secretCallbackCount = 0;

    await expect(
      broker.createSnapshot({
        ...input,
        onSecret: (secret) => {
          input.onSecret(secret);
          secretCallbackCount += 1;
          // The third callback is from the locked read, after lock-wait cancellation is detached.
          if (secretCallbackCount === 3) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'FLOW_ABORTED' });

    expect(secretCallbackCount).toBeGreaterThanOrEqual(3);
    expect(refreshCount).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(raw);
    expect((await stat(path)).mode & 0o777).toBe(originalMode);
  });

  it('rotates only the selected provider and never executes another provider command', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    const marker = join(directory, 'command-was-executed');
    const otherProvider = {
      type: 'api_key',
      key: `!touch ${marker}`,
      env: { FLOW_TEST_MARKER: marker },
    };
    const original = createAuthFile(oauthCredential(Date.now() + 1_000), {
      anthropic: otherProvider,
      'unmodified-metadata': { note: 'preserve this provider entry' },
    });
    await writeAuth(path, original);
    const secrets: string[] = [];
    const broker = createPiAuthBrokerForTests({
      refresh: () =>
        Promise.resolve(rotatedCredential(Date.now() + 60 * 60_000)),
    });

    const snapshot = await broker.createSnapshot(
      brokerInput(path, new AbortController().signal, secrets),
    );
    const updated = JSON.parse(
      await readFile(path, 'utf8'),
    ) as SyntheticAuthFile;

    expect(updated['openai']).toMatchObject({
      type: 'oauth',
      access: ACCESS_NEW,
      refresh: REFRESH_NEW,
      clientId: 'synthetic-openai-client-id',
    });
    expect(updated['anthropic']).toEqual(otherProvider);
    expect(updated['unmodified-metadata']).toEqual({
      note: 'preserve this provider entry',
    });
    expect(snapshot.accessToken).toBe(ACCESS_NEW);
    expect(snapshot.authJson).toContain('synthetic-account-id');
    expect(snapshot.authJson).not.toContain(REFRESH_NEW);
    expect(secrets).toEqual(
      expect.arrayContaining([
        ACCESS_OLD,
        REFRESH_OLD,
        ACCESS_NEW,
        REFRESH_NEW,
      ]),
    );
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent brokers so one refresh preserves unrelated providers', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(
      path,
      createAuthFile(oauthCredential(Date.now() + 1_000), {
        anthropic: { type: 'api_key', key: '!not-executed' },
      }),
    );
    let refreshCount = 0;
    const refresh = async (): Promise<OAuthCredential> => {
      refreshCount += 1;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 20),
      );
      return rotatedCredential(Date.now() + 60 * 60_000);
    };
    const brokerA = createPiAuthBrokerForTests({ refresh });
    const brokerB = createPiAuthBrokerForTests({ refresh });
    const inputA = brokerInput(path, new AbortController().signal, []);
    const inputB = brokerInput(path, new AbortController().signal, []);

    const [first, second] = await Promise.all([
      brokerA.createSnapshot(inputA),
      brokerB.createSnapshot(inputB),
    ]);

    expect(refreshCount).toBe(1);
    expect(first.accessToken).toBe(ACCESS_NEW);
    expect(second.accessToken).toBe(ACCESS_NEW);
    const saved = JSON.parse(await readFile(path, 'utf8')) as SyntheticAuthFile;
    expect(saved['anthropic']).toEqual({
      type: 'api_key',
      key: '!not-executed',
    });
  });

  it('persists a rotated refresh token before returning a safe failure from toAuth', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(path, createAuthFile(oauthCredential(Date.now() + 1_000)));
    const broker = createPiAuthBrokerForTests({
      refresh: () =>
        Promise.resolve(rotatedCredential(Date.now() + 60 * 60_000)),
      toAuth: () =>
        Promise.reject(
          new Error('synthetic private OAuth conversion exception'),
        ),
    });

    await expect(
      broker.createSnapshot(
        brokerInput(path, new AbortController().signal, []),
      ),
    ).rejects.toMatchObject({ code: 'FLOW_AUTH_REFRESH_FAILED' });
    const saved = JSON.parse(await readFile(path, 'utf8')) as SyntheticAuthFile;
    expect(saved['openai']).toMatchObject({
      access: ACCESS_NEW,
      refresh: REFRESH_NEW,
    });
    expect(JSON.stringify(saved)).not.toContain(
      'synthetic private OAuth conversion exception',
    );
  });

  it('persists a refresh result that fails the requested validity check', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(path, createAuthFile(oauthCredential(Date.now() + 1_000)));
    const broker = createPiAuthBrokerForTests({
      refresh: () => Promise.resolve(rotatedCredential(Date.now() + 30_000)),
    });

    await expect(
      broker.createSnapshot(
        brokerInput(path, new AbortController().signal, []),
      ),
    ).rejects.toMatchObject({ code: 'FLOW_AUTH_REFRESH_FAILED' });
    const saved = JSON.parse(await readFile(path, 'utf8')) as SyntheticAuthFile;
    expect(saved['openai']).toMatchObject({
      access: ACCESS_NEW,
      refresh: REFRESH_NEW,
    });
  });

  it('does not stop a started refresh when the caller cancels and waits for persistence', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(path, createAuthFile(oauthCredential(Date.now() + 1_000)));
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      refreshStarted = resolvePromise;
    });
    let releaseRefresh!: () => void;
    const canFinish = new Promise<void>((resolvePromise) => {
      releaseRefresh = resolvePromise;
    });
    const controller = new AbortController();
    const broker = createPiAuthBrokerForTests({
      refresh: async () => {
        refreshStarted();
        await canFinish;
        return rotatedCredential(Date.now() + 60 * 60_000);
      },
    });
    const running = broker.createSnapshot(
      brokerInput(path, controller.signal, []),
    );

    await started;
    controller.abort();
    releaseRefresh();
    const snapshot = await running;

    expect(snapshot.accessToken).toBe(ACCESS_NEW);
    const saved = JSON.parse(await readFile(path, 'utf8')) as SyntheticAuthFile;
    expect(saved['openai']).toMatchObject({ refresh: REFRESH_NEW });
  });

  it('cancels a native file-lock wait without recreating a removed auth source', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(
      path,
      createAuthFile(oauthCredential(Date.now() + 60 * 60_000)),
    );
    const nativeStorage = await loadNativeAuthStorage(path);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolvePromise) => {
      lockAcquired = resolvePromise;
    });
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolvePromise) => {
      releaseLock = resolvePromise;
    });
    const lockHolder = nativeStorage.withLockAsync(async () => {
      lockAcquired();
      await lockGate;
      return { result: undefined };
    });
    await acquired;

    const controller = new AbortController();
    let sourceRead!: () => void;
    const sourceWasRead = new Promise<void>((resolvePromise) => {
      sourceRead = resolvePromise;
    });
    const broker = createPiAuthBrokerForTests();
    const input = brokerInput(path, controller.signal, []);
    const running = broker.createSnapshot({
      ...input,
      onSecret: (secret) => {
        input.onSecret(secret);
        sourceRead();
      },
    });
    try {
      await sourceWasRead;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 100),
      );
      await rm(path);
      controller.abort();
      await expect(running).rejects.toMatchObject({ code: 'FLOW_ABORTED' });
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      releaseLock();
      await lockHolder;
      await running.catch(() => undefined);
    }
  });

  it('fails closed for missing, malformed, non-OAuth, symlinked, oversized, and insecure sources', async () => {
    const directory = await createTestRoot();
    const missing = join(directory, 'missing.json');
    await expectFailure(undefined, 'FLOW_AUTH_SOURCE_MISSING');
    await expectFailure(missing, 'FLOW_AUTH_SOURCE_MISSING');

    const malformed = join(directory, 'malformed.json');
    await writeAuth(malformed, '{not-json');
    await expectFailure(malformed, 'FLOW_AUTH_SOURCE_INVALID');

    const invalidUtf8 = join(directory, 'invalid-utf8.json');
    const invalidUtf8Handle = await open(invalidUtf8, 'wx', 0o600);
    try {
      await invalidUtf8Handle.writeFile(Buffer.from([0xff, 0xfe]));
    } finally {
      await invalidUtf8Handle.close();
    }
    await expectFailure(invalidUtf8, 'FLOW_AUTH_SOURCE_INVALID');

    const absentProvider = join(directory, 'absent-provider.json');
    await writeAuth(absentProvider, '{}');
    await expectFailure(absentProvider, 'FLOW_AUTH_LOGIN_REQUIRED');

    const apiKeyProvider = join(directory, 'api-key.json');
    await writeAuth(apiKeyProvider, {
      openai: { type: 'api_key', key: '!touch /not-run' },
    });
    await expectFailure(apiKeyProvider, 'FLOW_AUTH_LOGIN_REQUIRED');

    const insecure = join(directory, 'insecure.json');
    await writeAuth(
      insecure,
      createAuthFile(oauthCredential(Date.now() + 60 * 60_000)),
    );
    await chmod(insecure, 0o644);
    await expectFailure(insecure, 'FLOW_AUTH_SOURCE_INVALID');

    const target = join(directory, 'target.json');
    const link = join(directory, 'source-link.json');
    await writeAuth(
      target,
      createAuthFile(oauthCredential(Date.now() + 60 * 60_000)),
    );
    await symlink(target, link);
    await expectFailure(link, 'FLOW_AUTH_SOURCE_INVALID');

    const fifo = join(directory, 'auth.fifo');
    execFileSync('mkfifo', [fifo], { stdio: 'ignore' });
    await expectFailure(fifo, 'FLOW_AUTH_SOURCE_INVALID');

    const oversized = join(directory, 'oversized.json');
    const oversizedHandle = await open(oversized, 'wx', 0o600);
    try {
      await oversizedHandle.writeFile(`${' '.repeat(1024 * 1024)} `, 'utf8');
    } finally {
      await oversizedHandle.close();
    }
    await expectFailure(oversized, 'FLOW_AUTH_SOURCE_INVALID');
  });

  it('rejects a builtin provider without OAuth and a failed refresh without API-key fallback', async () => {
    const directory = await createTestRoot();
    const path = join(directory, 'auth.json');
    await writeAuth(path, {
      'amazon-bedrock': {
        type: 'oauth',
        access: ACCESS_OLD,
        refresh: REFRESH_OLD,
        expires: Date.now() + 60 * 60_000,
      },
    });
    const unsupported = createPiAuthBrokerForTests();
    await expect(
      unsupported.createSnapshot({
        ...brokerInput(path, new AbortController().signal, []),
        provider: 'amazon-bedrock',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_PROVIDER_UNSUPPORTED' });

    const failurePath = join(directory, 'refresh-failure.json');
    await writeAuth(
      failurePath,
      createAuthFile(oauthCredential(Date.now() + 1_000)),
    );
    const broker = createPiAuthBrokerForTests({
      refresh: () => Promise.reject(new Error('synthetic refresh failure')),
    });
    const failure = broker.createSnapshot(
      brokerInput(failurePath, new AbortController().signal, []),
    );
    await expect(failure).rejects.toMatchObject({
      code: 'FLOW_AUTH_REFRESH_FAILED',
    });
    await expect(readFile(failurePath, 'utf8')).resolves.toContain(REFRESH_OLD);
  });
});

interface NativeAuthStorageForTest {
  withLockAsync<T>(
    callback: (
      current: string | undefined,
    ) => Promise<{ readonly result: T; readonly next?: string }>,
  ): Promise<T>;
}

async function loadNativeAuthStorage(
  path: string,
): Promise<NativeAuthStorageForTest> {
  const packageEntry = fileURLToPath(
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  );
  const packageRoot = dirname(dirname(packageEntry));
  const moduleUrl = pathToFileURL(
    join(packageRoot, 'dist/core/auth-storage.js'),
  );
  const module = (await import(moduleUrl.href)) as {
    readonly FileAuthStorageBackend: new (
      authPath: string,
    ) => NativeAuthStorageForTest;
  };
  return new module.FileAuthStorageBackend(path);
}

async function createTestRoot(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(TEST_ROOT, 'case-'));
  roots.push(directory);
  return directory;
}

async function writeAuth(path: string, value: unknown): Promise<string> {
  const raw = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(raw, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return raw;
}

function oauthCredential(expires: number): OAuthCredential {
  return {
    type: 'oauth',
    access: ACCESS_OLD,
    refresh: REFRESH_OLD,
    expires,
    clientId: 'synthetic-openai-client-id',
    scopes: ['chatgpt.tokens.use.direct'],
    accountId: 'synthetic-account-id',
  };
}

function rotatedCredential(expires: number): OAuthCredential {
  return {
    type: 'oauth',
    access: ACCESS_NEW,
    refresh: REFRESH_NEW,
    expires,
    clientId: 'synthetic-openai-client-id',
    scopes: ['chatgpt.tokens.use.direct'],
    accountId: 'synthetic-account-id',
  };
}

function createAuthFile(
  credential: OAuthCredential,
  extra: Record<string, unknown> = {},
): SyntheticAuthFile {
  return {
    ...extra,
    openai: credential,
  };
}

function brokerInput(
  authFile: string | undefined,
  signal: AbortSignal,
  secrets: string[],
): PiAuthBrokerInput {
  return {
    authFile,
    provider: 'openai',
    model: 'gpt-6-luna',
    nodeTimeoutMs: 10_000,
    signal,
    onSecret: (secret) => {
      if (!secrets.includes(secret)) secrets.push(secret);
    },
  };
}

async function expectFailure(
  authFile: string | undefined,
  code: string,
): Promise<void> {
  const broker = createPiAuthBrokerForTests();
  let caught: unknown;
  try {
    await broker.createSnapshot(
      brokerInput(authFile, new AbortController().signal, []),
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PiAuthBrokerError);
  expect(caught).toMatchObject({ code, message: code });
  if (authFile !== undefined) expect(String(caught)).not.toContain(authFile);
}
