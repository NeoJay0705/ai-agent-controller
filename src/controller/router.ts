import type {
  ControllerConfig,
  TelegramMessage,
  TelegramUpdate,
} from './types.js';
import type { FlowStore } from '../flow/store.js';
import { ControllerStore, DomainError } from './store.js';

export interface TelegramRouterOptions {
  readonly readyAtSec: () => number;
  readonly onSkipped?: (classification: string) => void;
  readonly flowStore?: FlowStore;
}

const HELP = [
  'Telegram multi-session Flow controller.',
  '/new <name> — create and select a session',
  '/sessions — list your sessions',
  '/use <session_id> — select a session',
  '/queue <text> — create a Flow Job',
  '/steer <job_id> <text> — add input to a specific Job',
  '/status [job_id] — inspect persisted job status',
  'Plain text creates a Flow Job. Choose a Flow explicitly when prompted.',
].join('\n');

export class TelegramRouter {
  private readonly store: ControllerStore;
  private readonly config: ControllerConfig;
  private readonly options: TelegramRouterOptions;

  constructor(
    store: ControllerStore,
    config: ControllerConfig,
    options: TelegramRouterOptions,
  ) {
    this.store = store;
    this.config = config;
    this.options = options;
  }

  handle(update: TelegramUpdate): void {
    this.store.transaction(() => {
      if (this.store.isUpdateProcessed(update.update_id)) return;
      const message = update.message;
      if (message !== undefined) {
        const date = message.date;
        if (
          typeof date !== 'number' ||
          !Number.isSafeInteger(date) ||
          date < 0
        ) {
          this.notifySkipped('invalid_message_date');
          this.store.recordUpdate(update.update_id);
          return;
        }
        const readyAtSec = this.options.readyAtSec();
        if (!Number.isSafeInteger(readyAtSec) || readyAtSec < 0) {
          this.notifySkipped('invalid_ready_boundary');
          this.store.recordUpdate(update.update_id);
          return;
        }
        if (date < readyAtSec) {
          this.notifySkipped('before_ready');
          this.store.recordUpdate(update.update_id);
          return;
        }
      }
      try {
        this.store.savepoint(() => {
          this.route(update);
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        const message = update.message;
        if (message !== undefined && this.isAuthorized(message)) {
          const ownerId = String(message.from?.id);
          const chatId = String(message.chat.id);
          const selected = this.store.selectedSession(ownerId, chatId);
          this.store.reply(chatId, error.message, selected?.id ?? null);
        }
      }
      this.store.recordUpdate(update.update_id);
    });
  }

  private route(update: TelegramUpdate): void {
    const message = update.message;
    if (message === undefined || !this.isAuthorized(message)) return;
    const ownerId = String(message.from?.id);
    const chatId = String(message.chat.id);
    if (typeof message.text !== 'string') {
      this.store.reply(
        chatId,
        'Only text messages are supported.',
        this.selectedId(ownerId, chatId),
      );
      return;
    }
    const text = message.text;
    if (text.length > 4096) {
      this.store.reply(
        chatId,
        'Message is too long. The limit is 4096 UTF-16 code units.',
        this.selectedId(ownerId, chatId),
      );
      return;
    }
    if (text.trim().length === 0) {
      this.store.reply(
        chatId,
        'Message must not be empty.',
        this.selectedId(ownerId, chatId),
      );
      return;
    }

    const normalized = text.trim();
    if (normalized.startsWith('/')) {
      this.command(ownerId, chatId, normalized);
      return;
    }
    if (message.reply_to_message !== undefined) {
      const prompt = this.store.findPrompt(
        chatId,
        message.reply_to_message.message_id,
      );
      if (prompt !== null) {
        this.store.steerPrompt(
          ownerId,
          chatId,
          message.reply_to_message.message_id,
          normalized,
          this.config.maxPendingSteering,
        );
        return;
      }
    }
    this.store.queueJob(
      ownerId,
      chatId,
      normalized,
      this.config.maxPendingJobs,
    );
  }

  private command(ownerId: string, chatId: string, text: string): void {
    const match =
      /^\/([A-Za-z][A-Za-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
        text,
      );
    if (match === null) {
      this.store.reply(
        chatId,
        'Command format is invalid.',
        this.selectedId(ownerId, chatId),
      );
      return;
    }
    const name = match[1]?.toLowerCase();
    const argument = match[2] ?? '';
    const trimmedArgument = argument.trim();
    switch (name) {
      case 'start':
      case 'help':
        if (trimmedArgument.length > 0)
          throw new DomainError('FORMAT', 'Use /help without arguments.');
        this.store.reply(chatId, HELP, this.selectedId(ownerId, chatId));
        return;
      case 'new': {
        if (trimmedArgument.length < 1 || trimmedArgument.length > 100) {
          throw new DomainError(
            'FORMAT',
            'Session name must contain 1 to 100 UTF-16 code units.',
          );
        }
        this.store.createSession(ownerId, chatId, trimmedArgument);
        return;
      }
      case 'sessions': {
        if (trimmedArgument.length > 0)
          throw new DomainError('FORMAT', 'Use /sessions without arguments.');
        const sessions = this.store.listSessions(ownerId);
        const body =
          sessions.length === 0
            ? 'No sessions yet. Create one with /new <name>.'
            : sessions
                .map((session) => `${cleanLine(session.name)} — ${session.id}`)
                .join('\n');
        this.store.reply(chatId, body, this.selectedId(ownerId, chatId));
        return;
      }
      case 'use': {
        if (!/^[^\s]+$/.test(trimmedArgument))
          throw new DomainError('FORMAT', 'Use /use <session_id>.');
        this.store.useSession(ownerId, chatId, trimmedArgument);
        return;
      }
      case 'queue':
        this.assertContent(trimmedArgument);
        this.store.queueJob(
          ownerId,
          chatId,
          trimmedArgument,
          this.config.maxPendingJobs,
        );
        return;
      case 'steer': {
        const steering = /^([^\s]+)\s+([\s\S]+)$/.exec(trimmedArgument);
        if (steering === null)
          throw new DomainError('FORMAT', 'Use /steer <job_id> <text>.');
        const jobId = steering[1];
        const content = steering[2]?.trim() ?? '';
        this.assertContent(content);
        this.store.steerJob(
          ownerId,
          jobId ?? '',
          content,
          this.config.maxPendingSteering,
          chatId,
        );
        return;
      }
      case 'status':
        if (trimmedArgument.length === 0) {
          const jobs = this.store.statusForSession(ownerId, chatId);
          if (jobs === null)
            throw new DomainError(
              'NO_SESSION',
              'Select a session with /new or /use first.',
            );
          const body =
            jobs.length === 0
              ? 'No jobs in the selected session.'
              : jobs
                  .map((job) => formatJob(job, this.options.flowStore))
                  .join('\n\n');
          this.store.reply(chatId, body, this.selectedId(ownerId, chatId));
          return;
        }
        if (/\s/.test(trimmedArgument))
          throw new DomainError('FORMAT', 'Use /status [job_id].');
        {
          const job = this.store.statusForJob(ownerId, trimmedArgument);
          if (job === null)
            throw new DomainError('NOT_FOUND', 'Job not found.');
          this.store.reply(
            chatId,
            formatJob(job, this.options.flowStore),
            job.sessionId,
          );
          return;
        }
      default:
        throw new DomainError(
          'UNKNOWN_COMMAND',
          'Unknown command. Use /help for supported commands.',
        );
    }
  }

  private notifySkipped(classification: string): void {
    try {
      this.options.onSkipped?.(classification);
    } catch {
      // Logging must not change update processing.
    }
  }

  private assertContent(content: string): void {
    if (content.trim().length === 0)
      throw new DomainError('EMPTY', 'Text must not be empty.');
    if (content.length > 4096)
      throw new DomainError(
        'TOO_LONG',
        'Text is too long. The limit is 4096 UTF-16 code units.',
      );
  }

  private isAuthorized(message: TelegramMessage): boolean {
    return (
      message.chat.type === 'private' &&
      message.from !== undefined &&
      String(message.from.id) === this.config.allowedUserId
    );
  }

  private selectedId(ownerId: string, chatId: string): string | null {
    return this.store.selectedSession(ownerId, chatId)?.id ?? null;
  }
}

function formatJob(
  job: ReturnType<ControllerStore['statusForJob']> extends infer T
    ? Exclude<T, null>
    : never,
  flowStore?: FlowStore,
): string {
  const failure =
    job.failureCode === null ? '' : `; failure=${job.failureCode}`;
  const run = flowStore?.getPinnedFlowRun(job.id) ?? null;
  const flow =
    run === null
      ? 'Flow: not started'
      : `Flow: ${run.flowId}/${run.nodeId}; transitions=${String(run.transitions)}`;
  return [
    `Job ${job.id} — ${job.status}${failure}`,
    `Session: ${cleanLine(job.sessionName)} (${job.sessionId})`,
    flow,
    `Steering: pending=${String(job.pendingSteering)}, applied=${String(job.appliedSteering.length)}, not_applied=${String(job.notAppliedSteering)}`,
    `Delivery failures: ${String(job.failedDeliveries)}`,
  ].join('\n');
}

function cleanLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}
