import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { MAX_FLOW_CONFIG_BYTES, parseFlowBundleConfig } from './config.js';
import { effectiveNodeRuntime } from './registry.js';
import type { FlowRegistryOptions } from './registry.js';
import type { FlowBundle } from './types.js';

const PI_AUTH_FILE_REQUIRED_MESSAGE =
  'PI_FLOW_AUTH_FILE is required for pi-login authentication.';

export type FlowConfigLoadErrorCode =
  'FLOW_CONFIG_MISSING' | 'FLOW_CONFIG_INVALID' | 'FLOW_CONFIG_TOO_LARGE';

/** Safe public classification for trusted local Flow configuration failures. */
export class FlowConfigLoadError extends Error {
  readonly code: FlowConfigLoadErrorCode;

  constructor(code: FlowConfigLoadErrorCode) {
    super(code);
    this.name = 'FlowConfigLoadError';
    this.code = code;
  }
}

/** Require an absolute auth source path when a Flow uses Pi login. */
export function assertFlowAuthConfiguration(
  bundle: FlowBundle,
  piAuthFile: string | undefined,
): void {
  const requiresPiAuthFile = bundle.flows.some((flow) =>
    flow.nodes.some(
      (node) =>
        node.kind === 'agent' &&
        effectiveNodeRuntime(flow, node).auth?.mode === 'pi-login',
    ),
  );
  if (!requiresPiAuthFile) return;
  if (
    typeof piAuthFile !== 'string' ||
    piAuthFile.trim().length === 0 ||
    !isAbsolute(piAuthFile) ||
    resolve(piAuthFile) !== piAuthFile
  ) {
    throw new Error(PI_AUTH_FILE_REQUIRED_MESSAGE);
  }
}

/** Load one trusted local JSON file without following symlinks or unbounded reads. */
export async function loadFlowBundleConfig(
  path: string,
  options?: FlowRegistryOptions,
): Promise<FlowBundle> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissing(error)) throw new FlowConfigLoadError('FLOW_CONFIG_MISSING');
    throw new FlowConfigLoadError('FLOW_CONFIG_INVALID');
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new FlowConfigLoadError('FLOW_CONFIG_INVALID');
    if (before.size > BigInt(MAX_FLOW_CONFIG_BYTES)) {
      throw new FlowConfigLoadError('FLOW_CONFIG_TOO_LARGE');
    }

    const buffer = Buffer.allocUnsafe(MAX_FLOW_CONFIG_BYTES + 1);
    let position = 0;
    try {
      while (position < buffer.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          position,
          buffer.byteLength - position,
          position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
      }

      if (position > MAX_FLOW_CONFIG_BYTES) {
        throw new FlowConfigLoadError('FLOW_CONFIG_TOO_LARGE');
      }
      const after = await handle.stat({ bigint: true });
      if (
        !after.isFile() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        after.size !== BigInt(position) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new FlowConfigLoadError('FLOW_CONFIG_INVALID');
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, position),
        );
      } catch {
        throw new FlowConfigLoadError('FLOW_CONFIG_INVALID');
      }
      try {
        return parseFlowBundleConfig(text, options);
      } catch {
        throw new FlowConfigLoadError('FLOW_CONFIG_INVALID');
      }
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof FlowConfigLoadError) throw error;
    throw new FlowConfigLoadError('FLOW_CONFIG_INVALID');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
