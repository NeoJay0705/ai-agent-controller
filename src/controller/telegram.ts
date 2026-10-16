import type {
  TelegramMessage,
  TelegramSentMessage,
  TelegramUpdate,
} from './types.js';

export type TelegramErrorKind =
  | 'network'
  | 'timeout'
  | 'transient'
  | 'rate_limited'
  | 'permanent'
  | 'credential'
  | 'conflict'
  | 'aborted';

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfterSeconds?: number;

  constructor(kind: TelegramErrorKind, retryAfterSeconds?: number) {
    super(`Telegram request failed (${kind}).`);
    this.name = 'TelegramError';
    this.kind = kind;
    if (retryAfterSeconds !== undefined)
      this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type FetchLike = typeof fetch;

export class TelegramClient {
  private readonly token: string;
  private readonly fetcher: FetchLike;

  constructor(token: string, fetcher: FetchLike = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  async getUpdates(
    offset: number,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]> {
    const result = await this.request<unknown>(
      'getUpdates',
      { offset, timeout: 25, allowed_updates: ['message'] },
      signal,
      35_000,
    );
    if (!Array.isArray(result)) throw new TelegramError('transient');
    const updates = result.map(validateUpdate);
    return updates.sort((left, right) => left.update_id - right.update_id);
  }

  async sendMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<TelegramSentMessage> {
    const requestedChatId = positiveSafeInteger(Number(chatId));
    if (requestedChatId === null) throw new TelegramError('permanent');
    const result = await this.request<unknown>(
      'sendMessage',
      { chat_id: requestedChatId, text },
      signal,
      10_000,
    );
    if (!isRecord(result)) throw new TelegramError('transient');
    const messageId = positiveSafeInteger(result['message_id']);
    const chat = result['chat'];
    if (!isRecord(chat)) throw new TelegramError('transient');
    const returnedChatId = positiveSafeInteger(chat['id']);
    if (
      messageId === null ||
      returnedChatId === null ||
      returnedChatId !== requestedChatId
    ) {
      throw new TelegramError('transient');
    }
    return { messageId, chatId: returnedChatId };
  }

  private async request<T>(
    method: 'getUpdates' | 'sendMessage',
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const requestState = { timedOut: false, externalAbortRequested: false };
    const timeout = setTimeout(() => {
      requestState.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => {
      requestState.externalAbortRequested = true;
      controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let response: Response | undefined;
    try {
      try {
        response = await this.fetcher(
          `https://api.telegram.org/bot${this.token}/${method}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
      } catch {
        if (requestState.externalAbortRequested)
          throw new TelegramError('aborted');
        if (requestState.timedOut) throw new TelegramError('timeout');
        throw new TelegramError('network');
      }

      const status = response.status;
      if (requestState.externalAbortRequested)
        throw new TelegramError('aborted');
      if (requestState.timedOut) throw new TelegramError('timeout');
      if (status === 401) throw new TelegramError('credential');
      if (status === 409) throw new TelegramError('conflict');
      if (status === 429) {
        const envelope = await readEnvelope(response, requestState);
        const retryAfter = retryAfterValue(envelope);
        if (retryAfter === null) throw new TelegramError('transient');
        throw new TelegramError('rate_limited', retryAfter);
      }
      if (status >= 500 && status <= 599) throw new TelegramError('transient');
      if (status >= 400 && status <= 499) throw new TelegramError('permanent');
      if (status < 200 || status >= 300) throw new TelegramError('transient');

      const envelope = await readEnvelope(response, requestState);
      if (!isRecord(envelope) || typeof envelope['ok'] !== 'boolean') {
        throw new TelegramError('transient');
      }
      if (!envelope['ok']) {
        const errorCode = telegramErrorCode(envelope['error_code']);
        if (errorCode === null) throw new TelegramError('transient');
        if (errorCode === 401) throw new TelegramError('credential');
        if (errorCode === 409) throw new TelegramError('conflict');
        if (errorCode === 429) {
          const retryAfter = retryAfterValue(envelope);
          if (retryAfter !== null)
            throw new TelegramError('rate_limited', retryAfter);
          throw new TelegramError('transient');
        }
        if (errorCode >= 500) throw new TelegramError('transient');
        if (errorCode < 400) throw new TelegramError('transient');
        throw new TelegramError('permanent');
      }
      if (Object.hasOwn(envelope, 'error_code'))
        throw new TelegramError('transient');
      if (!Object.hasOwn(envelope, 'result'))
        throw new TelegramError('transient');
      return envelope['result'] as T;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      controller.abort();
      if (
        response !== undefined &&
        response.body !== null &&
        !response.bodyUsed
      ) {
        try {
          await response.body.cancel();
        } catch {
          // Cleanup errors must not replace the request classification.
        }
      }
    }
  }
}

async function readEnvelope(
  response: Response,
  requestState: {
    readonly timedOut: boolean;
    readonly externalAbortRequested: boolean;
  },
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (requestState.externalAbortRequested) throw new TelegramError('aborted');
    if (requestState.timedOut) throw new TelegramError('timeout');
    throw new TelegramError('transient');
  }
}

function telegramErrorCode(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function validateUpdate(value: unknown): TelegramUpdate {
  if (!isRecord(value)) throw new TelegramError('transient');
  const updateId = value['update_id'];
  if (
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    updateId >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TelegramError('transient');
  }
  if (Object.hasOwn(value, 'message')) validateMessage(value['message']);
  return value as unknown as TelegramUpdate;
}

function validateMessage(value: unknown): TelegramMessage {
  if (!isRecord(value)) throw new TelegramError('transient');
  if (positiveSafeInteger(value['message_id']) === null)
    throw new TelegramError('transient');
  const chat = value['chat'];
  if (
    !isRecord(chat) ||
    safeInteger(chat['id']) === null ||
    typeof chat['type'] !== 'string'
  ) {
    throw new TelegramError('transient');
  }
  if (chat['type'] === 'private' && positiveSafeInteger(chat['id']) === null) {
    throw new TelegramError('transient');
  }
  if (value['from'] !== undefined) {
    const from = value['from'];
    if (!isRecord(from) || positiveSafeInteger(from['id']) === null)
      throw new TelegramError('transient');
  }
  if (value['reply_to_message'] !== undefined) {
    const reply = value['reply_to_message'];
    if (!isRecord(reply) || positiveSafeInteger(reply['message_id']) === null) {
      throw new TelegramError('transient');
    }
  }
  return value as unknown as TelegramMessage;
}

function retryAfterValue(value: unknown): number | null {
  if (!isRecord(value) || !isRecord(value['parameters'])) return null;
  const seconds = value['parameters']['retry_after'];
  return typeof seconds === 'number' &&
    Number.isSafeInteger(seconds) &&
    seconds >= 1 &&
    seconds <= 86_400
    ? seconds
    : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0
    ? value
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
