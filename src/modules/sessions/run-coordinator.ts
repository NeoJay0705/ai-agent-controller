import { fail } from '../../shared/errors.js';
import type { IdentityContext, RunBudget } from '../../shared/types.js';
import type {
  CreateSessionInput,
  ReceiveUserMessageInput,
  ReceivedMessageResult,
  SessionStore,
} from './ports.js';

export interface RunCoordinatorDependencies {
  readonly store: SessionStore;
}

export class RunCoordinator {
  private readonly store: SessionStore;

  constructor(dependencies: RunCoordinatorDependencies) {
    this.store = dependencies.store;
  }

  createSession(
    identity: IdentityContext,
    agentId: string,
    configurationVersion: string,
  ) {
    const input: CreateSessionInput = {
      identity,
      agentId,
      configurationVersion,
    };
    return this.store.createSession(input);
  }

  receiveUserMessage(
    identity: IdentityContext,
    sessionId: string,
    content: string,
    budget: RunBudget,
  ): Promise<ReceivedMessageResult> {
    if (content.trim().length === 0) {
      fail('VALIDATION_ERROR', 'Message content must not be empty');
    }

    const input: ReceiveUserMessageInput = {
      identity,
      sessionId,
      content,
      budget,
    };
    return this.store.receiveUserMessage(input);
  }

  async applyNextMessage(runId: string) {
    const result = await this.store.applyNextMessage(runId);
    if (result === null) {
      return null;
    }

    return result.message;
  }

  requestCancellation(identity: IdentityContext, runId: string) {
    return this.store.requestCancellation(identity, runId);
  }

  deleteSession(identity: IdentityContext, sessionId: string) {
    return this.store.deleteSession(identity, sessionId);
  }
}
