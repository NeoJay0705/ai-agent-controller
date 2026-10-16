import { isAbsolute, resolve } from 'node:path';

import type { ControllerConfig } from './types.js';

export type Environment = Readonly<Record<string, string | undefined>>;

const MAX_TIMER = 2_147_483_647;

export function parseControllerConfig(
  env: Environment,
  cwd = process.cwd(),
): ControllerConfig {
  const tokenValue = env['TELEGRAM_BOT_TOKEN'];
  const userValue = env['TELEGRAM_ALLOWED_USER_ID'];
  const tokenSet = tokenValue !== undefined;
  const userSet = userValue !== undefined;
  if (tokenSet !== userSet) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID must be set together',
    );
  }

  const botMode = tokenSet && userSet;
  let flowConfigPath = '';
  let piAuthFile: string | undefined;
  if (botMode) {
    const flowConfigValue = env['PI_FLOW_CONFIG'];
    if (flowConfigValue === undefined || flowConfigValue.trim().length === 0) {
      throw new Error('PI_FLOW_CONFIG is required in bot mode');
    }
    flowConfigPath = isAbsolute(flowConfigValue)
      ? flowConfigValue
      : resolve(cwd, flowConfigValue);
    const piAuthFileValue = env['PI_FLOW_AUTH_FILE'];
    if (piAuthFileValue !== undefined) {
      if (piAuthFileValue.trim().length === 0) {
        throw new Error('PI_FLOW_AUTH_FILE must not be empty in bot mode');
      }
      piAuthFile = resolve(cwd, piAuthFileValue);
    }
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(tokenValue)) {
      throw new Error('TELEGRAM_BOT_TOKEN has an invalid format');
    }
    if (
      !/^\d+$/.test(userValue) ||
      !Number.isSafeInteger(Number(userValue)) ||
      Number(userValue) <= 0
    ) {
      throw new Error(
        'TELEGRAM_ALLOWED_USER_ID must be a positive safe integer',
      );
    }
  }

  const dataDirValue = env['CONTROLLER_DATA_DIR'] ?? './data';
  if (dataDirValue.trim().length === 0) {
    throw new Error('CONTROLLER_DATA_DIR must not be empty');
  }
  const dataDir = isAbsolute(dataDirValue)
    ? dataDirValue
    : resolve(cwd, dataDirValue);

  const common = {
    dataDir,
    concurrency: positiveInteger(env, 'JOB_CONCURRENCY', 2, 128),
    stepMs: positiveInteger(env, 'DEMO_STEP_MS', 1000, MAX_TIMER),
    timeoutMs: positiveInteger(env, 'JOB_TIMEOUT_MS', 60_000, MAX_TIMER),
    maxPendingJobs: positiveInteger(env, 'MAX_PENDING_JOBS', 100, 100_000),
    maxPendingSteering: positiveInteger(
      env,
      'MAX_PENDING_STEERING',
      100,
      100_000,
    ),
    host: env['HOST'] ?? '0.0.0.0',
    port: positiveInteger(env, 'PORT', 3000, 65_535),
  };
  if (botMode) {
    return {
      ...common,
      mode: 'bot',
      token: tokenValue,
      allowedUserId: String(Number(userValue)),
      flowConfigPath,
      ...(piAuthFile === undefined ? {} : { piAuthFile }),
    };
  }
  return { ...common, mode: 'health' };
}

function positiveInteger(
  env: Environment,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${String(maximum)}`);
  }
  return parsed;
}
