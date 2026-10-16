import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  PiRpcClient,
  type PiRpcClientOptions,
  type PiRpcCommand,
} from '../../src/flow/pi-rpc-client.js';

const BASE_OPTIONS = {
  nodePath: process.execPath,
  args: [],
  cwd: process.cwd(),
  env: {},
  requestTimeoutMs: 1_000,
  shutdownTimeoutMs: 100,
  terminationTimeoutMs: 100,
};

type FakeWriteMode =
  | 'normal'
  | 'backpressure'
  | 'callback-error'
  | 'stdin-close-before-drain'
  | 'child-close-before-drain'
  | 'accepted-true-early-error'
  | 'timeout'
  | 'manual-response';

interface PendingFakeRequest {
  readonly command: PiRpcCommand['type'];
  readonly id: string;
}

class FakeStdin extends EventEmitter {
  destroyed = false;
  writable = true;
  writeCallback: ((error?: Error | null) => void) | undefined;
  pendingRequest: PendingFakeRequest | undefined;
  readonly requests: PendingFakeRequest[] = [];

  constructor(private readonly child: FakeChild) {
    super();
  }

  write(frame: Buffer, callback?: (error?: Error | null) => void): boolean {
    let parsed: { readonly type: PiRpcCommand['type']; readonly id: string };
    try {
      parsed = JSON.parse(frame.toString('utf8')) as {
        readonly type: PiRpcCommand['type'];
        readonly id: string;
      };
    } catch {
      throw new Error('Fake child received invalid JSON.');
    }
    const request = { command: parsed.type, id: parsed.id };
    this.pendingRequest = request;
    this.requests.push(request);
    this.writeCallback = callback;
    switch (this.child.mode) {
      case 'normal':
        setImmediate(() => {
          callback?.(null);
          this.child.respond(request);
        });
        return true;
      case 'backpressure':
      case 'timeout':
      case 'stdin-close-before-drain':
      case 'child-close-before-drain':
        if (this.child.mode === 'stdin-close-before-drain') {
          setImmediate(() => {
            this.closeStream();
          });
        } else if (this.child.mode === 'child-close-before-drain') {
          setImmediate(() => {
            this.child.terminate(1, null);
          });
        }
        return false;
      case 'callback-error':
        setImmediate(() => callback?.(new Error('synthetic write failure')));
        return true;
      case 'accepted-true-early-error':
        setImmediate(() =>
          this.emit('error', new Error('synthetic early error')),
        );
        return true;
      case 'manual-response':
        setImmediate(() => callback?.(null));
        return true;
    }
  }

  releaseDrain(): void {
    this.emit('drain');
  }

  releaseWriteCallback(error?: Error | null): void {
    this.writeCallback?.(error);
  }

  closeStream(): void {
    this.writable = false;
    this.destroyed = true;
    this.emit('close');
  }

