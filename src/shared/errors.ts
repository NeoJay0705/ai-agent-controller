export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'CONCURRENCY_LIMITED'
  | 'LLM_ERROR'
  | 'TOOL_ERROR'
  | 'DEPENDENCY_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN_OUTCOME'
  | 'CANCELLED'
  | 'LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

const defaultStatus: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 422,
  AUTHENTICATION_ERROR: 401,
  AUTHORIZATION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  CONCURRENCY_LIMITED: 429,
  LLM_ERROR: 502,
  TOOL_ERROR: 502,
  DEPENDENCY_ERROR: 503,
  TIMEOUT: 504,
  UNKNOWN_OUTCOME: 502,
  CANCELLED: 409,
  LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly statusCode?: number;
      readonly details?: Readonly<Record<string, string>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = options.statusCode ?? defaultStatus[code];
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  options: ConstructorParameters<typeof DomainError>[2] = {},
): never {
  throw new DomainError(code, message, options);
}
