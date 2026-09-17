import { DomainError, fail } from '../../shared/errors.js';
import type { Clock, IdGenerator } from '../../shared/support.js';
import { isoNow, sha256, stableJson } from '../../shared/support.js';
import type {
  Approval,
  ApprovalSnapshot,
  IdentityContext,
  JsonObject,
} from '../../shared/types.js';
import type { ApprovalServiceDependencies } from './ports.js';

export interface CreateApprovalInput {
  readonly requesterSubjectId: string;
  readonly snapshot: ApprovalSnapshot;
  readonly approverConstraint: string;
  readonly expiresAt: string;
}

export class ApprovalService {
  private readonly repository: ApprovalServiceDependencies['repository'];
  private readonly isAuthorizedApprover: ApprovalServiceDependencies['isAuthorizedApprover'];
  private readonly allowSelfApproval: boolean;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    dependencies: ApprovalServiceDependencies & {
      readonly clock: Clock;
      readonly ids: IdGenerator;
    },
  ) {
    this.repository = dependencies.repository;
    this.isAuthorizedApprover = dependencies.isAuthorizedApprover;
    this.allowSelfApproval = dependencies.allowSelfApproval ?? false;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
  }

  async create(input: CreateApprovalInput): Promise<Approval> {
    const createdAt = isoNow(this.clock);
    const approval: Approval = {
      id: this.ids.next(),
      requesterSubjectId: input.requesterSubjectId,
      tenantId: input.snapshot.tenantId,
      runId: input.snapshot.runId,
      toolCallId: input.snapshot.toolCallId,
      toolName: input.snapshot.toolName,
      toolVersion: input.snapshot.toolVersion,
      ...(input.snapshot.resource === undefined
        ? {}
        : { resource: input.snapshot.resource }),
      effectiveInput: input.snapshot.effectiveInput,
      policyVersion: input.snapshot.policyVersion,
      snapshotHash: snapshotHash(input.snapshot),
      approverConstraint: input.approverConstraint,
      status: 'PENDING',
      stateVersion: 0,
      createdAt,
      expiresAt: input.expiresAt,
    };

    return this.repository.create(input.snapshot.tenantId, approval);
  }

  async get(actor: IdentityContext, approvalId: string): Promise<Approval> {
    const approval = await this.getForTenant(actor.tenantId, approvalId);
    if (approval === null) {
      fail('NOT_FOUND', 'Approval not found');
    }
    if (
      approval.requesterSubjectId !== actor.subjectId &&
      !(await this.isAuthorizedApprover(actor, approval))
    ) {
      fail('AUTHORIZATION_DENIED', 'Approval is not accessible');
    }

    return approval;
  }

  async decide(
    approvalId: string,
    actor: IdentityContext,
    decision: 'approve' | 'reject',
  ): Promise<Approval> {
    const approval = await this.getForTenant(actor.tenantId, approvalId);
    if (approval === null) {
      fail('NOT_FOUND', 'Approval not found');
    }
    await this.assertCanDecide(actor, approval, decision);
    const now = this.clock.now();

    if (approval.status === 'APPROVED' && decision === 'approve') {
      return approval;
    }
    if (approval.status === 'REJECTED' && decision === 'reject') {
      return approval;
    }
    if (approval.status !== 'PENDING') {
      fail('CONFLICT', 'Approval is no longer pending');
    }
    if (Date.parse(approval.expiresAt) <= now.getTime()) {
      await this.repository.save(
        actor.tenantId,
        {
          ...approval,
          status: 'EXPIRED',
          stateVersion: approval.stateVersion + 1,
          decidedAt: now.toISOString(),
        },
        approval.stateVersion,
      );
      fail('CONFLICT', 'Approval has expired');
    }

    const updated: Approval = {
      ...approval,
      status: decision === 'approve' ? 'APPROVED' : 'REJECTED',
      stateVersion: approval.stateVersion + 1,
      ...(decision === 'approve'
        ? { approvedBySubjectId: actor.subjectId }
        : {}),
      decidedAt: now.toISOString(),
    };
    try {
      return await this.repository.save(
        actor.tenantId,
        updated,
        approval.stateVersion,
      );
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'CONFLICT') {
        throw error;
      }

      const current = await this.getForTenant(actor.tenantId, approvalId);
      if (current === null) {
        fail('NOT_FOUND', 'Approval not found');
      }
      await this.assertCanDecide(actor, current, decision);
      if (
        (current.status === 'APPROVED' && decision === 'approve') ||
        (current.status === 'REJECTED' && decision === 'reject')
      ) {
        return current;
      }
      fail('CONFLICT', 'Approval decision conflicted with another update');
    }
  }

  async assertExecutable(
    approvalId: string,
    snapshot: ApprovalSnapshot,
  ): Promise<Approval> {
    const approval = await this.getForTenant(snapshot.tenantId, approvalId);
    if (approval === null) {
      fail('NOT_FOUND', 'Approval not found');
    }
    if (approval.status !== 'APPROVED') {
      fail('AUTHORIZATION_DENIED', 'Tool execution is not approved');
    }
    if (Date.parse(approval.expiresAt) <= this.clock.now().getTime()) {
      fail('AUTHORIZATION_DENIED', 'Approval has expired');
    }
    if (approval.snapshotHash !== snapshotHash(snapshot)) {
      fail('AUTHORIZATION_DENIED', 'Approval snapshot is no longer valid');
    }

    return approval;
  }

  private async getForTenant(
    tenantId: string,
    approvalId: string,
  ): Promise<Approval | null> {
    return this.repository.get(tenantId, approvalId);
  }

  private async assertCanDecide(
    actor: IdentityContext,
    approval: Approval,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    if (actor.tenantId !== approval.tenantId) {
      fail('AUTHORIZATION_DENIED', 'Approver is not authorized');
    }
    if (
      decision === 'approve' &&
      !this.allowSelfApproval &&
      actor.subjectId === approval.requesterSubjectId
    ) {
      fail('AUTHORIZATION_DENIED', 'Self-approval is not allowed');
    }
    if (!(await this.isAuthorizedApprover(actor, approval))) {
      fail('AUTHORIZATION_DENIED', 'Approver is not authorized');
    }
  }
}

function snapshotHash(snapshot: ApprovalSnapshot): string {
  const canonical: JsonObject = {
    tenantId: snapshot.tenantId,
    runId: snapshot.runId,
    toolCallId: snapshot.toolCallId,
    toolName: snapshot.toolName,
    toolVersion: snapshot.toolVersion,
    ...(snapshot.resource === undefined ? {} : { resource: snapshot.resource }),
    effectiveInput: snapshot.effectiveInput,
    policyVersion: snapshot.policyVersion,
  };
  return sha256(stableJson(canonical));
}
