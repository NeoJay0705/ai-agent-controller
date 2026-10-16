import type { FlowBundle } from './types.js';
import {
  FLOW_SERVER_HANDLER_NAMES,
  FLOW_TOOL_NAMES,
  validateFlowBundle,
  type FlowRegistryOptions,
} from './registry.js';
import { FLOW_CONTRACT_IDS } from './types.js';

export const MAX_FLOW_CONFIG_BYTES = 256 * 1024;
export const MAX_FLOW_CONFIG_NODES = 20_000;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+\S+/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Parse bounded JSON data only. This function never reads files or evaluates code. */
export function parseFlowBundleConfig(
  text: string,
  options?: FlowRegistryOptions,
): FlowBundle {
  if (Buffer.byteLength(text, 'utf8') > MAX_FLOW_CONFIG_BYTES) {
    throw new TypeError('Flow configuration exceeds the 256 KiB size limit.');
  }
  if (/!shell\b/i.test(text)) {
    throw new TypeError('Shell-tagged configuration is not supported.');
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Flow configuration must be valid JSON.');
  }
  rejectSecretValues(value, { count: 0 }, 0);
  const registryOptions = {
    registeredValidatorNames: new Set(
      options?.registeredValidatorNames ?? FLOW_CONTRACT_IDS,
    ),
    registeredToolNames: new Set(
      options?.registeredToolNames ?? FLOW_TOOL_NAMES,
    ),
    registeredServerHandlerNames: new Set(
      options?.registeredServerHandlerNames ?? FLOW_SERVER_HANDLER_NAMES,
    ),
  };
  return validateFlowBundle(value, registryOptions);
}

function rejectSecretValues(
  value: unknown,
  budget: { count: number },
  depth: number,
): void {
  if (depth > 32) {
    throw new TypeError('Flow configuration is nested too deeply.');
  }
  budget.count += 1;
  if (budget.count > MAX_FLOW_CONFIG_NODES) {
    throw new TypeError('Flow configuration contains too many values.');
  }
  if (typeof value === 'string') {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new TypeError(
        'Flow configuration contains a credential-like value.',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretValues(item, budget, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:api[_-]?key|token|secret|password)$/i.test(key)) {
      throw new TypeError(
        'Flow configuration contains a forbidden secret field.',
      );
    }
    rejectSecretValues(item, budget, depth + 1);
  }
}
