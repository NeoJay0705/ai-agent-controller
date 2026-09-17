import { fail } from '../../shared/errors.js';
import type { Clock, IdGenerator } from '../../shared/support.js';
import { isoNow } from '../../shared/support.js';
import type {
  IdentityContext,
  Message,
  Run,
  RunEvent,
  Session,
} from '../../shared/types.js';
import {
  isActiveRunStatus,
  requestRunCancellation,
  transitionRun,
} from '../../modules/runtime/state-machine.js';
import type {
  CreateSessionInput,
  AppliedMessageResult,
  ReceiveUserMessageInput,
  ReceivedMessageResult,
  SessionStore,
  SessionStoreDependencies,
} from '../../modules/sessions/ports.js';

/**
 * Test/local adapter only. Production wiring must replace this adapter with
 * the PostgreSQL repository described in the architecture design.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly runs = new Map<string, Run>();
  private readonly messages = new Map<string, Message>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly eventSequences = new Map<string, number>();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(dependencies: SessionStoreDependencies) {
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
  }

  createSession(input: CreateSessionInput): Promise<Session> {
    const now = isoNow(this.clock);
    const session: Session = {
      id: this.ids.next(),
      tenantId: input.identity.tenantId,
      ownerSubjectId: input.identity.subjectId,
      agentId: input.agentId,
      configurationVersion: input.configurationVersion,
      status: 'ACTIVE',
      nextMessageSequence: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }

  getSession(
    identity: IdentityContext,
    sessionId: string,
  ): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !ownsSession(session, identity)) {
      return Promise.resolve(null);
    }

    return Promise.resolve(session.status === 'DELETED' ? null : session);
  }

  getRun(identity: IdentityContext, runId: string): Promise<Run | null> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return Promise.resolve(null);
    }

    const session = this.sessions.get(run.sessionId);
    if (session === undefined || !ownsSession(session, identity)) {
      return Promise.resolve(null);
    }

    return Promise.resolve(session.status === 'DELETED' ? null : run);
  }

  async receiveUserMessage(
    input: ReceiveUserMessageInput,
  ): Promise<ReceivedMessageResult> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined || !ownsSession(session, input.identity)) {
      fail('NOT_FOUND', 'Session not found');
    }
    if (session.status !== 'ACTIVE') {
      fail('CONFLICT', 'Session is not accepting messages');
    }

    const activeRun = this.findActiveRun(session.id);
    const now = isoNow(this.clock);
    let run: Run;
    let createdRun = false;

    if (activeRun === undefined) {
      run = {
        id: this.ids.next(),
        tenantId: session.tenantId,
        sessionId: session.id,
        status: 'CREATED',
        stateVersion: 0,
        configurationVersion: session.configurationVersion,
        budget: input.budget,
        createdAt: now,
        updatedAt: now,
      };
      this.runs.set(run.id, run);
      createdRun = true;
    } else {
      run = activeRun;
      if (run.status === 'WAITING_USER_INPUT') {
        run = transitionRun(run, 'RUNNING', this.clock);
        this.runs.set(run.id, run);
      }
    }

    const message: Message = {
      id: this.ids.next(),
      tenantId: session.tenantId,
      sessionId: session.id,
      runId: run.id,
      sequence: session.nextMessageSequence,
      role: 'user',
      content: input.content,
      receivedAt: now,
    };

    this.messages.set(message.id, message);
    this.sessions.set(session.id, {
      ...session,
      nextMessageSequence: session.nextMessageSequence + 1,
      updatedAt: now,
    });

    await this.appendEvent({
      runId: run.id,
      sessionId: session.id,
      type: 'user_message_received',
      payload: {
        messageId: message.id,
        sequence: message.sequence,
      },
      occurredAt: now,
    });

    return { message, run, createdRun };
  }

  applyNextMessage(runId: string): Promise<AppliedMessageResult | null> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      fail('NOT_FOUND', 'Run not found');
    }

    const pending = [...this.messages.values()]
      .filter(
        (message) => message.runId === runId && message.appliedAt === undefined,
      )
      .sort((left, right) => left.sequence - right.sequence)[0];

    if (pending === undefined) {
      return Promise.resolve(null);
    }

    const appliedAt = isoNow(this.clock);
    const applied: Message = {
      ...pending,
      appliedAt,
    };
    const sequence = (this.eventSequences.get(runId) ?? 0) + 1;
    const event: RunEvent = {
      runId: applied.runId,
      sessionId: applied.sessionId,
      type: 'user_message_applied',
      payload: {
        messageId: applied.id,
        sequence: applied.sequence,
      },
      occurredAt: appliedAt,
      id: this.ids.next(),
      sequence,
    };
    const runEvents = [...(this.events.get(runId) ?? []), event];

    this.messages.set(applied.id, applied);
    this.events.set(runId, runEvents);
    this.eventSequences.set(runId, sequence);
    return Promise.resolve({ message: applied, event });
  }

  appendEvent(event: Omit<RunEvent, 'id' | 'sequence'>): Promise<RunEvent> {
    if (!this.runs.has(event.runId)) {
      fail('NOT_FOUND', 'Run not found');
    }

    return Promise.resolve(this.createEvent(event));
  }

  private createEvent(event: Omit<RunEvent, 'id' | 'sequence'>): RunEvent {
    if (!this.runs.has(event.runId)) {
      fail('NOT_FOUND', 'Run not found');
    }

    const sequence = (this.eventSequences.get(event.runId) ?? 0) + 1;
    const persisted: RunEvent = {
      ...event,
      id: this.ids.next(),
      sequence,
    };
    const runEvents = this.events.get(event.runId) ?? [];
    runEvents.push(persisted);
    this.events.set(event.runId, runEvents);
    this.eventSequences.set(event.runId, sequence);
    return persisted;
  }

  async listEvents(
    identity: IdentityContext,
    runId: string,
    afterSequence = 0,
  ): Promise<readonly RunEvent[]> {
    const run = await this.getRun(identity, runId);
    if (run === null) {
      return [];
    }

    return (this.events.get(run.id) ?? []).filter(
      (event) => event.sequence > afterSequence,
    );
  }

  transitionRun(
    runId: string,
    expectedStateVersion: number,
    nextStatus: Run['status'],
    failureCode?: string,
  ): Promise<Run> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      fail('NOT_FOUND', 'Run not found');
    }
    if (run.stateVersion !== expectedStateVersion) {
      fail('CONFLICT', 'Run state changed before transition');
    }

    const updated = transitionRun(run, nextStatus, this.clock, failureCode);
    this.runs.set(run.id, updated);
    return Promise.resolve(updated);
  }

  async requestCancellation(
    identity: IdentityContext,
    runId: string,
  ): Promise<Run> {
    const run = await this.getRun(identity, runId);
    if (run === null) {
      fail('NOT_FOUND', 'Run not found');
    }

    const updated = requestRunCancellation(run, this.clock);
    this.runs.set(run.id, updated);
    return updated;
  }

  deleteSession(identity: IdentityContext, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !ownsSession(session, identity)) {
      fail('NOT_FOUND', 'Session not found');
    }
    if (session.status === 'DELETED') {
      return Promise.resolve();
    }

    const now = isoNow(this.clock);
    this.sessions.set(session.id, {
      ...session,
      status: 'DELETED',
      updatedAt: now,
    });

    const activeRun = this.findActiveRun(session.id);
    if (activeRun !== undefined) {
      this.runs.set(
        activeRun.id,
        requestRunCancellation(activeRun, this.clock),
      );
    }
    return Promise.resolve();
  }

  private findActiveRun(sessionId: string): Run | undefined {
    return [...this.runs.values()].find(
      (run) => run.sessionId === sessionId && isActiveRunStatus(run.status),
    );
  }
}

function ownsSession(session: Session, identity: IdentityContext): boolean {
  return (
    session.tenantId === identity.tenantId &&
    session.ownerSubjectId === identity.subjectId
  );
}
