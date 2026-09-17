import { describe, expect, it } from 'vitest';

import { InMemoryAttachmentRepository } from '../../src/infrastructure/memory/in-memory-attachment-repository.js';
import { AttachmentService } from '../../src/modules/attachments/attachment-service.js';
import type { Clock } from '../../src/shared/support.js';
import type { IdentityContext } from '../../src/shared/types.js';

const identity: IdentityContext = {
  subjectId: 'user-1',
  tenantId: 'tenant-1',
  roles: [],
  groups: [],
  attributes: {},
};

describe('AttachmentService', () => {
  it('does not allow an attachment before scan and parsing complete', async () => {
    let id = 0;
    const repository = new InMemoryAttachmentRepository();
    const service = new AttachmentService({
      repository,
      sessionAccess: { canCreateAttachment: () => Promise.resolve(true) },
      blobStore: { delete: () => Promise.resolve() },
      canUseClassification: () => Promise.resolve(true),
      maxBytes: 1024,
      maxAttachmentsPerSession: 2,
      allowedMediaTypes: new Set(['text/plain']),
      clock: fixedClock,
      ids: { next: () => `attachment-${String(id++)}` },
    });

    const attachment = await service.createPending({
      identity,
      sessionId: 'session-1',
      size: 12,
      mediaType: 'text/plain',
      hash: 'hash',
    });
    expect(attachment).toMatchObject({
      status: 'PENDING_SCAN',
      stateVersion: 0,
    });

    await expect(
      service.assertUsable(attachment.id, identity),
    ).rejects.toThrow();
    await service.markScan(identity.tenantId, attachment.id, 'clean');
    await expect(
      repository.get(identity.tenantId, attachment.id),
    ).resolves.toMatchObject({ stateVersion: 1 });
    await service.markAvailable(identity.tenantId, attachment.id, 'INTERNAL');
    await expect(
      service.assertUsable(attachment.id, identity),
    ).resolves.toMatchObject({
      status: 'AVAILABLE',
      stateVersion: 2,
    });
  });

  it('rejects creation when the Session is not accessible', async () => {
    const repository = new InMemoryAttachmentRepository();
    const service = new AttachmentService({
      repository,
      sessionAccess: { canCreateAttachment: () => Promise.resolve(false) },
      blobStore: { delete: () => Promise.resolve() },
      canUseClassification: () => Promise.resolve(true),
      maxBytes: 1024,
      maxAttachmentsPerSession: 2,
      allowedMediaTypes: new Set(['text/plain']),
      clock: fixedClock,
      ids: { next: () => 'attachment-1' },
    });

    await expect(
      service.createPending({
        identity,
        sessionId: 'deleted-session',
        size: 12,
        mediaType: 'text/plain',
        hash: 'hash',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      repository.listBySession(identity.tenantId, 'deleted-session'),
    ).resolves.toHaveLength(0);
  });

  it('does not allow a stale scan transition to overwrite deletion', async () => {
    let id = 0;
    const repository = new InMemoryAttachmentRepository();
    const service = new AttachmentService({
      repository,
      sessionAccess: { canCreateAttachment: () => Promise.resolve(true) },
      blobStore: { delete: () => Promise.resolve() },
      canUseClassification: () => Promise.resolve(true),
      maxBytes: 1024,
      maxAttachmentsPerSession: 2,
      allowedMediaTypes: new Set(['text/plain']),
      clock: fixedClock,
      ids: { next: () => `attachment-${String(id++)}` },
    });
    const attachment = await service.createPending({
      identity,
      sessionId: 'session-1',
      size: 12,
      mediaType: 'text/plain',
      hash: 'hash',
    });
    const stale = await repository.get(identity.tenantId, attachment.id);
    if (stale === null) {
      throw new Error('Expected the attachment to exist');
    }

    await service.delete(identity, attachment.id);
    expect(() =>
      repository.save(
        identity.tenantId,
        {
          ...stale,
          status: 'PROCESSING',
          stateVersion: stale.stateVersion + 1,
        },
        stale.stateVersion,
      ),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
});

const fixedClock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
};
