import { describe, expect, it } from 'vitest';

import { parseControllerConfig } from '../../src/controller/config.js';
import { TEST_TOKEN, USER_ID } from './helpers.js';

describe('controller configuration', () => {
  it('supports health-only mode and applies documented defaults', () => {
    const config = parseControllerConfig({}, '/workspace');
    expect(config).toMatchObject({
      mode: 'health',
      dataDir: '/workspace/data',
      concurrency: 2,
      stepMs: 1000,
      timeoutMs: 60_000,
      maxPendingJobs: 100,
      maxPendingSteering: 100,
      host: '0.0.0.0',
      port: 3000,
    });
  });

  it('requires both valid Telegram settings and keeps user IDs numeric', () => {
    expect(
      parseControllerConfig(
        { TELEGRAM_BOT_TOKEN: TEST_TOKEN, TELEGRAM_ALLOWED_USER_ID: USER_ID },
        '/workspace',
      ),
    ).toMatchObject({ mode: 'bot', token: TEST_TOKEN, allowedUserId: USER_ID });
    expect(() =>
      parseControllerConfig({ TELEGRAM_BOT_TOKEN: TEST_TOKEN }),
    ).toThrow(/must be set together/);
    expect(() =>
      parseControllerConfig({ TELEGRAM_ALLOWED_USER_ID: USER_ID }),
    ).toThrow(/must be set together/);
    expect(() =>
      parseControllerConfig({
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_ALLOWED_USER_ID: '',
      }),
    ).toThrow(/invalid format/);
    expect(() =>
      parseControllerConfig({
        TELEGRAM_BOT_TOKEN: TEST_TOKEN,
        TELEGRAM_ALLOWED_USER_ID: '9007199254740992',
      }),
    ).toThrow(/positive safe integer/);
    expect(() =>
      parseControllerConfig({
        TELEGRAM_BOT_TOKEN: TEST_TOKEN,
        TELEGRAM_ALLOWED_USER_ID: '0',
      }),
    ).toThrow(/positive safe integer/);
  });

  it('validates numeric bounds and resolves relative data paths against startup cwd', () => {
    const config = parseControllerConfig(
      {
        TELEGRAM_BOT_TOKEN: TEST_TOKEN,
        TELEGRAM_ALLOWED_USER_ID: USER_ID,
        CONTROLLER_DATA_DIR: 'state',
        JOB_CONCURRENCY: '4',
        DEMO_STEP_MS: '2147483647',
        JOB_TIMEOUT_MS: '5000',
        MAX_PENDING_JOBS: '25',
        MAX_PENDING_STEERING: '10',
        PORT: '8080',
      },
      '/workspace',
    );
    expect(config).toMatchObject({
      dataDir: '/workspace/state',
      concurrency: 4,
      stepMs: 2_147_483_647,
      timeoutMs: 5000,
      maxPendingJobs: 25,
      maxPendingSteering: 10,
      port: 8080,
    });
    for (const [name, value] of [
      ['JOB_CONCURRENCY', '0'],
      ['DEMO_STEP_MS', '2147483648'],
      ['JOB_TIMEOUT_MS', '1.5'],
      ['MAX_PENDING_JOBS', '-1'],
      ['PORT', '65536'],
    ] as const) {
      expect(() =>
        parseControllerConfig(
          {
            TELEGRAM_BOT_TOKEN: TEST_TOKEN,
            TELEGRAM_ALLOWED_USER_ID: USER_ID,
            [name]: value,
          },
          '/workspace',
        ),
      ).toThrow(new RegExp(name));
    }
  });
});
