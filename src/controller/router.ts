import type {
  ControllerConfig,
  TelegramMessage,
  TelegramUpdate,
} from './types.js';
import type { FlowStore } from '../flow/store.js';
import { ControllerStore, DomainError } from './store.js';
import { TrialStore } from './trial-store.js';
import { DEFAULT_TRIAL_POLICY } from './trial-policy.js';
import { parseDuration } from './commands.js';

type Dialog = ReturnType<TrialStore['getDialog']>;
export interface TelegramRouterOptions {
  readonly readyAtSec: () => number;
  readonly onSkipped?: (classification: string) => void;
  readonly flowStore?: FlowStore;
  readonly trialStore?: TrialStore;
  readonly now?: () => number;
  readonly botUsername?: () => string | null;
}

const CONTROL_COMMANDS = new Set([
  'start',
  'help',
  'sessions',
  'status',
  'cancel',
  'allow',
  'revoke',
  'guests',
  'invite',
]);
const PUBLIC_WINDOW_MS = 60_000;
const PUBLIC_ATTEMPT_LIMIT = 20;
const PUBLIC_NOTICE_LIMIT = 10;
const KNOWN_COMMANDS = new Set([
  'start',
  'help',
  'new',
  'sessions',
  'use',
  'queue',
  'steer',
  'status',
  'cancel',
  'allow',
  'revoke',
  'guests',
  'invite',
]);

export class TelegramRouter {
  private readonly store: ControllerStore;
  private readonly config: ControllerConfig;
  private readonly options: TelegramRouterOptions;
  private readonly trial: TrialStore;
  private publicWindowAt = 0;
  private publicAttempts = 0;
  private publicNotices = 0;

  constructor(
    store: ControllerStore,
    config: ControllerConfig,
    options: TelegramRouterOptions,
  ) {
    this.store = store;
    this.config = config;
    this.options = options;
    this.trial =
      options.trialStore ??
      new TrialStore(
        store,
        config.mode === 'bot' ? config.allowedUserId : '',
        config.mode === 'bot'
          ? (config.trial ?? DEFAULT_TRIAL_POLICY)
          : DEFAULT_TRIAL_POLICY,
        { ...(options.now === undefined ? {} : { now: options.now }) },
      );
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
        const ready = this.options.readyAtSec();
        if (!Number.isSafeInteger(ready) || ready < 0) {
          this.notifySkipped('invalid_ready_boundary');
          this.store.recordUpdate(update.update_id);
          return;
        }
        if (date < ready) {
          this.notifySkipped('before_ready');
          this.store.recordUpdate(update.update_id);
          return;
        }
      }
      try {
        if (message !== undefined && this.isPrivateUser(message)) {
          const uid = String(message.from?.id);
          if (this.trial.access(uid).role !== 'denied') {
            const channel = this.channelFor(update, uid);
            this.trial.chargeMessage(uid, update.update_id, channel);
          }
        }
        this.store.savepoint(() => {
          this.route(update);
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (message !== undefined && this.isPrivateUser(message)) {
          const uid = String(message.from?.id);
          const chat = String(message.chat.id);
          if (this.trial.access(uid).role !== 'denied') {
            const currentDialog = this.trial.getDialog(uid, chat);
            if (
              ['TERMINAL', 'ACCESS_DENIED', 'NOT_FOUND'].includes(error.code) &&
              currentDialog !== null
            )
              this.trial.clearDialog(uid, chat);
            if (error.code === 'BOT_USERNAME_UNAVAILABLE')
              this.trial.setDialog(uid, chat, 'invite');
            if (error.code === 'FORMAT') {
              const commandMatch =
                typeof message.text === 'string'
                  ? /^\/([A-Za-z][A-Za-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
                      message.text.trim(),
                    )
                  : null;
              const command =
                commandMatch !== null &&
                commandMatch[0] === message.text?.trim()
                  ? commandMatch[1]?.toLowerCase()
                  : undefined;
              if (
                command !== undefined &&
                [
                  'new',
                  'use',
                  'queue',
                  'steer',
                  'cancel',
                  'allow',
                  'revoke',
                  'invite',
                ].includes(command)
              )
                this.trial.setDialog(
                  uid,
                  chat,
                  command as Parameters<TrialStore['setDialog']>[2],
                );
              else if (currentDialog !== null)
                this.trial.setDialog(uid, chat, currentDialog.command);
            }
            if (error.code !== 'QUOTA_CONTROL_RATE') {
              try {
                this.trial.chargeMessage(uid, update.update_id, 'control');
                this.store.replyControl(
                  chat,
                  error.message,
                  this.selectedId(uid, chat),
                );
              } catch (controlError) {
                if (!(controlError instanceof DomainError)) throw controlError;
              }
            }
          }
        }
      }
      this.store.recordUpdate(update.update_id);
    });
  }

