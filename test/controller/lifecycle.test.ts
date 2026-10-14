import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { openControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerService } from '../../src/controller/service.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import {
  artifactsPath,
  ensureArtifactsDirectory,
  flushTasks,
  testConfig,
  waitUntil,
} from './helpers.js';

describe('controller resources and service lifecycle', () => {
  it('uses a private data directory, exclusive PID lock, and releases only its own lock', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('lock-dir').replace(/\.sqlite$/, '');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const resources = await openControllerResources(config);
    const lockPath = join(dataDir, 'controller.lock');
    expect(await readFile(lockPath, 'utf8')).toMatch(/^\d+\n$/);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, 'controller.sqlite'))).mode & 0o777).toBe(
      0o600,
    );
    await expect(openControllerResources(config)).rejects.toThrow(
      /lock already exists/,
    );
    expect(await readFile(lockPath, 'utf8')).toMatch(/^\d+\n$/);
    await resources.close();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await openControllerResources(config);
    await second.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects unknown database versions without replacing the database and releases its acquired lock', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('unknown-schema').replace(/\.sqlite$/, '');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = join(dataDir, 'controller.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 99');
    database.close();
    await chmod(databasePath, 0o600);
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    await expect(openControllerResources(config)).rejects.toThrow(
      /Unsupported controller database schema version 99/,
    );
    const reopened = new DatabaseSync(databasePath);
    expect(reopened.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 99,
    });
    expect(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='sessions'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    reopened.close();
    await expect(stat(join(dataDir, 'controller.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stops loops, closes SQLite, releases lock, and allows a later controller to start', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('service-stop').replace(/\.sqlite$/, '');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const resources = await openControllerResources(config);
    const fetcher: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
      );
    const service = new ControllerService(
      config,
      resources,
      new TelegramClient(config.token, fetcher),
    );
    service.start();
    await flushTasks();
    await service.stop();
    const next = await openControllerResources(config);
    await next.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stops polling on fatal credential errors and reports only a safe classification', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('service-fatal').replace(/\.sqlite$/, '');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const resources = await openControllerResources(config);
    const fetcher: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error_code: 401 }), {
          status: 401,
        }),
      );
    let fatal: string | undefined;
    const service = new ControllerService(
      config,
      resources,
      new TelegramClient(config.token, fetcher),
      {
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        onFatal: (classification) => {
          fatal = classification;
        },
      },
    );
    service.start();
    await waitUntil(() => fatal !== undefined);
    expect(fatal).toBe('credential');
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
});
