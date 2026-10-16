import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from 'node:child_process';
import { TextDecoder } from 'node:util';

export const PI_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const PI_RPC_MAX_WIRE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 500;

const EVENT_TYPES = new Set([
  'agent_start',
  'agent_end',
  'agent_before_settle',
  'agent_settled',
  'ui_prompt_start',
  'ui_prompt_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'model_select',
  'thinking_level_changed',
  'session_info_changed',
  'entry_appended',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'extension_error',
  'bash_execution_update',
]);

export type PiRpcEvent = Record<string, unknown> & { readonly type: string };
export type PiRpcEventListener = (event: PiRpcEvent) => void;
export type PiRpcFailureListener = (error: PiRpcClientError) => void;
export type PiRpcSessionEntry = Record<string, unknown> & {
  readonly type: string;
};
export type PiRpcMessage = Record<string, unknown> & {
  readonly role: string;
};

export type PiRpcCommand =
  | { readonly type: 'get_state' }
  | { readonly type: 'get_entries'; readonly since?: string }
  | { readonly type: 'get_messages' }
  | { readonly type: 'get_available_thinking_levels' }
  | { readonly type: 'set_auto_retry'; readonly enabled: boolean }
  | { readonly type: 'set_auto_compaction'; readonly enabled: boolean }
  | { readonly type: 'set_session_name'; readonly name: string }
  | { readonly type: 'clear_queue' }
  | { readonly type: 'abort' }
  | { readonly type: 'prompt'; readonly message: string };

export type PiRpcClientErrorCode =
  | 'FLOW_RPC_CHILD_START_FAILED'
  | 'FLOW_RPC_CHILD_EXITED'
  | 'FLOW_RPC_STDIN_FAILED'
  | 'FLOW_RPC_STDOUT_EOF'
  | 'FLOW_RPC_PROTOCOL_INVALID'
  | 'FLOW_RPC_FRAME_LIMIT'
  | 'FLOW_RPC_WIRE_LIMIT'
  | 'FLOW_RPC_REQUEST_TIMEOUT'
  | 'FLOW_RPC_COMMAND_FAILED'
  | 'FLOW_RPC_CLIENT_STATE_INVALID';

export class PiRpcClientError extends Error {
  readonly code: PiRpcClientErrorCode;

  constructor(code: PiRpcClientErrorCode) {
    super(code);
    this.name = 'PiRpcClientError';
    this.code = code;
  }
}

export type PiRpcSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface PiRpcClientOptions {
  readonly nodePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxWireBytes?: number;
  /** A process injector for transport tests. Production uses node:child_process.spawn. */
  readonly spawnForTests?: PiRpcSpawn;
}

interface PendingRequest {
  readonly command: PiRpcCommand['type'];
  readonly resolve: (record: Record<string, unknown>) => void;
  readonly reject: (error: PiRpcClientError) => void;
  readonly timer: NodeJS.Timeout;
  readonly writeAbortController: AbortController;
}

interface ChildClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A small, fail-closed JSONL transport for the explicitly supported RPC subset. */
export class PiRpcClient {
  private readonly options: PiRpcClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxWireBytes: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<PiRpcEventListener>();
  private readonly failureListeners = new Set<PiRpcFailureListener>();
  private readonly activeWrites = new Set<() => void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private closePromise: Promise<ChildClose> | undefined;
  private cleanupChildListeners: (() => void) | undefined;
  private closed = false;
  private closing = false;
  private failure: PiRpcClientError | undefined;
  private stdoutBuffer = '';
  private wireBytes = 0;
  private stderrBytes = 0;

  constructor(options: PiRpcClientOptions) {
    this.options = options;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.terminationTimeoutMs =
      options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? PI_RPC_MAX_FRAME_BYTES;
    this.maxWireBytes = options.maxWireBytes ?? PI_RPC_MAX_WIRE_BYTES;
  }

  get stderrBytesDrained(): number {
    return this.stderrBytes;
  }

