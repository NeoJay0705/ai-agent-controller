import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type {
  AuthContext,
  ModelAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PI_AI_VERSION = '1.2.0';
const EXPECTED_PI_AGENT_VERSION = '1.2.0';
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_OAUTH_VALIDITY_MS = 5 * 60 * 1000;

export type PiAuthErrorCode =
  | 'FLOW_AUTH_SOURCE_MISSING'
  | 'FLOW_AUTH_SOURCE_INVALID'
  | 'FLOW_AUTH_LOGIN_REQUIRED'
  | 'FLOW_AUTH_REFRESH_FAILED'
  | 'FLOW_AUTH_SNAPSHOT_INVALID'
  | 'FLOW_PROVIDER_UNSUPPORTED'
  | 'FLOW_MODEL_UNAVAILABLE'
  | 'FLOW_ABORTED';

export class PiAuthBrokerError extends Error {
  readonly code: PiAuthErrorCode;

  constructor(code: PiAuthErrorCode) {
    super(code);
    this.name = 'PiAuthBrokerError';
    this.code = code;
  }
}

export interface PiAuthSnapshot {
  readonly accessToken: string;
  readonly expiresAt: number;
  /** The child-private auth.json content. It contains no refresh token. */
  readonly authJson: string;
}

export interface PiAuthBrokerInput {
  readonly authFile: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly nodeTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly onSecret: (secret: string) => void;
}

export interface PiAuthBroker {
  createSnapshot(input: PiAuthBrokerInput): Promise<PiAuthSnapshot>;
}

export interface PiAuthTestOverrides {
  /** Test injection is intentionally limited to the builtin OpenAI provider. */
  readonly refresh?: (
    credential: OAuthCredential,
    signal: AbortSignal,
  ) => Promise<OAuthCredential>;
  readonly toAuth?: (credential: OAuthCredential) => Promise<ModelAuth>;
}

interface AuthStorageLockResult<T> {
  readonly result: T;
  readonly next?: string;
}

interface NativeAuthStorageBackend {
  withLockAsync<T>(
    callback: (
      current: string | undefined,
    ) => Promise<AuthStorageLockResult<T>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>;
}

interface NativeAuthStorageBackendConstructor {
  new (authPath?: string): NativeAuthStorageBackend;
}

interface NativeAuthStorageModule {
  readonly FileAuthStorageBackend: NativeAuthStorageBackendConstructor;
}

interface BuiltinProviderModule {
  builtinProviders(): Provider[];
}

interface ParsedAuthFile {
  readonly contents: string;
  readonly entries: Record<string, unknown>;
  readonly credential: OAuthCredential;
}

interface LockOperationResult {
  readonly snapshot?: PiAuthSnapshot;
  readonly failureCode?: PiAuthErrorCode;
}

/** Production broker. It never discovers a global or ambient Pi auth file. */
export function createPiAuthBroker(): PiAuthBroker {
  return new FilePiAuthBroker();
}

/** Test-only injection for the pinned builtin OpenAI OAuth implementation. */
export function createPiAuthBrokerForTests(
  overrides: PiAuthTestOverrides = {},
): PiAuthBroker {
  return new FilePiAuthBroker(overrides);
}

class FilePiAuthBroker implements PiAuthBroker {
  private readonly testOverrides: PiAuthTestOverrides | undefined;

  constructor(testOverrides?: PiAuthTestOverrides) {
    this.testOverrides = testOverrides;
  }

  async createSnapshot(input: PiAuthBrokerInput): Promise<PiAuthSnapshot> {
    const authFile = validateAuthPath(input.authFile);
    assertSignalNotAborted(input.signal);
    if (!Number.isSafeInteger(input.nodeTimeoutMs) || input.nodeTimeoutMs < 1) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
    }

    const initial = await readAuthFile(authFile, input.provider);
    rememberCredentialSecrets(initial.credential, input.onSecret);
    assertSignalNotAborted(input.signal);

    const nativeStorage = await loadNativeAuthStorage();
    const backend = new nativeStorage.FileAuthStorageBackend(
      authFile,
    ) as NativeAuthStorageBackend & {
      ensureParentDir?: () => void;
      ensureFileExists?: () => void;
    };
    // Pi's backend normally creates a missing auth.json. A broker source is
    // read-only except for provider rotation, so keep its native lock but forbid
    // the backend's setup-time creation paths.
    Object.defineProperty(backend, 'ensureParentDir', {
      configurable: true,
      value: (): void => undefined,
    });
    Object.defineProperty(backend, 'ensureFileExists', {
      configurable: true,
      value: (): void => undefined,
    });

    const lockWait = new AbortController();
    const cancelLockWait = (): void => {
      lockWait.abort(input.signal.reason);
    };
    input.signal.addEventListener('abort', cancelLockWait, { once: true });
    if (signalIsAborted(input.signal)) cancelLockWait();

    try {
      const result = await backend.withLockAsync<LockOperationResult>(
        async (current) => {
          // Detach cancellation as soon as Pi enters the lock callback. A refresh
          // can rotate a single-use token, and its write must complete first.
          input.signal.removeEventListener('abort', cancelLockWait);
          if (current === undefined) {
            throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_MISSING');
          }
          const locked = await readAuthFile(authFile, input.provider);
          if (locked.contents !== current) {
            throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
          }
          rememberCredentialSecrets(locked.credential, input.onSecret);

          const provider = await getBuiltinOAuthProvider(
            input.provider,
            this.testOverrides,
          );
          if (provider === undefined || provider.auth.oauth === undefined) {
            throw new PiAuthBrokerError('FLOW_PROVIDER_UNSUPPORTED');
          }
          const credentials = new InMemoryCredentialStore();
          await credentials.modify(input.provider, () =>
            Promise.resolve(structuredClone(locked.credential)),
          );
          const authContext: AuthContext = {
            env: () => Promise.resolve(undefined),
            fileExists: () => Promise.resolve(false),
          };
          const models = createModels({ credentials, authContext });
          models.setProvider(provider);
          const model = models.getModel(provider.id, input.model);
          if (model === undefined) {
            throw new PiAuthBrokerError('FLOW_MODEL_UNAVAILABLE');
          }

          const deliveryValidityMs =
            Math.max(DEFAULT_OAUTH_VALIDITY_MS, input.nodeTimeoutMs + 60_000) +
            input.nodeTimeoutMs;
          assertSignalNotAborted(input.signal);
          let authResolved: boolean;
          try {
            const auth = await models.getAuth(model, {
              minOAuthValidityMs: deliveryValidityMs + 60_000,
            });
            authResolved = auth !== undefined;
          } catch {
            authResolved = false;
          }

          const latestValue = await credentials.read(input.provider);
          if (!isOAuthCredential(latestValue)) {
            return {
              result: {
                failureCode: authResolved
                  ? 'FLOW_AUTH_SNAPSHOT_INVALID'
                  : 'FLOW_AUTH_REFRESH_FAILED',
              },
            };
          }
          rememberCredentialSecrets(latestValue, input.onSecret);

          let next: string | undefined;
          const latestJson = serializeCredential(latestValue);
          const originalJson = serializeCredential(locked.credential);
          if (latestJson === undefined) {
            return {
              result: { failureCode: 'FLOW_AUTH_SOURCE_INVALID' },
            };
          }
          if (latestJson !== originalJson) {
            locked.entries[input.provider] = JSON.parse(latestJson) as unknown;
            next = `${JSON.stringify(locked.entries, null, 2)}\n`;
          }

          if (!authResolved) {
            return {
              result: { failureCode: 'FLOW_AUTH_REFRESH_FAILED' },
              ...(next === undefined ? {} : { next }),
            };
          }

          if (latestValue.expires <= Date.now() + deliveryValidityMs) {
            return {
              result: { failureCode: 'FLOW_AUTH_REFRESH_FAILED' },
              ...(next === undefined ? {} : { next }),
            };
          }

          const snapshot = makeSnapshot(input.provider, latestValue);
          if (snapshot === undefined) {
            return {
              result: { failureCode: 'FLOW_AUTH_SNAPSHOT_INVALID' },
              ...(next === undefined ? {} : { next }),
            };
          }
          return {
            result: { snapshot },
            ...(next === undefined ? {} : { next }),
          };
        },
        { signal: lockWait.signal },
      );
      if (result.failureCode !== undefined) {
        throw new PiAuthBrokerError(result.failureCode);
      }
      if (result.snapshot === undefined) {
        throw new PiAuthBrokerError('FLOW_AUTH_SNAPSHOT_INVALID');
      }
      return result.snapshot;
    } catch (error) {
      if (error instanceof PiAuthBrokerError) throw error;
      assertSignalNotAborted(input.signal);
      throw new PiAuthBrokerError('FLOW_AUTH_REFRESH_FAILED');
    } finally {
      input.signal.removeEventListener('abort', cancelLockWait);
    }
  }
}

function validateAuthPath(path: string | undefined): string {
  if (path === undefined || path.length === 0) {
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_MISSING');
  }
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
  }
  return path;
}

