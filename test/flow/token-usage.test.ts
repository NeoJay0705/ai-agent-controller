import { describe, expect, it } from 'vitest';

import { normalizeUsage } from '../../src/flow/token-usage.js';

describe('normalizeUsage', () => {
  it('does not add parent totals to their component token counts', () => {
    expect(
      normalizeUsage({
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
        reasoning: 2,
        cacheWrite1h: 1,
      }),
    ).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
    });
  });

  it.each([
    { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 18 },
    {
      input: undefined,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 7,
    },
    { input: -1, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 6 },
    {
      input: Number.NaN,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 6,
    },
    {
      input: Number.POSITIVE_INFINITY,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 6,
    },
    { input: 1.5, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 8 },
    {
      input: Number.MAX_SAFE_INTEGER,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  ])('rejects malformed, inconsistent, or untrusted counts %#', (usage) => {
    expect(normalizeUsage(usage)).toBeNull();
  });
});
