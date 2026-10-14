import { open, mkdir, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ControllerConfig } from './types.js';
import { ControllerStore, restrictDatabaseFile } from './store.js';

export interface ControllerResources {
  readonly store: ControllerStore;
  close(): Promise<void>;
}

export async function openControllerResources(
  config: ControllerConfig,
  options: {
    readonly now?: () => number;
    readonly id?: (kind: string) => string;
  } = {},
): Promise<ControllerResources> {
  if (config.mode !== 'bot') throw new Error('Bot configuration is required.');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  const lockPath = join(config.dataDir, 'controller.lock');
  let ownsLock = false;
  let store: ControllerStore | null = null;
  let closed = false;
  try {
    const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
      if (isAlreadyExists(error))
        throw new Error('Controller lock already exists.');
      throw new Error('Could not create controller lock.');
    });
    ownsLock = true;
    try {
      await lock.writeFile(`${String(process.pid)}\n`, 'utf8');
      await lock.sync();
    } finally {
      await lock.close();
    }
    const databasePath = join(config.dataDir, 'controller.sqlite');
    const database = new DatabaseSync(databasePath);
    store = new ControllerStore(database, options);
    await restrictDatabaseFile(databasePath);
    const openedStore = store;
    return {
      store: openedStore,
      close: async () => {
        if (closed) return;
        closed = true;
        openedStore.close();
        if (ownsLock) {
          ownsLock = false;
          await unlink(lockPath);
        }
      },
    };
  } catch (error) {
    if (store !== null) {
      try {
        store.close();
      } catch {
        // Preserve startup error.
      }
    }
    if (ownsLock) {
      ownsLock = false;
      try {
        await unlink(lockPath);
      } catch {
        // Preserve startup error. The lock was created by this startup attempt.
      }
    }
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}