  end(): this {
    this.writable = false;
    setImmediate(() => {
      this.emit('finish');
      this.child.terminate(0, null);
    });
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin: FakeStdin;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closed = false;

  constructor(readonly mode: FakeWriteMode) {
    super();
    this.stdin = new FakeStdin(this);
    setImmediate(() => this.emit('spawn'));
  }

  respond(
    request: PendingFakeRequest,
    data: Record<string, unknown> = {},
    ending: '\n' | '\r\n' = '\n',
  ): void {
    const response = {
      type: 'response',
      id: request.id,
      command: request.command,
      success: true,
      data,
    };
    this.stdout.write(`${JSON.stringify(response)}${ending}`);
  }

  respondInChunks(
    request: PendingFakeRequest,
    data: Record<string, unknown>,
    ending: '\n' | '\r\n' = '\r\n',
  ): void {
    const wire = Buffer.from(
      `${JSON.stringify({
        type: 'response',
        id: request.id,
        command: request.command,
        success: true,
        data,
      })}${ending}`,
      'utf8',
    );
    for (let index = 0; index < wire.length; index += 1) {
      this.stdout.write(wire.subarray(index, index + 1));
    }
  }

  kill(): boolean {
    this.terminate(0, 'SIGKILL');
    return true;
  }

  terminate(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdin.writable = false;
    this.stdin.destroyed = true;
    this.stdin.emit('close');
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function createClient(
  mode: FakeWriteMode,
  options: Partial<PiRpcClientOptions> = {},
): { readonly client: PiRpcClient; readonly child: FakeChild } {
  const child = new FakeChild(mode);
  const client = new PiRpcClient({
    ...BASE_OPTIONS,
    ...options,
    spawnForTests: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  return { client, child };
}

async function startClient(
  mode: FakeWriteMode,
  options: Partial<PiRpcClientOptions> = {},
): Promise<{ readonly client: PiRpcClient; readonly child: FakeChild }> {
  const result = createClient(mode, options);
  await result.client.start();
  return result;
}

async function closeClient(
  client: PiRpcClient,
  child: FakeChild,
): Promise<void> {
  await client.close().catch(() => undefined);
  expect(child.closed).toBe(true);
  expect(client.pendingRequestCount).toBe(0);
  expect(client.pendingWriteCount).toBe(0);
  expect(client.subscriberCount).toBe(0);
  expect(child.stdin.listenerCount('drain')).toBe(0);
  expect(child.stdin.listenerCount('error')).toBe(0);
  expect(child.stdin.listenerCount('close')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
}

describe('PiRpcClient bounded JSONL transport', () => {
  it('waits for both write callback and drain under backpressure, then removes listeners', async () => {
    const { client, child } = await startClient('backpressure');
    const request = client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(client.pendingWriteCount).toBe(1);
    expect(child.stdin.listenerCount('drain')).toBe(1);
    expect(child.stdin.listenerCount('error')).toBe(2);

    child.stdin.releaseWriteCallback();
    child.stdin.releaseDrain();
    const pending = child.stdin.pendingRequest;
    if (pending === undefined) throw new Error('Missing pending fake request.');
    child.respond(pending, { marker: 'complete' });
    await expect(request).resolves.toEqual({ marker: 'complete' });
    expect(client.pendingWriteCount).toBe(0);
    await closeClient(client, child);
  });

  it('settles callback errors and accepted-true early errors without unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const mode of [
        'callback-error',
        'accepted-true-early-error',
      ] as const) {
        const { client, child } = await startClient(mode);
        await expect(client.getState()).rejects.toMatchObject({
          code: 'FLOW_RPC_STDIN_FAILED',
        });
        await closeClient(client, child);
      }
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancels blocked writes when stdin or the child closes before drain', async () => {
    for (const mode of [
      'stdin-close-before-drain',
      'child-close-before-drain',
    ] as const) {
      const { client, child } = await startClient(mode);
      await expect(client.getState()).rejects.toMatchObject({
        code:
          mode === 'child-close-before-drain'
            ? 'FLOW_RPC_CHILD_EXITED'
            : 'FLOW_RPC_STDIN_FAILED',
      });
      await closeClient(client, child);
    }
  });

  it('cancels a blocked write on request timeout and leaves no write listeners', async () => {
    const { client, child } = await startClient('timeout', {
      requestTimeoutMs: 20,
    });
    await expect(client.getState()).rejects.toMatchObject({
      code: 'FLOW_RPC_REQUEST_TIMEOUT',
    });
    expect(client.pendingRequestCount).toBe(0);
    expect(client.pendingWriteCount).toBe(0);
    expect(child.stdin.listenerCount('drain')).toBe(0);
    await closeClient(client, child);
  });

  it('decodes segmented UTF-8 and treats only LF or CRLF as record boundaries', async () => {
    const { client, child } = await startClient('manual-response');
    const messages: string[] = [];
    const unsubscribe = client.onEvent((event) => {
      if (event.type === 'extension_ui_request') {
        messages.push(String(event['message']));
      }
    });
    const eventMessage = 'UTF-8 😀 with separators \u2028 and \u2029';
    child.stdout.write(
      `${JSON.stringify({
        type: 'extension_ui_request',
        id: '123e4567-e89b-12d3-a456-426614174000',
        method: 'notify',
        message: eventMessage,
      })}\r\n`,
    );
    const pendingRequest = client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const request = child.stdin.pendingRequest;
    if (request === undefined) throw new Error('Missing fake RPC request.');
    child.respondInChunks(request, { value: 'café 😀' }, '\r\n');
    await expect(pendingRequest).resolves.toEqual({ value: 'café 😀' });
    expect(messages).toEqual([eventMessage]);
    unsubscribe();
    await closeClient(client, child);
  });

  it('correlates interleaved responses and rejects an unknown response ID', async () => {
    const { client, child } = await startClient('manual-response');
    const stateRequest = client.getState();
    const levelsRequest = client.getAvailableThinkingLevels();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const stateCommand = child.stdin.requests[0];
    const levelsCommand = child.stdin.requests[1];
    if (stateCommand === undefined || levelsCommand === undefined) {
      throw new Error('Fake RPC requests were not captured.');
    }
    expect(child.stdin.requests).toHaveLength(2);
    child.respond(levelsCommand, { levels: ['max'] });
    child.respond(stateCommand, { model: 'expected' });
    await expect(stateRequest).resolves.toEqual({ model: 'expected' });
    await expect(levelsRequest).resolves.toEqual(['max']);
    await closeClient(client, child);

    const uncorrelated = await startClient('manual-response');
    const request = uncorrelated.client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    uncorrelated.child.stdout.write(
      `${JSON.stringify({
        type: 'response',
        id: '00000000-0000-4000-8000-000000000000',
        command: 'get_state',
        success: true,
        data: {},
      })}\n`,
    );
    await expect(request).rejects.toMatchObject({
      code: 'FLOW_RPC_PROTOCOL_INVALID',
    });
    await closeClient(uncorrelated.client, uncorrelated.child);
  });

  it('rejects invalid JSON, oversized frames, and oversized total wire data', async () => {
    const invalidJson = await startClient('manual-response');
    const invalidRequest = invalidJson.client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    invalidJson.child.stdout.write('not-json\n');
    await expect(invalidRequest).rejects.toMatchObject({
      code: 'FLOW_RPC_PROTOCOL_INVALID',
    });
    await closeClient(invalidJson.client, invalidJson.child);

    const oversizedFrame = await startClient('manual-response', {
      maxFrameBytes: 256,
    });
    const frameRequest = oversizedFrame.client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    oversizedFrame.child.stdout.write(`${'x'.repeat(257)}\n`);
    await expect(frameRequest).rejects.toMatchObject({
      code: 'FLOW_RPC_FRAME_LIMIT',
    });
    await closeClient(oversizedFrame.client, oversizedFrame.child);

    const oversizedWire = await startClient('manual-response', {
      maxWireBytes: 128,
      maxFrameBytes: 1_024,
    });
    const wireRequest = oversizedWire.client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    oversizedWire.child.stdout.write('x'.repeat(129));
    await expect(wireRequest).rejects.toMatchObject({
      code: 'FLOW_RPC_WIRE_LIMIT',
    });
    await closeClient(oversizedWire.client, oversizedWire.child);
  });

  it('drains raw stderr without exposing it in errors and joins the child', async () => {
    const { client, child } = await startClient('manual-response');
    const privateDiagnostic = 'synthetic-only-flow-key private diagnostic';
    child.stderr.write(privateDiagnostic);
    expect(client.stderrBytesDrained).toBe(
      Buffer.byteLength(privateDiagnostic, 'utf8'),
    );
    const request = client.getState();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const fakeRequest = child.stdin.pendingRequest;
    if (fakeRequest === undefined) throw new Error('Missing fake request.');
    child.respond(fakeRequest, { ok: true });
    await expect(request).resolves.toEqual({ ok: true });
    await closeClient(client, child);
  });
});
