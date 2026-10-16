import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

const FLOCK = '/usr/bin/flock';
const MARKER = 'controller.lock';
const ANCHOR = 'controller.kernel.lock';
const MAX_RECORD_BYTES = 2048;
const LEGACY_ERROR =
  'Legacy controller lock requires one-time operator recovery.';
const activeAnchors = new Set<FileHandle>();

interface LockRecord {
  readonly version: 1;
  readonly kind: 'controller-kernel-lock';
  readonly pid: number;
  readonly token: string;
  readonly anchorDev: string;
  readonly anchorIno: string;
}

interface MarkerSnapshot {
  readonly bytes: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
}

export interface ControllerKernelLease {
  release(): Promise<void>;
}

export async function acquireControllerKernelLock(
  dataDir: string,
): Promise<ControllerKernelLease> {
  if (process.platform !== 'linux' || process.getuid === undefined)
    throw new Error('Controller locking requires Linux.');
  const currentUid = getCurrentUid();
  const canonicalDir = await realpath(dataDir).catch(() => {
    throw new Error('Controller data directory is unavailable.');
  });
  if (canonicalDir !== resolve(dataDir))
    throw new Error('Controller data directory is not canonical.');
  const dirStat = await lstat(canonicalDir).catch(() => {
    throw new Error('Controller data directory is unavailable.');
  });
  if (
    !dirStat.isDirectory() ||
    dirStat.uid !== currentUid ||
    (dirStat.mode & 0o777) !== 0o700
  )
    throw new Error('Controller data directory permissions are unsafe.');
  if (dirname(canonicalDir) === canonicalDir)
    throw new Error('Controller data directory is not canonical.');

  const anchorPath = join(canonicalDir, ANCHOR);
  let anchor: FileHandle;
  try {
    anchor = await open(
      anchorPath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch {
    throw new Error('Could not open controller kernel lock anchor.');
  }
  let keepAnchor = false;
  try {
    const anchorStat = await anchor.stat({ bigint: true });
    const pathStat = await lstat(anchorPath, { bigint: true });
    if (
      !anchorStat.isFile() ||
      anchorStat.uid !== BigInt(currentUid) ||
      (anchorStat.mode & 0o777n) !== 0o600n ||
      anchorStat.nlink !== 1n ||
      anchorStat.dev !== pathStat.dev ||
      anchorStat.ino !== pathStat.ino
    )
      throw new Error('Controller kernel lock anchor is unsafe.');
    await anchor.sync();
    const anchorDirSync = await open(canonicalDir, constants.O_RDONLY);
    try {
      await anchorDirSync.sync();
    } finally {
      await anchorDirSync.close();
    }
    await runFlock(anchor);
    const afterStat = await anchor.stat({ bigint: true });
    const afterPath = await lstat(anchorPath, { bigint: true });
    if (
      afterStat.dev !== anchorStat.dev ||
      afterStat.ino !== anchorStat.ino ||
      afterPath.dev !== anchorStat.dev ||
      afterPath.ino !== anchorStat.ino
    )
      throw new Error('Controller kernel lock anchor changed.');
    const token = randomUUID();
    const record: LockRecord = {
      version: 1,
      kind: 'controller-kernel-lock',
      pid: process.pid,
      token,
      anchorDev: anchorStat.dev.toString(10),
      anchorIno: anchorStat.ino.toString(10),
    };
    const prior = await readMarker(canonicalDir);
    if (prior === null) await publishNewMarker(canonicalDir, record);
    else {
      if (isLegacyPid(prior.bytes)) throw new Error(LEGACY_ERROR);
      const decoded = parseRecord(prior.bytes);
      if (
        decoded.anchorDev !== record.anchorDev ||
        decoded.anchorIno !== record.anchorIno
      )
        throw new Error('Controller lock marker refers to another anchor.');
      await replaceMarker(canonicalDir, prior, record);
    }
    const publishedMarker = await readMarker(canonicalDir);
    if (publishedMarker === null)
      throw new Error('Controller lock ownership changed.');
    const confirmed = parseRecord(publishedMarker.bytes);
    if (confirmed.token !== token)
      throw new Error('Controller lock ownership changed.');
    const markerDirSync = await open(canonicalDir, constants.O_RDONLY);
    try {
      await markerDirSync.sync();
    } finally {
      await markerDirSync.close();
    }
    keepAnchor = true;
    activeAnchors.add(anchor);
    let released: Promise<void> | null = null;
    return {
      release: () => {
        if (released !== null) return released;
        released = releaseLease(anchor, canonicalDir, publishedMarker, token);
        return released;
      },
    };
  } catch (error) {
    if (error instanceof Error && isSafeError(error)) throw error;
    throw safeError('Could not acquire controller lock.');
  } finally {
    if (!keepAnchor) {
      try {
        await anchor.close();
      } catch {
        activeAnchors.add(anchor);
      }
    }
  }
}

async function runFlock(anchor: FileHandle): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        FLOCK,
        ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'],
        {
          shell: false,
          stdio: ['ignore', 'ignore', 'pipe', anchor.fd],
          env: { LANG: 'C', LC_ALL: 'C' },
        },
      );
    } catch {
      reject(new Error('Could not start controller lock helper.'));
      return;
    }
    child.stderr?.resume();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      child.removeAllListeners('error');
      child.removeAllListeners('close');
      if (error) reject(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, 5000);
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', (code) => {
      if (spawnFailed)
        finish(new Error('Could not start controller lock helper.'));
      else if (timedOut) finish(new Error('Controller lock helper timed out.'));
      else if (code === 73)
        finish(new Error('Controller lock already exists.'));
      else if (code !== 0) finish(new Error('Controller lock helper failed.'));
      else finish();
    });
  });
}

