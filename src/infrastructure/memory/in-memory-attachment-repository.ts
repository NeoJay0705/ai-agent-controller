import { fail } from '../../shared/errors.js';
import type { Attachment } from '../../shared/types.js';
import type { AttachmentRepository } from '../../modules/attachments/ports.js';

/** Test/local adapter. Production uses the PostgreSQL attachment repository. */
export class InMemoryAttachmentRepository implements AttachmentRepository {
  private readonly attachments = new Map<string, Attachment>();

  create(tenantId: string, attachment: Attachment): Promise<Attachment> {
    if (attachment.tenantId !== tenantId) {
      fail('AUTHORIZATION_DENIED', 'Attachment tenant scope does not match');
    }
    if (this.attachments.has(attachment.id)) {
      fail('CONFLICT', 'Attachment already exists');
    }
    this.attachments.set(attachment.id, attachment);
    return Promise.resolve(attachment);
  }

  get(tenantId: string, attachmentId: string): Promise<Attachment | null> {
    const attachment = this.attachments.get(attachmentId);
    return Promise.resolve(
      attachment !== undefined && attachment.tenantId === tenantId
        ? attachment
        : null,
    );
  }

  save(
    tenantId: string,
    attachment: Attachment,
    expectedStateVersion: number,
  ): Promise<Attachment> {
    const current = this.attachments.get(attachment.id);
    if (current === undefined || current.tenantId !== tenantId) {
      fail('NOT_FOUND', 'Attachment not found');
    }
    if (
      current.stateVersion !== expectedStateVersion ||
      attachment.tenantId !== tenantId ||
      attachment.stateVersion !== expectedStateVersion + 1
    ) {
      fail('CONFLICT', 'Attachment state changed before update');
    }
    this.attachments.set(attachment.id, attachment);
    return Promise.resolve(attachment);
  }

  listBySession(
    tenantId: string,
    sessionId: string,
  ): Promise<readonly Attachment[]> {
    return Promise.resolve(
      [...this.attachments.values()].filter(
        (attachment) =>
          attachment.tenantId === tenantId &&
          attachment.sessionId === sessionId &&
          attachment.status !== 'DELETED',
      ),
    );
  }
}
