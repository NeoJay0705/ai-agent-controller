import { fail } from '../../shared/errors.js';
import type { Clock, IdGenerator } from '../../shared/support.js';
import { isoNow } from '../../shared/support.js';
import type {
  Attachment,
  DataClassification,
  IdentityContext,
} from '../../shared/types.js';
import type { AttachmentServiceDependencies } from './ports.js';

export interface CreateAttachmentInput {
  readonly identity: IdentityContext;
  readonly sessionId: string;
  readonly size: number;
  readonly mediaType: string;
  readonly hash: string;
}

export class AttachmentService {
  private readonly dependencies: AttachmentServiceDependencies;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    dependencies: AttachmentServiceDependencies & {
      readonly clock: Clock;
      readonly ids: IdGenerator;
    },
  ) {
    this.dependencies = dependencies;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
  }

  async createPending(input: CreateAttachmentInput): Promise<Attachment> {
    if (input.size < 0 || input.size > this.dependencies.maxBytes) {
      fail('VALIDATION_ERROR', 'Attachment size is not allowed');
    }
    if (!this.dependencies.allowedMediaTypes.has(input.mediaType)) {
      fail('VALIDATION_ERROR', 'Attachment media type is not allowed');
    }
    if (
      !(await this.dependencies.sessionAccess.canCreateAttachment(
        input.identity,
        input.sessionId,
      ))
    ) {
      fail('NOT_FOUND', 'Session not found');
    }

    const existing = await this.dependencies.repository.listBySession(
      input.identity.tenantId,
      input.sessionId,
    );
    if (existing.length >= this.dependencies.maxAttachmentsPerSession) {
      fail('QUOTA_EXCEEDED', 'Attachment count limit exceeded');
    }

    const now = isoNow(this.clock);
    const id = this.ids.next();
    const attachment: Attachment = {
      id,
      tenantId: input.identity.tenantId,
      ownerSubjectId: input.identity.subjectId,
      sessionId: input.sessionId,
      size: input.size,
      mediaType: input.mediaType,
      hash: input.hash,
      scanStatus: 'pending',
      status: 'PENDING_SCAN',
      stateVersion: 0,
      objectKey: `${input.identity.tenantId}/${input.sessionId}/${id}`,
      createdAt: now,
      updatedAt: now,
    };
    return this.dependencies.repository.create(
      input.identity.tenantId,
      attachment,
    );
  }

  async list(
    identity: IdentityContext,
    sessionId: string,
  ): Promise<readonly Attachment[]> {
    return this.dependencies.repository
      .listBySession(identity.tenantId, sessionId)
      .then((attachments) =>
        attachments.filter(
          (attachment) => attachment.ownerSubjectId === identity.subjectId,
        ),
      );
  }

  async markScan(
    tenantId: string,
    attachmentId: string,
    result: 'clean' | 'rejected' | 'failed',
  ): Promise<Attachment> {
    const attachment = await this.get(tenantId, attachmentId);
    if (attachment.status !== 'PENDING_SCAN') {
      fail('CONFLICT', 'Attachment is not awaiting malware scan');
    }

    const updated: Attachment = {
      ...attachment,
      scanStatus: result,
      status:
        result === 'clean'
          ? 'PROCESSING'
          : result === 'rejected'
            ? 'REJECTED'
            : 'PROCESSING_FAILED',
      updatedAt: isoNow(this.clock),
    };
    return this.dependencies.repository.save(
      tenantId,
      { ...updated, stateVersion: attachment.stateVersion + 1 },
      attachment.stateVersion,
    );
  }

  async markAvailable(
    tenantId: string,
    attachmentId: string,
    dataClassification: DataClassification,
  ): Promise<Attachment> {
    const attachment = await this.get(tenantId, attachmentId);
    if (
      attachment.status !== 'PROCESSING' ||
      attachment.scanStatus !== 'clean'
    ) {
      fail('CONFLICT', 'Attachment is not ready for parsed content');
    }

    return this.dependencies.repository.save(
      tenantId,
      {
        ...attachment,
        status: 'AVAILABLE',
        dataClassification,
        stateVersion: attachment.stateVersion + 1,
        updatedAt: isoNow(this.clock),
      },
      attachment.stateVersion,
    );
  }

  async assertUsable(
    attachmentId: string,
    identity: IdentityContext,
  ): Promise<Attachment> {
    const attachment = await this.get(identity.tenantId, attachmentId);
    if (
      attachment.tenantId !== identity.tenantId ||
      attachment.ownerSubjectId !== identity.subjectId
    ) {
      fail('NOT_FOUND', 'Attachment not found');
    }
    if (attachment.status !== 'AVAILABLE') {
      fail('AUTHORIZATION_DENIED', 'Attachment is not available');
    }
    if (!(await this.dependencies.canUseClassification(identity, attachment))) {
      fail('AUTHORIZATION_DENIED', 'Attachment classification is not allowed');
    }
    return attachment;
  }

  async delete(identity: IdentityContext, attachmentId: string): Promise<void> {
    const attachment = await this.get(identity.tenantId, attachmentId);
    if (
      attachment.tenantId !== identity.tenantId ||
      attachment.ownerSubjectId !== identity.subjectId
    ) {
      fail('NOT_FOUND', 'Attachment not found');
    }
    if (attachment.status === 'DELETED') {
      return;
    }

    const deleting = await this.dependencies.repository.save(
      identity.tenantId,
      {
        ...attachment,
        status: 'DELETING',
        stateVersion: attachment.stateVersion + 1,
        updatedAt: isoNow(this.clock),
      },
      attachment.stateVersion,
    );
    await this.dependencies.blobStore.delete(deleting.objectKey);
    await this.dependencies.repository.save(
      identity.tenantId,
      {
        ...deleting,
        status: 'DELETED',
        stateVersion: deleting.stateVersion + 1,
        updatedAt: isoNow(this.clock),
      },
      deleting.stateVersion,
    );
  }

  private async get(
    tenantId: string,
    attachmentId: string,
  ): Promise<Attachment> {
    const attachment = await this.dependencies.repository.get(
      tenantId,
      attachmentId,
    );
    if (attachment === null) {
      fail('NOT_FOUND', 'Attachment not found');
    }
    return attachment;
  }
}
