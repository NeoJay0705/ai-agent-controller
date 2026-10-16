/** Provider-reported token usage. Unknown or inconsistent records return null. */
export interface NormalizedUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export function normalizeUsage(value: unknown): NormalizedUsage | null {
  if (!isRecord(value)) return null;
  const fields = [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'totalTokens',
  ] as const;
  if (fields.some((key) => !isTokenCount(value[key]))) return null;
  const input = value['input'] as number;
  const output = value['output'] as number;
  const cacheRead = value['cacheRead'] as number;
  const cacheWrite = value['cacheWrite'] as number;
  const totalTokens = value['totalTokens'] as number;
  const sum = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(sum) || totalTokens <= 0 || totalTokens !== sum)
    return null;
  if (
    value['reasoning'] !== undefined &&
    (!isTokenCount(value['reasoning']) || value['reasoning'] > output)
  )
    return null;
  if (
    value['cacheWrite1h'] !== undefined &&
    (!isTokenCount(value['cacheWrite1h']) || value['cacheWrite1h'] > cacheWrite)
  )
    return null;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
