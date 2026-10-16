import type { DatabaseSync } from 'node:sqlite';
import type { TrialPolicy } from './trial-policy.js';

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type SteeringStatus = 'pending' | 'applied' | 'not_applied';
export type OutboxStatus = 'PENDING' | 'DELIVERED' | 'FAILED';
export type OutboxKind = 'reply' | 'ack' | 'prompt' | 'completed' | 'failed';

interface ControllerConfigCommon {
  readonly dataDir: string;
  readonly concurrency: number;
  readonly stepMs: number;
  readonly timeoutMs: number;
  readonly maxPendingJobs: number;
  readonly maxPendingSteering: number;
  readonly host: string;
  readonly port: number;
}

export type ControllerConfig = ControllerConfigCommon &
  (
    | {
        readonly mode: 'health';
        readonly token?: never;
        readonly allowedUserId?: never;
        readonly piAuthFile?: never;
      }
    | {
        readonly mode: 'bot';
        readonly token: string;
        readonly allowedUserId: string;
        readonly flowConfigPath: string;
        readonly piAuthFile?: string;
        readonly trial?: TrialPolicy;
      }
  );

export interface TelegramUser {
  readonly id: number;
  readonly [key: string]: unknown;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date?: unknown;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly reply_to_message?: { readonly message_id: number };
  readonly [key: string]: unknown;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly [key: string]: unknown;
}

export interface SessionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly nextSequence: number;
}

export interface JobRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly ownerId: string;
  readonly sequence: number;
  readonly input: string;
  readonly status: JobStatus;
  readonly checkpoint: number;
  readonly startedAt: number | null;
  readonly deadlineAt: number | null;
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly appliedSteering: readonly string[];
  readonly pendingSteering: number;
  readonly notAppliedSteering: number;
  readonly failedDeliveries: number;
}

export interface OutboxRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly jobId: string | null;
  readonly kind: OutboxKind;
  readonly text: string;
  readonly attempts: number;
  readonly chatId: string;
  readonly promptGeneration: number | null;
  readonly deliveryClass: 'business' | 'control';
}

export interface PromptRecord {
  readonly jobId: string;
  readonly ownerId: string;
  readonly active: boolean;
  readonly generation: number;
}

export interface TelegramSentMessage {
  readonly messageId: number;
  readonly chatId: number;
}

export interface ServiceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface StoreOptions {
  readonly database: DatabaseSync;
  readonly now?: () => number;
}

export interface TelegramEnvelope<T> {
  readonly ok: true;
  readonly result: T;
}
