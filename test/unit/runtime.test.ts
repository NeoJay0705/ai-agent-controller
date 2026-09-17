import { describe, expect, it } from 'vitest';

import { InMemorySessionStore } from '../../src/infrastructure/memory/in-memory-session-store.js';
import { RunCoordinator } from '../../src/modules/sessions/run-coordinator.js';
import type { Clock, IdGenerator } from '../../src/shared/support.js';
import type { IdentityContext } from '../../src/shared/types.js';

const identity: IdentityContext = {
  subjectId: 'user-1',
  tenantId: 'tenant-1',
  roles: [],
  groups: [],
  attributes: {},
};

describe('RunCoordinator', () => {
  it('keeps active-session messages in one Run and applies them by sequence', async () => {
    const { coordinator, store } = createCoordinator();
    const session = await coordinator.createSession(
      identity,
      'support-agent',
      'agent-config-1',
    );

    const first = await coordinator.receiveUserMessage(
      identity,
      session.id,
      '查詢訂單',
      {},
    );
    const second = await coordinator.receiveUserMessage(
      identity,
      session.id,
      '訂單 123',
      {},
    );

    expect(first.createdRun).toBe(true);
    expect(second.createdRun).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.message.sequence).toBeGreaterThan(first.message.sequence);

    const applied = await coordinator.applyNextMessage(first.run.id);
    expect(applied?.id).toBe(first.message.id);

    const events = await store.listEvents(identity, first.run.id);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      runId: first.message.runId,
      sessionId: first.message.sessionId,
      type: 'user_message_applied',
      payload: {
        messageId: first.message.id,
        sequence: first.message.sequence,
      },
    });

    const secondApplied = await coordinator.applyNextMessage(first.run.id);
    expect(secondApplied?.id).toBe(second.message.id);
    const completedEvents = await store.listEvents(identity, first.run.id);
    expect(completedEvents).toHaveLength(4);
  });

  it('does not partially apply a message when event creation fails', async () => {
    let id = 0;
    let failEventCreation = false;
    const ids: IdGenerator = {
      next: () => {
        if (failEventCreation) {
          throw new Error('event id allocation failed');
        }
        return `id-${String(id++)}`;
      },
    };
    const clock: Clock = {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    };
    const store = new InMemorySessionStore({ clock, ids });
    const coordinator = new RunCoordinator({ store });
    const session = await coordinator.createSession(
      identity,
      'support-agent',
      'agent-config-1',
    );
    const received = await coordinator.receiveUserMessage(
      identity,
      session.id,
      '查詢訂單',
      {},
    );

    failEventCreation = true;
    await expect(coordinator.applyNextMessage(received.run.id)).rejects.toThrow(
      'event id allocation failed',
    );
    failEventCreation = false;

    await expect(
      coordinator.applyNextMessage(received.run.id),
    ).resolves.toMatchObject({ id: received.message.id });
    const events = await store.listEvents(identity, received.run.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'user_message_applied',
      payload: { messageId: received.message.id },
    });
    await expect(
      coordinator.applyNextMessage(received.run.id),
    ).resolves.toBeNull();
    await expect(
      store.listEvents(identity, received.run.id),
    ).resolves.toHaveLength(2);
  });
});

function createCoordinator(): {
  coordinator: RunCoordinator;
  store: InMemorySessionStore;
} {
  let id = 0;
  const clock: Clock = {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
  const ids: IdGenerator = {
    next: () => `id-${String(id++)}`,
  };
  const store = new InMemorySessionStore({ clock, ids });
  return { coordinator: new RunCoordinator({ store }), store };
}
