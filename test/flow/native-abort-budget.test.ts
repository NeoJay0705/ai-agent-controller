import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';
import type { Model } from '@earendil-works/pi-ai';

describe('native provider abort before fetch', () => {
  it('does not issue a loopback request when onPayload aborts the request signal', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('No loopback address');
    const controller = new AbortController();
    const model: Model<'openai-completions'> = {
      id: 'synthetic-abort-model',
      name: 'Synthetic abort model',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      input: ['text'],
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 32,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    try {
      const events = streamCompletions(
        model,
        {
          messages: [
            { role: 'user', content: 'synthetic', timestamp: Date.now() },
          ],
        } as never,
        {
          apiKey: 'synthetic-only-flow-key',
          signal: controller.signal,
          onPayload: () => {
            controller.abort();
          },
          maxRetries: 0,
        },
      );
      for await (const event of events) {
        expect(event).toBeDefined();
      }
      expect(controller.signal.aborted).toBe(true);
      expect(requests).toBe(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('does not issue an OpenAI Responses loopback request when onPayload aborts', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('No loopback address');
    const controller = new AbortController();
    let payloadCalled = false;
    const model: Model<'openai-responses'> = {
      id: 'synthetic-abort-model',
      name: 'Synthetic abort model',
      api: 'openai-responses',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      input: ['text'],
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 32,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    try {
      const events = streamResponses(
        model,
        {
          messages: [
            { role: 'user', content: 'synthetic', timestamp: Date.now() },
          ],
        } as never,
        {
          apiKey: 'synthetic-only-flow-key',
          signal: controller.signal,
          onPayload: () => {
            payloadCalled = true;
            controller.abort();
          },
          maxRetries: 0,
        },
      );
      for await (const event of events) {
        expect(event).toBeDefined();
      }
      expect(payloadCalled).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(requests).toBe(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
