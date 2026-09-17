import type { Attachment, IdentityContext } from '../../shared/types.js';

export interface AttachmentRepository {
  create(tenantId: string, attachment: Attachment): Promise<Attachment>;
  get(tenantId: string, attachmentId: string): Promise<Attachment | null>;
  save(
    tenantId: string,
    attachment: Attachment,
    expectedStateVersion: number,
  ): Promise<Attachment>;
  listBySession(
    tenantId: string,
    sessionId: string,
  ): Promise<readonly Attachment[]>;
}

export interface AttachmentSessionAccess {
  canCreateAttachment(
    identity: IdentityContext,
    sessionId: string,
  ): Promise<boolean>;
}

export interface AttachmentBlobStore {
  delete(objectKey: string): Promise<void>;
}

export interface AttachmentServiceDependencies {
  readonly repository: AttachmentRepository;
  readonly sessionAccess: AttachmentSessionAccess;
  readonly blobStore: AttachmentBlobStore;
  readonly canUseClassification: (
    identity: IdentityContext,
    attachment: Attachment,
  ) => Promise<boolean>;
  readonly maxBytes: number;
  readonly maxAttachmentsPerSession: number;
  readonly allowedMediaTypes: ReadonlySet<string>;
}