async function readAuthFile(
  path: string,
  provider: string,
): Promise<ParsedAuthFile> {
  let handle;
  try {
    const parent = dirname(path);
    const canonicalParent = await realpath(parent);
    const pathMetadata = await lstat(path, { bigint: true });
    if (
      canonicalParent !== parent ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      (pathMetadata.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      !ownedByCurrentUser(pathMetadata.uid)
    ) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
    }
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
    }

    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(MAX_AUTH_FILE_BYTES) ||
      (before.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      !ownedByCurrentUser(before.uid) ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino
    ) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
    }

    const buffer = Buffer.allocUnsafe(MAX_AUTH_FILE_BYTES + 1);
    let offset = 0;
    try {
      while (offset < buffer.byteLength) {
        const length = Math.min(64 * 1024, buffer.byteLength - offset);
        const { bytesRead } = await handle.read(buffer, offset, length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(path, { bigint: true });
      if (
        offset > MAX_AUTH_FILE_BYTES ||
        after.size > BigInt(MAX_AUTH_FILE_BYTES) ||
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        BigInt(offset) !== after.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.mode !== before.mode ||
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        pathAfter.dev !== after.dev ||
        pathAfter.ino !== after.ino ||
        pathAfter.size !== after.size ||
        pathAfter.mtimeNs !== after.mtimeNs ||
        pathAfter.ctimeNs !== after.ctimeNs ||
        pathAfter.mode !== after.mode ||
        !ownedByCurrentUser(after.uid)
      ) {
        throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
      }
      let contents: string;
      try {
        contents = new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, offset),
        );
      } catch {
        throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
      }
      const entries = parseAuthEntries(contents);
      const selected = entries[provider];
      if (selected === undefined) {
        throw new PiAuthBrokerError('FLOW_AUTH_LOGIN_REQUIRED');
      }
      if (!isRecord(selected) || selected['type'] !== 'oauth') {
        throw new PiAuthBrokerError('FLOW_AUTH_LOGIN_REQUIRED');
      }
      if (!isOAuthCredential(selected)) {
        throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
      }
      return { contents, entries, credential: selected };
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof PiAuthBrokerError) throw error;
    if (isCode(error, 'ENOENT')) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_MISSING');
    }
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseAuthEntries(contents: string): Record<string, unknown> {
  if (Buffer.byteLength(contents, 'utf8') > MAX_AUTH_FILE_BYTES) {
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
  }
  if (!isRecord(value) || !isJsonValue(value, 0)) {
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
  }
  return value;
}

