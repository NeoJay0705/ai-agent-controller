import type { Approval, IdentityContext } from '../../shared/types.js';

export interface ApprovalRepository {
  create(tenantId: string, approval: Approval): Promise<Approval>;
  get(tenantId: string, approvalId: string): Promise<Approval | null>;
  save(
    tenantId: string,
    approval: Approval,
    expectedStateVersion: number,
  ): Promise<Approval>;
}

export interface ApprovalServiceDependencies {
  readonly repository: ApprovalRepository;
  readonly isAuthorizedApprover: (
    identity: IdentityContext,
    approval: Approval,
  ) => Promise<boolean>;
  readonly allowSelfApproval?: boolean;
}
