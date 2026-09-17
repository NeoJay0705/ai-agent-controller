import type { Clock, IdGenerator } from '../../shared/support.js';
import type {
  IdentityContext,
  Message,
  Run,
  RunBudget,
  RunEvent,
  Session,
} from '../../shared/types.js';

export interface CreateSessionInput {
  readonly identity: IdentityContext;
  readonly agentId: string;
  readonly configurationVersion: string;
}

export interface ReceiveUserMessageInput {
  readonly identity: IdentityContext;
  readonly sessionId: string;
  readonly content: string;
  readonly budget: RunBudget;
}

export interface ReceivedMessageResult {
  readonly message: Message;
  readonly run: Run;
  readonly createdRun: boolean;
}

export interface AppliedMessageResult {
  readonly message: Message;
  readonly event: RunEvent;
}

export interface SessionStore {
  createSession(input: CreateSessionInput): Promise<Session>;
  getSession(
    identity: IdentityContext,
    sessionId: string,
  ): Promise<Session | null>;
  getRun(identity: IdentityContext, runId: string): Promise<Run | null>;
  receiveUserMessage(
    input: ReceiveUserMessageInput,
  ): Promise<ReceivedMessageResult>;
  applyNextMessage(runId: string): Promise<AppliedMessageResult | null>;
  appendEvent(event: Omit<RunEvent, 'id' | 'sequence'>): Promise<RunEvent>;
  listEvents(
    identity: IdentityContext,
    runId: string,
    afterSequence?: number,
  ): Promise<readonly RunEvent[]>;
  transitionRun(
    runId: string,
    expectedStateVersion: number,
    nextStatus: Run['status'],
    failureCode?: string,
  ): Promise<Run>;
  requestCancellation(identity: IdentityContext, runId: string): Promise<Run>;
  deleteSession(identity: IdentityContext, sessionId: string): Promise<void>;
}

export interface SessionStoreDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
