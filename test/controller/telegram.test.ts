import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TelegramClient,
  TelegramError,
} from '../../src/controller/telegram.js';
import type { FetchLike } from '../../src/controller/telegram.js';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function requestUrlString(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function trackedResponse(
  status: number,
  rejectCancel = false,
  bodyText?: string,
): { readonly response: Response; readonly state: { cancellations: number } } {
  const state = { cancellations: 0 };
  const body = new ReadableStream<Uint8Array>({
    start: (stream) => {
      if (bodyText !== undefined) {
        stream.enqueue(new TextEncoder().encode(bodyText));
        stream.close();
      }
    },
    cancel: () => {
      state.cancellations += 1;
      if (rejectCancel) throw new Error('raw cleanup secret');
    },
  });
  return { response: new Response(body, { status }), state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Telegram HTTP client protocol handling', () => {
  it('posts long-poll settings, validates response shape, and sorts updates', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const fetcher: FetchLike = (input, init) => {
      requestUrl = requestUrlString(input);
      if (typeof init?.body !== 'string')
        throw new Error('Expected JSON request body.');
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 9 },
              {
                update_id: 6,
                message: {
                  message_id: 8,
                  chat: { id: -10022, type: 'supergroup' },
                  from: { id: 11 },
                  text: 'ignored group',
                },
              },
              {
                update_id: 3,
                message: {
                  message_id: 4,
                  chat: { id: 22, type: 'private' },
                  from: { id: 11 },
                  text: 'hi',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    };
    const updates = await new TelegramClient(TOKEN, fetcher).getUpdates(
      7,
      new AbortController().signal,
    );
    expect(requestUrl).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(requestBody).toEqual({
      offset: 7,
      timeout: 25,
      allowed_updates: ['message'],
    });
    expect(updates.map((update) => update.update_id)).toEqual([3, 6, 9]);
  });

  it('sends plain text without parse_mode and validates returned message identifiers', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetcher: FetchLike = (_input, init) => {
      if (typeof init?.body !== 'string')
        throw new Error('Expected JSON request body.');
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 55, chat: { id: 44 } },
          }),
          { status: 200 },
        ),
      );
    };
    await expect(
      new TelegramClient(TOKEN, fetcher).sendMessage(
        '44',
        'plain *text*',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ messageId: 55, chatId: 44 });
    expect(requestBody).toEqual({ chat_id: 44, text: 'plain *text*' });
    expect(requestBody).not.toHaveProperty('parse_mode');
  });

  it('classifies credential, conflict, rate limit, permanent, transient, and malformed responses safely', async () => {
    const cases: Array<{
      status: number;
      body: unknown;
      kind: string;
      retry?: number;
    }> = [
      { status: 401, body: { ok: false, error_code: 401 }, kind: 'credential' },
      { status: 409, body: { ok: false, error_code: 409 }, kind: 'conflict' },
      {
        status: 429,
        body: { ok: false, error_code: 429, parameters: { retry_after: 7 } },
        kind: 'rate_limited',
        retry: 7,
      },
      { status: 403, body: { ok: false, error_code: 403 }, kind: 'permanent' },
      { status: 503, body: { ok: false, error_code: 503 }, kind: 'transient' },
      { status: 200, body: { ok: true }, kind: 'transient' },
    ];
    for (const testCase of cases) {
      const client = new TelegramClient(TOKEN, () =>
        response(testCase.body, testCase.status),
      );
      await expect(
        client.getUpdates(0, new AbortController().signal),
      ).rejects.toMatchObject({
        kind: testCase.kind,
        ...(testCase.retry === undefined
          ? {}
          : { retryAfterSeconds: testCase.retry }),
      });
    }
    const malformedRetry = new TelegramClient(TOKEN, () =>
      response(
        { ok: false, error_code: 429, parameters: { retry_after: 0 } },
        429,
      ),
    );
    await expect(
      malformedRetry.getUpdates(0, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'transient' });
  });

  it('uses request deadlines and distinguishes external abort from timeout and network failure', async () => {
    vi.useFakeTimers();
    const timeoutClient = new TelegramClient(
      TOKEN,
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('secret token in fake URL'));
            },
            { once: true },
          );
        }),
    );
    const timeoutRequest = timeoutClient.getUpdates(
      0,
      new AbortController().signal,
    );
    const timeoutResult = timeoutRequest.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(35_000);
    const timeoutError = await timeoutResult;
    expect(timeoutError).toMatchObject({ kind: 'timeout' });
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).not.toContain(TOKEN);

    const abortController = new AbortController();
    const abortRequest = timeoutClient.getUpdates(0, abortController.signal);
    const abortResult = abortRequest.then(
      () => null,
      (error: unknown) => error,
    );
    abortController.abort();
    expect(await abortResult).toMatchObject({ kind: 'aborted' });

    const parsingAbortController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const delayedJson = new TelegramClient(TOKEN, (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      const waitingResponse = new Response('');
      Object.defineProperty(waitingResponse, 'json', {
        value: () =>
          new Promise<unknown>((_resolve, reject) => {
            if (requestSignal?.aborted) {
              reject(new Error('secret URL in response parser'));
              return;
            }
            requestSignal?.addEventListener(
              'abort',
              () => {
                reject(new Error('secret URL in response parser'));
              },
              { once: true },
            );
          }),
      });
      return Promise.resolve(waitingResponse);
    });
    const parsingAbort = delayedJson.getUpdates(
      0,
      parsingAbortController.signal,
    );
    const parsingAbortResult = parsingAbort.then(
      () => null,
      (error: unknown) => error,
    );
    parsingAbortController.abort();
    expect(await parsingAbortResult).toMatchObject({ kind: 'aborted' });

    const network = new TelegramClient(TOKEN, () =>
      Promise.reject(
        new Error(`failed https://api.telegram.org/bot${TOKEN}/getUpdates`),
      ),
    );
    await expect(
      network.getUpdates(0, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'network' });
    await expect(
      network.getUpdates(0, new AbortController().signal),
    ).rejects.not.toThrow(TOKEN);
  });

  it('defers text type validation until after the Router date gate', async () => {
    const client = new TelegramClient(TOKEN, () =>
      response({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 2,
              date: 3,
              chat: { id: 4, type: 'private' },
              from: { id: 4 },
              text: 42,
            },
          },
        ],
      }),
    );
    await expect(
      client.getUpdates(0, new AbortController().signal),
    ).resolves.toMatchObject([{ update_id: 1, message: { date: 3 } }]);
  });

  it('rejects malformed update IDs and contradictory Telegram envelopes', async () => {
    const invalidUpdate = new TelegramClient(TOKEN, () =>
      response({
        ok: true,
        result: [{ update_id: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    );
    await expect(
      invalidUpdate.getUpdates(0, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'transient' });

    const contradictory = new TelegramClient(TOKEN, () =>
      response({ ok: true, result: [] }, 500),
    );
    await expect(
      contradictory.getUpdates(0, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect(new TelegramError('network').message).not.toContain(TOKEN);
  });

  it('classifies HTTP failures before parsing a response body', async () => {
    const cases = [
      { status: 401, kind: 'credential' },
      { status: 409, kind: 'conflict' },
      { status: 429, kind: 'transient' },
      { status: 503, kind: 'transient' },
      { status: 403, kind: 'permanent' },
    ] as const;
    for (const testCase of cases) {
      const client = new TelegramClient(TOKEN, () =>
        Promise.resolve(new Response('not-json', { status: testCase.status })),
      );
      await expect(
        client.getUpdates(0, new AbortController().signal),
      ).rejects.toMatchObject({ kind: testCase.kind });
    }

    const rateLimited = new TelegramClient(TOKEN, () =>
      response(
        { ok: false, error_code: 429, parameters: { retry_after: 3 } },
        429,
      ),
    );
    await expect(
      rateLimited.getUpdates(0, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 3 });
  });

  it('cancels unread HTTP error bodies and aborts the request resource', async () => {
    for (const testCase of [
      { status: 401, kind: 'credential' },
      { status: 503, kind: 'transient' },
    ] as const) {
      const tracked = trackedResponse(testCase.status);
      let requestSignal: AbortSignal | undefined;
      const client = new TelegramClient(TOKEN, (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return Promise.resolve(tracked.response);
      });
      await expect(
        client.getUpdates(0, new AbortController().signal),
      ).rejects.toMatchObject({ kind: testCase.kind });
      expect(tracked.state.cancellations).toBe(1);
      expect(requestSignal?.aborted).toBe(true);
    }
  });

  it('does not cancel a response body consumed by successful JSON parsing', async () => {
    const tracked = trackedResponse(200, false, '{"ok":true,"result":[]}');
    const client = new TelegramClient(TOKEN, () =>
      Promise.resolve(tracked.response),
    );
    await expect(
      client.getUpdates(0, new AbortController().signal),
    ).resolves.toEqual([]);
    expect(tracked.state.cancellations).toBe(0);
  });

  it('does not replace HTTP classification when unread-body cleanup rejects', async () => {
    for (const testCase of [
      { status: 401, kind: 'credential' },
      { status: 503, kind: 'transient' },
    ] as const) {
      const tracked = trackedResponse(testCase.status, true);
      const client = new TelegramClient(TOKEN, () =>
        Promise.resolve(tracked.response),
      );
      await expect(
        client.getUpdates(0, new AbortController().signal),
      ).rejects.toMatchObject({ kind: testCase.kind });
      expect(tracked.state.cancellations).toBe(1);
    }
  });

  it('treats successful-status protocol ambiguity as transient', async () => {
    const bodies: unknown[] = [
      { ok: true },
      { ok: true, result: [], error_code: 200 },
      { ok: false, error_code: '401' },
      { ok: false, error_code: 401.5 },
      { ok: false, error_code: 600 },
      { ok: true, result: [{ update_id: 1, message: {} }] },
    ];
    for (const body of bodies) {
      const client = new TelegramClient(TOKEN, () => response(body));
      await expect(
        client.getUpdates(0, new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'transient' });
    }

    const invalidJson = new TelegramClient(TOKEN, () =>
      Promise.resolve(new Response('{broken', { status: 200 })),
    );
    await expect(
      invalidJson.getUpdates(0, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'transient' });

    const validErrorCodes = [
      { error_code: 401, kind: 'credential' },
      { error_code: 409, kind: 'conflict' },
      { error_code: 429, kind: 'transient' },
      { error_code: 503, kind: 'transient' },
      { error_code: 403, kind: 'permanent' },
    ] as const;
    for (const testCase of validErrorCodes) {
      const client = new TelegramClient(TOKEN, () =>
        response({ ok: false, error_code: testCase.error_code }),
      );
      await expect(
        client.getUpdates(0, new AbortController().signal),
      ).rejects.toMatchObject({ kind: testCase.kind });
    }
  });

  it('does not accept malformed or mismatched sendMessage results as delivered', async () => {
    const malformed: unknown[] = [
      null,
      { message_id: 55, chat: {} },
      { message_id: 0, chat: { id: 44 } },
      { message_id: 55, chat: { id: 45 } },
    ];
    for (const result of malformed) {
      const client = new TelegramClient(TOKEN, () =>
        response({ ok: true, result }),
      );
      await expect(
        client.sendMessage('44', 'text', new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'transient' });
    }
  });
});