async function loadNativeAuthStorage(): Promise<NativeAuthStorageModule> {
  try {
    const packageEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const packageRoot = dirname(dirname(fileURLToPath(packageEntry)));
    const manifestText = await readFile(
      resolve(packageRoot, 'package.json'),
      'utf8',
    );
    const manifest = JSON.parse(manifestText) as { version?: unknown };
    if (manifest.version !== EXPECTED_PI_AGENT_VERSION) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
    }
    const moduleUrl = new URL('./core/auth-storage.js', packageEntry);
    if (
      fileURLToPath(moduleUrl) !==
      resolve(packageRoot, 'dist/core/auth-storage.js')
    ) {
      throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
    }
    return (await import(moduleUrl.href)) as NativeAuthStorageModule;
  } catch (error) {
    if (error instanceof PiAuthBrokerError) throw error;
    throw new PiAuthBrokerError('FLOW_AUTH_SOURCE_INVALID');
  }
}

async function getBuiltinOAuthProvider(
  providerId: string,
  overrides: PiAuthTestOverrides | undefined,
): Promise<Provider | undefined> {
  try {
    const aiEntry = import.meta.resolve('@earendil-works/pi-ai');
    const aiRoot = dirname(dirname(fileURLToPath(aiEntry)));
    const manifestText = await readFile(
      resolve(aiRoot, 'package.json'),
      'utf8',
    );
    const manifest = JSON.parse(manifestText) as { version?: unknown };
    if (manifest.version !== EXPECTED_PI_AI_VERSION) {
      throw new PiAuthBrokerError('FLOW_PROVIDER_UNSUPPORTED');
    }
    const providerModuleUrl = new URL('./providers/all.js', aiEntry);
    const module = (await import(
      providerModuleUrl.href
    )) as BuiltinProviderModule;
    const provider = module
      .builtinProviders()
      .find((candidate) => candidate.id === providerId);
    if (provider === undefined) return undefined;
    if (overrides === undefined) return provider;
    if (providerId !== 'openai' || provider.auth.oauth === undefined) {
      throw new PiAuthBrokerError('FLOW_PROVIDER_UNSUPPORTED');
    }
    const oauth = {
      ...provider.auth.oauth,
      ...(overrides.refresh === undefined
        ? {}
        : { refresh: overrides.refresh }),
      ...(overrides.toAuth === undefined ? {} : { toAuth: overrides.toAuth }),
    };
    return { ...provider, auth: { ...provider.auth, oauth } };
  } catch (error) {
    if (error instanceof PiAuthBrokerError) throw error;
    throw new PiAuthBrokerError('FLOW_PROVIDER_UNSUPPORTED');
  }
}