  private channelFor(
    update: TelegramUpdate,
    uid: string,
  ): 'control' | 'message' {
    const message = update.message;
    if (message === undefined) return 'message';
    const chat = String(message.chat.id);
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const match =
      /^\/([A-Za-z][A-Za-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
        text,
      );
    const name = match?.[1]?.toLowerCase();
    if (name !== undefined && KNOWN_COMMANDS.has(name))
      return CONTROL_COMMANDS.has(name) ? 'control' : 'message';
    if (text.startsWith('/')) return 'control';
    if (
      message.reply_to_message !== undefined &&
      this.options.flowStore !== undefined
    ) {
      const prompt = this.store.findPrompt(
        chat,
        message.reply_to_message.message_id,
      );
      if (prompt !== null) return 'message';
    }
    const dialog = this.trial.getDialog(uid, chat);
    return dialog !== null &&
      ['cancel', 'allow', 'revoke', 'invite'].includes(dialog.command)
      ? 'control'
      : 'message';
  }

  private route(update: TelegramUpdate): void {
    const m = update.message;
    if (m === undefined || !this.isPrivateUser(m)) return;
    const uid = String(m.from?.id);
    const chat = String(m.chat.id);
    const text = m.text;
    if (typeof text !== 'string') {
      if (this.trial.access(uid).role !== 'denied')
        this.replyControlLimited(
          uid,
          chat,
          update.update_id,
          'Only text messages are supported.',
        );
      return;
    }
    if (text.length > 4096 || text.trim().length === 0) {
      if (this.trial.access(uid).role !== 'denied')
        this.replyControlLimited(
          uid,
          chat,
          update.update_id,
          text.length > 4096
            ? 'Message is too long. The limit is 4096 UTF-16 code units.'
            : 'Message must not be empty.',
        );
      return;
    }
    const normalized = text.trim();
    const commandMatch =
      /^\/([A-Za-z][A-Za-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
        normalized,
      );
    const name =
      commandMatch?.[0] === normalized
        ? commandMatch[1]?.toLowerCase()
        : undefined;
    const arg = (commandMatch?.[2] ?? '').trim();
    const access = this.trial.access(uid);
    if (access.role === 'denied') {
      if (name === 'start') {
        if (this.allowPublicAttempt()) {
          const tokenMatch = /^\/start ([A-Za-z0-9_-]{43})$/.exec(text);
          const token =
            tokenMatch !== null && tokenMatch[0] === text
              ? tokenMatch[1]
              : undefined;
          if (token !== undefined) {
            try {
              this.store.savepoint(() => {
                this.trial.redeemInvite(uid, chat, token);
                this.trial.chargeMessage(uid, update.update_id);
              });
              this.store.replyControl(
                chat,
                'Invite accepted. Use /help to see commands.',
              );
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              this.publicHint(uid, chat);
            }
          } else this.publicHint(uid, chat);
        }
      } else if (name === 'help' && arg === '') {
        if (this.allowPublicAttempt()) this.publicHint(uid, chat);
      }
      return;
    }
    if (access.role === 'guest') this.trial.recordGuestChat(uid, chat);
    if (name === 'start' && arg.length > 0 && access.role === 'guest')
      throw new DomainError(
        'INVITE_INVALID',
        'Invite is invalid or unavailable.',
      );
    const isExplicit = name !== undefined;
    if (!isExplicit && normalized.startsWith('/')) {
      this.replyControlLimited(
        uid,
        chat,
        update.update_id,
        'Unknown or malformed command. Use /help to see available commands.',
      );
      return;
    }
    if (isExplicit) {
      if (!KNOWN_COMMANDS.has(name)) {
        this.store.replyControl(
          chat,
          'Unknown command. Use /help to see available commands.',
        );
        return;
      }
      if (
        ['allow', 'revoke', 'guests', 'invite'].includes(name) &&
        access.role !== 'owner'
      ) {
        this.store.replyControl(
          chat,
          'This command is available to the Owner only.',
        );
        return;
      }
      if (name !== 'start' && !this.commandAllowed(name, access.role)) return;
      if (name === 'help') {
        if (arg)
          throw new DomainError('FORMAT', 'Use /help without parameters.');
        this.trial.clearDialog(uid, chat);
        this.store.replyControl(chat, this.help(access.role));
        return;
      }
      if (name === 'start') {
        if (arg)
          throw new DomainError(
            'INVITE_INVALID',
            'Invite is invalid or unavailable.',
          );
        this.trial.clearDialog(uid, chat);
        this.store.replyControl(chat, this.help(access.role));
        return;
      }
      this.trial.clearDialog(uid, chat);
      this.command(uid, chat, name, arg, update.update_id, access.role);
      return;
    }
    if (m.reply_to_message !== undefined) {
      const prompt = this.store.findPrompt(chat, m.reply_to_message.message_id);
      if (prompt === null) {
        this.replyControlLimited(
          uid,
          chat,
          update.update_id,
          'This Job prompt is no longer available.',
        );
        return;
      }
      this.store.steerPrompt(
        uid,
        chat,
        m.reply_to_message.message_id,
        normalized,
        this.config.maxPendingSteering,
        prompt.generation,
      );
      return;
    }
    const dialog = this.trial.getDialog(uid, chat);
    if (dialog !== null) {
      this.dialogInput(
        uid,
        chat,
        normalized,
        update.update_id,
        dialog,
        access.role,
      );
      return;
    }
    this.replyControlLimited(
      uid,
      chat,
      update.update_id,
      'Use /queue <text> to create a job.',
      this.selectedId(uid, chat),
    );
  }

  private command(
    uid: string,
    chat: string,
    name: string,
    arg: string,
    updateId: number,
    role: 'owner' | 'guest',
  ): void {
    const owner = role === 'owner';
    switch (name) {
      case 'new':
        if (!arg) {
          this.guide(uid, chat, 'new', 'Use /new <name>.', updateId);
          return;
        }
        if (arg.length > 100)
          throw new DomainError(
            'FORMAT',
            'Session name must be 1 to 100 characters.',
          );
        this.trial.assertCanCreateSession(uid);
        this.store.createSession(uid, chat, arg);
        this.trial.clearDialog(uid, chat);
        return;
      case 'sessions': {
        if (arg)
          throw new DomainError('FORMAT', 'Use /sessions without parameters.');
        const rows = this.store.listSessions(uid);
        this.store.reply(
          chat,
          rows.length
            ? rows.map((s) => `${clean(s.name)} — ${s.id}`).join('\n')
            : 'No sessions yet. Create one with /new <name>.',
          this.selectedId(uid, chat),
        );
        return;
      }
      case 'use':
        if (!arg) {
          this.guide(uid, chat, 'use', 'Use /use <session_id>.', updateId);
          return;
        }
        if (/\s/.test(arg))
          throw new DomainError('FORMAT', 'Use /use <session_id>.');
        this.store.useSession(uid, chat, arg);
        this.trial.clearDialog(uid, chat);
        return;
      case 'queue':
        if (!arg) {
          this.guide(uid, chat, 'queue', 'Use /queue <text>.', updateId);
          return;
        }
        this.trial.chargeJob(uid, updateId);
        this.store.queueJob(uid, chat, arg, this.config.maxPendingJobs);
        this.trial.clearDialog(uid, chat);
        return;
      case 'steer': {
        const m = /^([^\s]+)\s+([\s\S]+)$/.exec(arg);
        const jobId = m?.[1];
        const steering = m?.[2];
        if (jobId === undefined || steering === undefined || !steering.trim()) {
          this.guide(
            uid,
            chat,
            'steer',
            'Use /steer <job_id> <text>.',
            updateId,
          );
          return;
        }
        this.store.steerJob(
          uid,
          jobId,
          steering.trim(),
          this.config.maxPendingSteering,
          chat,
        );
        this.trial.clearDialog(uid, chat);
        return;
      }
      case 'status': {
        if (arg && /\s/.test(arg))
          throw new DomainError('FORMAT', 'Use /status [job_id].');
        if (!arg) {
          const jobs = this.store.statusForSession(uid, chat);
          this.store.reply(
            chat,
            jobs === null
              ? 'Select a session with /new or /use first.'
              : jobs.length
                ? jobs
                    .map((job) => formatJob(job, this.options.flowStore))
                    .join('\n\n')
                : 'No jobs in the selected session.',
            this.selectedId(uid, chat),
          );
          return;
        }
        const job = this.store.statusForJob(uid, arg);
        if (!job) throw new DomainError('NOT_FOUND', 'Job not found.');
        this.store.reply(
          chat,
          formatJob(job, this.options.flowStore),
          job.sessionId,
        );
        return;
      }
      case 'cancel': {
        if (arg && /\s/.test(arg))
          throw new DomainError('FORMAT', 'Use /cancel [job_id].');
        if (!arg) {
          const rows = (
            owner
              ? this.store.database
                  .prepare(
                    "SELECT id,status FROM jobs WHERE status IN ('QUEUED','RUNNING','WAITING_INPUT','CANCELLING') ORDER BY created_at LIMIT 20",
                  )
                  .all()
              : this.store.database
                  .prepare(
                    "SELECT id,status FROM jobs WHERE owner_id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT','CANCELLING') ORDER BY created_at LIMIT 20",
                  )
                  .all(uid)
          ) as Array<{ id: string; status: string }>;
          if (rows.length === 0) {
            this.trial.clearDialog(uid, chat);
            this.store.replyControl(chat, 'No cancellable jobs.');
            return;
          }
          this.trial.setDialog(uid, chat, 'cancel');
          this.store.replyControl(
            chat,
            `Send a Job ID to cancel:\n${rows
              .slice(0, 20)
              .map((j) => `${j.id} — ${j.status}`)
              .join('\n')}`,
          );
          return;
        }
        const status = this.store.requestCancellation(
          uid,
          arg,
          this.config.mode === 'bot' ? this.config.allowedUserId : '',
        );
        this.trial.clearDialog(uid, chat);
        this.store.replyControl(chat, `Job ${arg}: ${status}.`);
        return;
      }
      case 'allow':
        if (!owner) {
          this.store.replyControl(
            chat,
            'This command is available to the Owner only.',
          );
          return;
        }
        {
          this.allow(uid, chat, arg, updateId);
          return;
        }
      case 'revoke':
        if (!owner) return;
        if (!arg || /\s/.test(arg)) {
          this.guide(uid, chat, 'revoke', 'Use /revoke <user_id>.', updateId);
          return;
        }
        this.trial.revoke(arg);
        this.trial.clearDialog(uid, chat);
        this.store.replyControl(chat, 'Trial access revoked.');
        return;
      case 'guests':
        if (arg)
          throw new DomainError('FORMAT', 'Use /guests without parameters.');
        if (owner)
          this.store.replyControl(
            chat,
            this.trial
              .listGuests()
              .map(
                (g) =>
                  `${g.userId} — ${g.revokedAt === null && g.expiresAt > (this.options.now?.() ?? Date.now()) ? 'active' : 'inactive'}; expires=${new Date(g.expiresAt).toISOString()} (UTC); jobs=${String(g.jobsUsed)}; messages=${String(g.messagesUsed)}; tokens=${String(g.tokensUsed)}${g.usageUncertain ? '; usage=unknown' : ''}`,
              )
              .join('\n') || 'No trial users.',
          );
        return;
      case 'invite':
        if (!owner) return;
        {
          this.invite(uid, chat, arg, updateId);
          return;
        }
      default:
        return;
    }
  }
  private allow(
    uid: string,
    chat: string,
    arg: string,
    updateId: number,
  ): void {
    const m = /^([0-9]+)(?:\s+(\S+))?$/.exec(arg);
    const userId = m?.[1];
    if (userId === undefined || userId === '') {
      this.guide(
        uid,
        chat,
        'allow',
        'Use /allow <user_id> [duration].',
        updateId,
      );
      return;
    }
    const durationValue = m?.[2];
    const duration =
      durationValue === undefined
        ? this.config.mode === 'bot'
          ? (this.config.trial?.trialDurationMs ??
            DEFAULT_TRIAL_POLICY.trialDurationMs)
          : DEFAULT_TRIAL_POLICY.trialDurationMs
        : parseDuration(durationValue);
    if (duration === null) {
      this.guide(
        uid,
        chat,
        'allow',
        'Use /allow <user_id> [duration], for example /allow 123456 1h.',
        updateId,
      );
      return;
    }
    this.trial.grant(userId, duration);
    this.trial.clearDialog(uid, chat);
    const expiresAt = (this.options.now?.() ?? Date.now()) + duration;
    const policy =
      this.config.mode === 'bot'
        ? (this.config.trial ?? DEFAULT_TRIAL_POLICY)
        : DEFAULT_TRIAL_POLICY;
    this.store.replyControl(
      chat,
      `Trial access granted to ${userId}. Expires at ${new Date(expiresAt).toISOString()} (UTC). Quotas: ${String(policy.maxJobs)} jobs, ${String(policy.maxMessages)} messages, ${String(policy.userTokenLimit)} tokens.`,
    );
  }
  private invite(
    uid: string,
    chat: string,
    arg: string,
    updateId: number,
  ): void {
    if (!arg) {
      this.guide(
        uid,
        chat,
        'invite',
        'Use /invite <invite TTL> <trial duration>, for example /invite 10m 1h.',
        updateId,
      );
      return;
    }
    const m = /^(\S+)(?:\s+(\S+))?$/.exec(arg);
    const ttlValue = m?.[1];
    const ttl = ttlValue === undefined ? null : parseDuration(ttlValue);
    const trial = m
      ? m[2] === undefined
        ? this.config.mode === 'bot'
          ? (this.config.trial?.trialDurationMs ??
            DEFAULT_TRIAL_POLICY.trialDurationMs)
          : DEFAULT_TRIAL_POLICY.trialDurationMs
        : parseDuration(m[2])
      : null;
    if (ttl === null || trial === null) {
      this.guide(
        uid,
        chat,
        'invite',
        'Use /invite <invite TTL> [trial duration], for example /invite 10m 1h.',
        updateId,
      );
      return;
    }
    const username = this.options.botUsername?.();
    if (!username)
      throw new DomainError(
        'BOT_USERNAME_UNAVAILABLE',
        'Invite links are temporarily unavailable. Please retry.',
      );
    const created = this.trial.createInvite(ttl, trial);
    this.trial.clearDialog(uid, chat);
    this.store.replyControl(
      chat,
      `https://t.me/${username}?start=${created.token}\nInvite expires at ${new Date(created.expiresAt).toISOString()} (UTC). Trial duration: ${String(Math.floor(created.trialDurationMs / 1000))} seconds.`,
    );
  }
  private dialogInput(
    uid: string,
    chat: string,
    text: string,
    updateId: number,
    d: NonNullable<Dialog>,
    role: 'owner' | 'guest',
  ): void {
    try {
      this.command(uid, chat, d.command, text, updateId, role);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'FORMAT') {
        this.trial.setDialog(uid, chat, d.command);
        this.replyControlLimited(uid, chat, updateId, error.message);
        return;
      }
      throw error;
    }
  }
  private guide(
    uid: string,
    chat: string,
    command:
      | 'new'
      | 'use'
      | 'queue'
      | 'steer'
      | 'cancel'
      | 'allow'
      | 'revoke'
      | 'invite',
    message: string,
    updateId: number,
  ): void {
    this.trial.setDialog(uid, chat, command);
    this.replyControlLimited(uid, chat, updateId, message);
  }
  private commandAllowed(
    name: string | undefined,
    role: 'owner' | 'guest',
  ): boolean {
    return (
      name !== undefined &&
      (role === 'owner' ||
        !['allow', 'revoke', 'guests', 'invite'].includes(name))
    );
  }
  private help(role: 'owner' | 'guest'): string {
    return `Use /queue <text> to create a job.\n/new <name> · /sessions · /use <session_id>\n/queue <text> · /steer <job_id> <text>\n/status [job_id] · /cancel [job_id]\n${role === 'owner' ? '/allow <user_id> [duration] · /revoke <user_id> · /guests · /invite <TTL> [duration]' : ''}`;
  }
  private isPrivateUser(m: TelegramMessage): boolean {
    return (
      m.chat.type === 'private' &&
      m.from !== undefined &&
      Number.isSafeInteger(m.from.id) &&
      m.from.id > 0
    );
  }
  private selectedId(uid: string, chat: string): string | null {
    return this.store.selectedSession(uid, chat)?.id ?? null;
  }
  private notifySkipped(value: string): void {
    try {
      this.options.onSkipped?.(value);
    } catch {
      /* Ignore logger errors. */
    }
  }
  private replyControlLimited(
    uid: string,
    chat: string,
    updateId: number,
    text: string,
    sessionId: string | null = this.selectedId(uid, chat),
  ): void {
    try {
      this.trial.chargeMessage(uid, updateId, 'control');
      this.store.replyControl(chat, text, sessionId);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  private allowPublicAttempt(): boolean {
    const now = this.options.now?.() ?? Date.now();
    if (
      now < this.publicWindowAt ||
      now - this.publicWindowAt >= PUBLIC_WINDOW_MS
    ) {
      this.publicWindowAt = now;
      this.publicAttempts = 0;
      this.publicNotices = 0;
    }
    if (this.publicAttempts >= PUBLIC_ATTEMPT_LIMIT) return false;
    this.publicAttempts++;
    return true;
  }
  private publicHint(uid: string, chat: string): void {
    if (this.publicNotices >= PUBLIC_NOTICE_LIMIT) return;
    this.publicNotices++;
    this.store.replyControl(
      chat,
      `This bot is restricted. Your Telegram numeric ID is ${uid}. Ask the owner for access.`,
    );
  }
}
function clean(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}
function formatJob(
  job: ReturnType<ControllerStore['statusForJob']> & {},
  flow?: FlowStore,
): string {
  const run = flow?.getPinnedFlowRun(job.id) ?? null;
  return `Job ${job.id} — ${job.status}${job.failureCode === null ? '' : `; failure=${job.failureCode}`}\nSession: ${clean(job.sessionName)} (${job.sessionId})\n${run === null ? 'Flow: not started' : `Flow: ${run.flowId}/${run.nodeId}; transitions=${String(run.transitions)}`}\nSteering: pending=${String(job.pendingSteering)}, applied=${String(job.appliedSteering.length)}, not_applied=${String(job.notAppliedSteering)}\nDelivery failures: ${String(job.failedDeliveries)}`;
}
