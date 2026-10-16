import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { openControllerResources } from '../../src/controller/lifecycle.js';
import { ControllerStore } from '../../src/controller/store.js';
import {
  ControllerService as ProductionControllerService,
  type ServiceOptions,
} from '../../src/controller/service.js';
import type { ControllerResources } from '../../src/controller/lifecycle.js';
import type { ControllerConfig } from '../../src/controller/types.js';
import { TelegramClient } from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';
import {
  artifactsPath,
  ensureArtifactsDirectory,
  flushTasks,
  testConfig,
  testFlowBundle,
  UNSUPPORTED_AGENT_RUNTIME,
  waitUntil,
} from './helpers.js';

type BotConfig = Extract<ControllerConfig, { readonly mode: 'bot' }>;

class ControllerService extends ProductionControllerService {
  constructor(
    config: BotConfig,
    resources: ControllerResources,
    telegram: TelegramClient,
    options: ServiceOptions = {},
  ) {
    super(config, resources, telegram, testFlowBundle(), {
      ...options,
      agentRuntimeForTests:
        options.agentRuntimeForTests ?? UNSUPPORTED_AGENT_RUNTIME,
    });
  }
}

function createLegacyV1Database(path: string, offset: string): void {
  const store = new ControllerStore(new DatabaseSync(path));
  store.close();
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      DROP TABLE trial_usage_events;
      DROP TABLE trial_usage_operations;
      DROP TABLE command_menu_sync;
      DROP TABLE command_dialogs;
      DROP TABLE trial_invites;
      DROP TABLE trial_events;
      DROP TABLE trial_users;
      ALTER TABLE outbox DROP COLUMN delivery_class;
      DROP TABLE outbox_cancellations;
      DROP TABLE pi_sessions;
      DROP TABLE session_facts;
      DROP TABLE flow_runs;
      ALTER TABLE outbox DROP COLUMN prompt_generation;
      ALTER TABLE prompt_bindings DROP COLUMN generation;
      PRAGMA user_version = 1;
    `);
    database
      .prepare("UPDATE meta SET value=? WHERE key='next_poll_offset'")
      .run(offset);
  } finally {
    database.close();
  }
}

describe('controller resources and service lifecycle', () => {
  it('uses a private data directory, kernel lock metadata, and retains its anchor', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('lock-dir').replace(/\.sqlite$/, '');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const resources = await openControllerResources(config);
    const lockPath = join(dataDir, 'controller.lock');
    const firstMarker = JSON.parse(await readFile(lockPath, 'utf8')) as {
      version: number;
      kind: string;
      pid: number;
      token: string;
      anchorDev: string;
      anchorIno: string;
    };
    expect(firstMarker).toMatchObject({
      version: 1,
      kind: 'controller-kernel-lock',
      pid: process.pid,
    });
    expect(firstMarker.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstMarker.anchorDev).toMatch(/^\d+$/);
    expect(firstMarker.anchorIno).toMatch(/^\d+$/);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, 'controller.sqlite'))).mode & 0o777).toBe(
      0o600,
    );
    await expect(openControllerResources(config)).rejects.toThrow(
      /lock already exists/,
    );
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(firstMarker);
    await resources.close();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await stat(join(dataDir, 'controller.kernel.lock'))).mode & 0o777,
    ).toBe(0o600);
    const second = await openControllerResources(config);
    await second.close();
    expect(await stat(join(dataDir, 'controller.kernel.lock'))).toBeDefined();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('opens, migrates, closes, and reopens a complete synthetic v1 legacy database', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('legacy-v1-lock').replace(/\.sqlite$/, '');
    const databasePath = join(dataDir, 'controller.sqlite');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      createLegacyV1Database(databasePath, '11.0');
      const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
      const resources = await openControllerResources(config);
      expect(resources.store.getOffset()).toBe(11);
      expect(
        resources.store.database
          .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
          .get(),
      ).toEqual({ value: '11' });
      expect(
        resources.store.database.prepare('PRAGMA user_version').get(),
      ).toMatchObject({ user_version: 3 });
      await resources.close();
      await expect(
        stat(join(dataDir, 'controller.lock')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const reopened = await openControllerResources(config);
      expect(reopened.store.getOffset()).toBe(11);
      await reopened.close();
      await expect(
        stat(join(dataDir, 'controller.lock')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('releases its lock and does not rebuild a database with invalid v1 metadata', async () => {
    await ensureArtifactsDirectory();
    const dataDir = artifactsPath('legacy-v1-bad-offset').replace(
      /\.sqlite$/,
      '',
    );
    const databasePath = join(dataDir, 'controller.sqlite');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      createLegacyV1Database(databasePath, '-1');
      const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
      await expect(openControllerResources(config)).rejects.toThrow(
        'Controller database metadata is incomplete.',
      );
      await expect(
        stat(join(dataDir, 'controller.lock')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const database = new DatabaseSync(databasePath);
      try {
        expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
          user_version: 1,
        });
        expect(
          database
            .prepare("SELECT value FROM meta WHERE key='next_poll_offset'")
            .get(),
        ).toEqual({ value: '-1' });
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
            )
            .get(),
        ).toEqual({ name: 'sessions' });
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='flow_runs'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
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
    let fetchCalls = 0;
    const fetcher: FetchLike = () => {
      fetchCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
      );
    };
    const service = new ControllerService(
      config,
      resources,
      new TelegramClient(config.token, fetcher),
    );
    service.start();
    await flushTasks();
    await service.stop();
    expect(fetchCalls).toBe(0);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    await waitUntil(() => fatal !== undefined);
    expect(fatal).toBe('credential');
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
});