function makeSnapshot(
  provider: string,
  credential: OAuthCredential,
): PiAuthSnapshot | undefined {
  if (
    credential.access.length === 0 ||
    !Number.isSafeInteger(credential.expires) ||
    credential.expires <= Date.now()
  ) {
    return undefined;
  }
  const snapshotCredential: Record<string, unknown> = {
    ...credential,
    refresh: '',
  };
  const authJson = `${JSON.stringify({ [provider]: snapshotCredential })}\n`;
  if (
    Buffer.byteLength(authJson, 'utf8') > MAX_AUTH_FILE_BYTES ||
    !isJsonValue(snapshotCredential, 0)
  ) {
    return undefined;
  }
  return {
    accessToken: credential.access,
    expiresAt: credential.expires,
    authJson,
  };
}

function serializeCredential(credential: OAuthCredential): string | undefined {
  const text = JSON.stringify(credential);
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > MAX_AUTH_FILE_BYTES ||
    !isJsonValue(credential, 0)
  ) {
    return undefined;
  }
  return text;
}

function rememberCredentialSecrets(
  credential: OAuthCredential,
  remember: (secret: string) => void,
): void {
  remember(credential.access);
  remember(credential.refresh);
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
  return (
    isRecord(value) &&
    value['type'] === 'oauth' &&
    typeof value['access'] === 'string' &&
    value['access'].length > 0 &&
    value['access'].length <= 65_536 &&
    typeof value['refresh'] === 'string' &&
    value['refresh'].length > 0 &&
    value['refresh'].length <= 65_536 &&
    typeof value['expires'] === 'number' &&
    Number.isSafeInteger(value['expires']) &&
    value['expires'] > 0 &&
    isJsonValue(value, 0)
  );
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function assertSignalNotAborted(signal: AbortSignal): void {
  if (signalIsAborted(signal)) throw new PiAuthBrokerError('FLOW_ABORTED');
}

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function ownedByCurrentUser(uid: bigint): boolean {
  return (
    typeof process.getuid !== 'function' || uid === BigInt(process.getuid())
  );
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

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