async function readMarker(dataDir: string): Promise<MarkerSnapshot | null> {
  const path = join(dataDir, MARKER);
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw safeError('Controller lock marker is unsafe.');
  }
  try {
    const currentUid = getCurrentUid();
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.uid !== BigInt(currentUid) ||
      (opened.mode & 0o777n) !== 0o600n ||
      !sameMetadata(opened, current) ||
      opened.size > BigInt(MAX_RECORD_BYTES)
    )
      throw new Error('Controller lock marker is unsafe.');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_RECORD_BYTES)
      throw new Error('Controller lock marker is invalid.');
    chunks.push(buffer.subarray(0, total));
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameMetadata(opened, after) || !sameMetadata(opened, afterPath))
      throw new Error('Controller lock ownership changed.');
    return { ...metadata(opened), bytes: Buffer.concat(chunks) };
  } finally {
    await handle.close();
  }
}

function metadata(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
}): Omit<MarkerSnapshot, 'bytes'> {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    mode: value.mode,
    uid: value.uid,
  };
}

function sameMetadata(
  left:
    | ReturnType<typeof metadata>
    | {
        readonly dev: bigint;
        readonly ino: bigint;
        readonly size: bigint;
        readonly mtimeNs: bigint;
        readonly ctimeNs: bigint;
        readonly mode: bigint;
        readonly uid: bigint;
      },
  right:
    | ReturnType<typeof metadata>
    | {
        readonly dev: bigint;
        readonly ino: bigint;
        readonly size: bigint;
        readonly mtimeNs: bigint;
        readonly ctimeNs: bigint;
        readonly mode: bigint;
        readonly uid: bigint;
      },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

async function publishNewMarker(
  dataDir: string,
  record: LockRecord,
): Promise<void> {
  const temp = join(dataDir, `.controller.lock.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600).catch(() => {
    throw new Error('Could not publish controller lock.');
  });
  try {
    await handle.writeFile(encodeRecord(record));
    await handle.sync();
  } catch {
    await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw new Error('Could not publish controller lock.');
  }
  await handle.close();
  try {
    await link(temp, join(dataDir, MARKER));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (isCode(error, 'EEXIST'))
      throw safeError('Controller lock already exists.');
    throw safeError('Could not publish controller lock.');
  }
  await unlink(temp).catch(() => undefined);
}

async function replaceMarker(
  dataDir: string,
  prior: MarkerSnapshot,
  record: LockRecord,
): Promise<void> {
  const path = join(dataDir, MARKER);
  const fresh = await readMarker(dataDir);
  if (fresh === null || !sameSnapshot(fresh, prior))
    throw new Error('Controller lock ownership changed.');
  const temp = join(dataDir, `.controller.lock.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600).catch(() => {
    throw new Error('Could not publish controller lock.');
  });
  try {
    await handle.writeFile(encodeRecord(record));
    await handle.sync();
  } catch {
    await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw new Error('Could not publish controller lock.');
  }
  try {
    await handle.close();
    const checked = await readMarker(dataDir);
    if (checked === null || !sameSnapshot(checked, prior))
      throw new Error('Controller lock ownership changed.');
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (error instanceof Error && isSafeError(error)) throw error;
    throw safeError('Could not publish controller lock.');
  }
}

function sameSnapshot(left: MarkerSnapshot, right: MarkerSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.bytes.equals(right.bytes)
  );
}

