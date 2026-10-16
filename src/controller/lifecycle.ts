import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ControllerConfig } from './types.js';
import { ControllerStore, restrictDatabaseFile } from './store.js';
import { acquireControllerKernelLock } from './lock.js';

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
  let lease: Awaited<ReturnType<typeof acquireControllerKernelLock>> | null =
    null;
  let store: ControllerStore | null = null;
  let database: DatabaseSync | null = null;
  let closePromise: Promise<void> | null = null;
  try {
    lease = await acquireControllerKernelLock(config.dataDir);
    const databasePath = join(config.dataDir, 'controller.sqlite');
    database = new DatabaseSync(databasePath);
    store = new ControllerStore(database, options);
    await restrictDatabaseFile(databasePath);
    const openedStore = store;
    const heldLease = lease;
    return {
      store: openedStore,
      close: () => {
        if (closePromise !== null) return closePromise;
        closePromise = (async () => {
          openedStore.close();
          await heldLease.release();
        })();
        return closePromise;
      },
    };
  } catch (error) {
    let databaseClosed = store === null && database === null;
    if (store !== null) {
      try {
        store.close();
        databaseClosed = true;
      } catch {
        // Preserve startup error and keep the kernel lease held.
      }
    } else if (database !== null) {
      if (!database.isOpen) databaseClosed = true;
      else {
        try {
          database.close();
          databaseClosed = true;
        } catch {
          // Preserve startup error and keep the kernel lease held.
        }
      }
    }
    if (lease !== null && databaseClosed)
      await lease.release().catch(() => undefined);
    throw error;
  }
}