  get pendingWriteCount(): number {
    return this.activeWrites.size;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get subscriberCount(): number {
    return this.listeners.size + this.failureListeners.size;
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: PiRpcFailureListener): () => void {
    this.failureListeners.add(listener);
    if (this.failure !== undefined) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.child !== undefined || this.closed) {
      throw new PiRpcClientError('FLOW_RPC_CLIENT_STATE_INVALID');
    }
    try {
      const spawn = this.options.spawnForTests ?? nodeSpawn;
      const child = spawn(this.options.nodePath, this.options.args, {
        cwd: this.options.cwd,
        env: { ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      this.child = child;
      let resolveCloseChild!: (close: ChildClose) => void;
      this.closePromise = new Promise<ChildClose>((resolveClose) => {
        resolveCloseChild = resolveClose;
      });
      const onChildClose = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        this.closed = true;
        resolveCloseChild({ code, signal });
        if (!this.closing) this.fail('FLOW_RPC_CHILD_EXITED');
        else this.rejectPending('FLOW_RPC_CHILD_EXITED');
        this.listeners.clear();
        this.failureListeners.clear();
        this.cleanupChildListeners?.();
        this.cleanupChildListeners = undefined;
      };
      const onChildError = (): void => {
        this.fail('FLOW_RPC_CHILD_START_FAILED');
      };
      const onChildExit = (): void => {
        if (!this.closing) this.fail('FLOW_RPC_CHILD_EXITED');
        else this.rejectPending('FLOW_RPC_CHILD_EXITED');
      };
      const onStdinError = (): void => {
        this.fail('FLOW_RPC_STDIN_FAILED');
      };
      const onStdoutData = (chunk: Buffer): void => {
        this.readStdout(chunk);
      };
      const onStdoutEnd = (): void => {
        try {
          this.stdoutBuffer += this.decoder.decode();
        } catch {
          this.fail('FLOW_RPC_PROTOCOL_INVALID');
          return;
        }
        if (this.stdoutBuffer.length > 0) {
          this.fail('FLOW_RPC_PROTOCOL_INVALID');
        } else if (!this.closing) {
          this.fail('FLOW_RPC_STDOUT_EOF');
        }
      };
      const onStderrData = (chunk: Buffer): void => {
        this.stderrBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.stderrBytes + chunk.byteLength,
        );
      };
      this.cleanupChildListeners = (): void => {
        child.off('close', onChildClose);
        child.off('error', onChildError);
        child.off('exit', onChildExit);
        child.stdin.off('error', onStdinError);
        child.stdout.off('data', onStdoutData);
        child.stdout.off('end', onStdoutEnd);
        child.stderr.off('data', onStderrData);
      };
      child.once('close', onChildClose);
      child.on('error', onChildError);
      child.on('exit', onChildExit);
      child.stdin.on('error', onStdinError);
      child.stdout.on('data', onStdoutData);
      child.stdout.on('end', onStdoutEnd);
      child.stderr.on('data', onStderrData);
      await new Promise<void>((resolveStart, rejectStart) => {
        const onSpawn = (): void => {
          child.off('error', onError);
          child.off('close', onCloseBeforeSpawn);
          resolveStart();
        };
        const onError = (): void => {
          child.off('spawn', onSpawn);
          child.off('close', onCloseBeforeSpawn);
          rejectStart(new PiRpcClientError('FLOW_RPC_CHILD_START_FAILED'));
        };
        const onCloseBeforeSpawn = (): void => {
          child.off('spawn', onSpawn);
          child.off('error', onError);
          rejectStart(new PiRpcClientError('FLOW_RPC_CHILD_START_FAILED'));
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
        child.once('close', onCloseBeforeSpawn);
      });
    } catch (error) {
      if (error instanceof PiRpcClientError) throw error;
      this.fail('FLOW_RPC_CHILD_START_FAILED');
      throw new PiRpcClientError('FLOW_RPC_CHILD_START_FAILED');
    }
  }

  async request(command: PiRpcCommand): Promise<Record<string, unknown>> {
    this.assertWritable();
    const child = this.child;
    if (child === undefined) {
      throw new PiRpcClientError('FLOW_RPC_CLIENT_STATE_INVALID');
    }
    const id = randomUUID();
    const line = `${JSON.stringify({ ...command, id })}\n`;
    if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
      throw new PiRpcClientError('FLOW_RPC_FRAME_LIMIT');
    }
    return await new Promise<Record<string, unknown>>(
      (resolveRequest, rejectRequest) => {
        const writeAbortController = new AbortController();
        const timer = setTimeout(() => {
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          this.pending.delete(id);
          writeAbortController.abort();
          rejectRequest(new PiRpcClientError('FLOW_RPC_REQUEST_TIMEOUT'));
        }, this.requestTimeoutMs);
        timer.unref();
        this.pending.set(id, {
          command: command.type,
          resolve: resolveRequest,
          reject: rejectRequest,
          timer,
          writeAbortController,
        });
        void this.writeLine(child, line, writeAbortController.signal).catch(
          () => {
            if (!this.pending.has(id)) return;
            this.fail('FLOW_RPC_STDIN_FAILED');
          },
        );
      },
    );
  }

  async prompt(message: string): Promise<'started' | 'handled' | 'queued'> {
    const response = await this.request({ type: 'prompt', message });
    const data = response['data'];
    if (!isRecord(data))
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    const disposition = data['disposition'];
    if (
      disposition !== 'started' &&
      disposition !== 'handled' &&
      disposition !== 'queued'
    ) {
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    }
    return disposition;
  }

  async getState(): Promise<Record<string, unknown>> {
    const response = await this.request({ type: 'get_state' });
    const data = response['data'];
    if (!isRecord(data))
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    return data;
  }

  async getEntries(since?: string): Promise<{
    readonly entries: readonly PiRpcSessionEntry[];
    readonly leafId: string | null;
  }> {
    const response = await this.request({
      type: 'get_entries',
      ...(since === undefined ? {} : { since }),
    });
    const data = response['data'];
    if (
      !isRecord(data) ||
      !Array.isArray(data['entries']) ||
      data['entries'].some(
        (entry) => !isRecord(entry) || typeof entry['type'] !== 'string',
      ) ||
      (data['leafId'] !== null && typeof data['leafId'] !== 'string')
    ) {
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    }
    return {
      entries: data['entries'] as PiRpcSessionEntry[],
      leafId: data['leafId'],
    };
  }

  async getMessages(): Promise<readonly PiRpcMessage[]> {
    const response = await this.request({ type: 'get_messages' });
    const data = response['data'];
    if (
      !isRecord(data) ||
      !Array.isArray(data['messages']) ||
      data['messages'].some(
        (message) => !isRecord(message) || typeof message['role'] !== 'string',
      )
    ) {
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    }
    return data['messages'] as PiRpcMessage[];
  }

  async getAvailableThinkingLevels(): Promise<readonly string[]> {
    const response = await this.request({
      type: 'get_available_thinking_levels',
    });
    const data = response['data'];
    if (!isRecord(data) || !Array.isArray(data['levels'])) {
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    }
    if (data['levels'].some((level) => typeof level !== 'string')) {
      throw new PiRpcClientError('FLOW_RPC_PROTOCOL_INVALID');
    }
    return data['levels'] as string[];
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.request({ type: 'set_auto_retry', enabled });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: 'set_auto_compaction', enabled });
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: 'set_session_name', name });
  }

  async clearQueue(): Promise<void> {
    await this.request({ type: 'clear_queue' });
  }

  async abort(): Promise<void> {
    await this.request({ type: 'abort' });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      this.cleanupPending();
      return;
    }
    if (this.closePromise === undefined) {
      this.fail('FLOW_RPC_CLIENT_STATE_INVALID');
      return;
    }
    if (!this.closing) {
      this.closing = true;
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();
    }
    let close = await this.waitForClose(this.shutdownTimeoutMs);
    if (close === undefined) {
      child.kill('SIGTERM');
      close = await this.waitForClose(this.terminationTimeoutMs);
    }
    if (close === undefined) {
      child.kill('SIGKILL');
      close = await this.closePromise;
    }
    this.rejectPending('FLOW_RPC_CHILD_EXITED');
    this.listeners.clear();
    this.failureListeners.clear();
    if (this.failure !== undefined) throw this.failure;
    if (close.code !== 0) throw new PiRpcClientError('FLOW_RPC_CHILD_EXITED');
  }

  private async writeLine(
    child: ChildProcessWithoutNullStreams,
    line: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (child.stdin.destroyed || !child.stdin.writable) {
      throw new PiRpcClientError('FLOW_RPC_STDIN_FAILED');
    }
    const frame = Buffer.from(line, 'utf8');
    await new Promise<void>((resolveWrite, rejectWrite) => {
      let accepted: boolean | undefined;
      let callbackDone = false;
      let drainDone = false;
      let settled = false;
      const cleanup = (): void => {
        child.stdin.off('drain', onDrain);
        child.stdin.off('error', onError);
        child.stdin.off('close', onStreamClose);
        child.off('close', onChildClose);
        signal.removeEventListener('abort', onAbort);
        this.activeWrites.delete(cancelWrite);
      };
      const finish = (error?: PiRpcClientError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolveWrite();
        else rejectWrite(error);
      };
      const maybeFinish = (): void => {
        if (callbackDone && (accepted === true || drainDone)) finish();
      };
      const onDrain = (): void => {
        drainDone = true;
        maybeFinish();
      };
      const onError = (): void => {
        finish(new PiRpcClientError('FLOW_RPC_STDIN_FAILED'));
      };
      const onStreamClose = (): void => {
        finish(new PiRpcClientError('FLOW_RPC_STDIN_FAILED'));
      };
      const onChildClose = (): void => {
        finish(new PiRpcClientError('FLOW_RPC_CHILD_EXITED'));
      };
      const onAbort = (): void => {
        finish();
      };
      const cancelWrite = (): void => {
        finish();
      };
      this.activeWrites.add(cancelWrite);
      child.stdin.on('drain', onDrain);
      child.stdin.on('error', onError);
      child.stdin.once('close', onStreamClose);
      child.once('close', onChildClose);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        accepted = child.stdin.write(frame, (error?: Error | null) => {
          if (settled) return;
          if (error !== undefined && error !== null) {
            finish(new PiRpcClientError('FLOW_RPC_STDIN_FAILED'));
            return;
          }
          callbackDone = true;
          maybeFinish();
        });
        maybeFinish();
      } catch {
        finish(new PiRpcClientError('FLOW_RPC_STDIN_FAILED'));
      }
    });
  }

  private readStdout(chunk: Buffer): void {
    this.wireBytes += chunk.byteLength;
    if (this.wireBytes > this.maxWireBytes) {
      this.fail('FLOW_RPC_WIRE_LIMIT');
      return;
    }
    try {
      this.stdoutBuffer += this.decoder.decode(chunk, { stream: true });
    } catch {
      this.fail('FLOW_RPC_PROTOCOL_INVALID');
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line, 'utf8') + 1 > this.maxFrameBytes) {
        this.fail('FLOW_RPC_FRAME_LIMIT');
        return;
      }
      if (line.length === 0) {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
      this.handleLine(line);
      if (this.failure !== undefined) return;
      newline = this.stdoutBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxFrameBytes) {
      this.fail('FLOW_RPC_FRAME_LIMIT');
    }
  }

  private handleLine(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      this.fail('FLOW_RPC_PROTOCOL_INVALID');
      return;
    }
    if (!isRecord(record) || typeof record['type'] !== 'string') {
      this.fail('FLOW_RPC_PROTOCOL_INVALID');
      return;
    }
    if (record['type'] === 'response') {
      if (
        !hasOnlyKeys(record, [
          'type',
          'id',
          'command',
          'success',
          'data',
          'error',
        ])
      ) {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
      const id = record['id'];
      if (
        typeof id !== 'string' ||
        typeof record['command'] !== 'string' ||
        typeof record['success'] !== 'boolean'
      ) {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
      const pending = this.pending.get(id);
      if (pending === undefined) {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
      if (record['command'] !== pending.command) {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.writeAbortController.abort();
      if (!record['success']) {
        pending.reject(new PiRpcClientError('FLOW_RPC_COMMAND_FAILED'));
      } else {
        pending.resolve(record);
      }
      return;
    }
    if (record['type'] === 'extension_ui_request') {
      if (
        !hasOnlyKeys(record, [
          'type',
          'id',
          'method',
          'message',
          'notifyType',
        ]) ||
        typeof record['id'] !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(record['id']) ||
        record['method'] !== 'notify' ||
        typeof record['message'] !== 'string' ||
        Buffer.byteLength(record['message'], 'utf8') > 8192 ||
        (record['notifyType'] !== undefined &&
          record['notifyType'] !== 'info' &&
          record['notifyType'] !== 'warning' &&
          record['notifyType'] !== 'error')
      ) {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
    } else if (!EVENT_TYPES.has(record['type'])) {
      this.fail('FLOW_RPC_PROTOCOL_INVALID');
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(record as PiRpcEvent);
      } catch {
        this.fail('FLOW_RPC_PROTOCOL_INVALID');
        return;
      }
    }
  }

  private assertWritable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.child === undefined || this.closed || this.closing) {
      throw new PiRpcClientError('FLOW_RPC_CLIENT_STATE_INVALID');
    }
  }

  private fail(code: PiRpcClientErrorCode): void {
    if (this.failure !== undefined) return;
    this.failure = new PiRpcClientError(code);
    this.rejectPending(code);
    for (const listener of [...this.failureListeners]) {
      try {
        listener(this.failure);
      } catch {
        // Failure listeners are isolated from the transport.
      }
    }
  }

  private rejectPending(code: PiRpcClientErrorCode): void {
    const error = this.failure ?? new PiRpcClientError(code);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.writeAbortController.abort();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanupPending(): void {
    this.rejectPending('FLOW_RPC_CHILD_EXITED');
  }

  private async waitForClose(
    timeoutMs: number,
  ): Promise<ChildClose | undefined> {
    const closePromise = this.closePromise;
    if (closePromise === undefined) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolveTimeout) => {
      timer = setTimeout(() => {
        resolveTimeout(undefined);
      }, timeoutMs);
      timer.unref();
    });
    const close = await Promise.race([closePromise, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return close;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