async function releaseLease(
  anchor: FileHandle,
  dataDir: string,
  snapshot: MarkerSnapshot,
  token: string,
): Promise<void> {
  let markerError: Error | undefined;
  try {
    const marker = await readMarker(dataDir);
    if (
      marker === null ||
      marker.dev !== snapshot.dev ||
      marker.ino !== snapshot.ino
    )
      throw new Error('Controller lock ownership changed.');
    const record = parseRecord(marker.bytes);
    if (record.token !== token)
      throw new Error('Controller lock ownership changed.');
    await unlink(join(dataDir, MARKER));
    const dir = await open(dataDir, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    markerError = new Error('Controller lock ownership changed.');
  }
  try {
    await anchor.close();
    activeAnchors.delete(anchor);
  } catch {
    markerError ??= new Error('Could not release controller lock.');
  }
  if (markerError) throw markerError;
}

function encodeRecord(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function parseRecord(bytes: Buffer): LockRecord {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Controller lock marker is invalid.');
  }
  if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES)
    throw new Error('Controller lock marker is invalid.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Controller lock marker is invalid.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Controller lock marker is invalid.');
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  if (
    text !== `${JSON.stringify(value)}\n` ||
    keys.join(',') !== 'anchorDev,anchorIno,kind,pid,token,version' ||
    item['version'] !== 1 ||
    item['kind'] !== 'controller-kernel-lock' ||
    typeof item['pid'] !== 'number' ||
    !Number.isSafeInteger(item['pid']) ||
    item['pid'] <= 0 ||
    typeof item['token'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/.test(
      item['token'],
    ) ||
    typeof item['anchorDev'] !== 'string' ||
    !/^(0|[1-9][0-9]*)(?![\s\S])/.test(item['anchorDev']) ||
    typeof item['anchorIno'] !== 'string' ||
    !/^(0|[1-9][0-9]*)(?![\s\S])/.test(item['anchorIno'])
  )
    throw new Error('Controller lock marker is invalid.');
  return item as unknown as LockRecord;
}

function isLegacyPid(bytes: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return /^[0-9]+\n?(?![\s\S])/.test(text);
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function getCurrentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Controller locking requires Linux.');
  return uid;
}

function safeError(message: string): Error {
  return new Error(message);
}

function isSafeError(error: Error): boolean {
  return [
    'Controller locking requires Linux.',
    'Controller data directory is unavailable.',
    'Controller data directory permissions are unsafe.',
    'Controller data directory is not canonical.',
    'Could not open controller kernel lock anchor.',
    'Controller kernel lock anchor is unsafe.',
    'Controller kernel lock anchor changed.',
    'Controller lock already exists.',
    LEGACY_ERROR,
    'Controller lock marker is unsafe.',
    'Controller lock marker is invalid.',
    'Controller lock marker refers to another anchor.',
    'Controller lock ownership changed.',
    'Could not publish controller lock.',
    'Could not start controller lock helper.',
    'Controller lock helper timed out.',
    'Controller lock helper failed.',
  ].includes(error.message);
}
