import { createHash, randomUUID } from 'node:crypto';

import type { JsonObject } from './types.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const uuidGenerator: IdGenerator = {
  next: randomUUID,
};

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export function stableJson(value: JsonObject): string {
  return JSON.stringify(sortJsonObject(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortJsonObject(value: JsonObject): JsonObject {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return Object.fromEntries(
    entries.map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function sortJsonValue(value: JsonObject[string]): JsonObject[string] {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? sortJsonObject(entry)
        : sortJsonValue(entry),
    );
  }

  if (typeof value === 'object' && value !== null) {
    return sortJsonObject(value);
  }

  return value;
}
